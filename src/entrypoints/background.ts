import { browser } from 'wxt/browser';
import type { Config } from '../core/types';
import { AnchorService } from '../engine/anchors';
import { createAskController } from '../engine/ask';
import { RecentlyClosed } from '../core/safety/recently-closed';
import { WhyLog } from '../core/safety/why-log';
import {
  configRev, createContentHandler, createDebounce, createHandler, createOnMessage, isBannerChoiceMessage, isUndoChoiceMessage, refreshBadge,
  UNDO_NOTIFICATION_PREFIX,
} from '../engine/messages';
import { listPendingAsks } from '../engine/ask';
import { afterConfigChange, CLOSE_ALARM_PREFIX, CLOSE_SUGGESTIONS_KEY, CloseExecutor } from '../engine/close-executor';
import { DedupeHandler } from '../engine/dedupe-handler';
import { PageFacts } from '../engine/page-facts';
import { createWatchScripting, WATCH_FILE, WATCH_SCRIPT_ID } from '../engine/watch-registration';
import { PermissionsManager } from '../engine/permissions';
import { builtinRecipes } from '../recipes/load';
import { ProgramCache } from '../engine/program-cache';
import { Reconciler } from '../engine/reconciler';
import { SafetyService } from '../engine/safety';
import { ChromePort } from '../platform/chrome-port';
import { ConfigStore } from '../storage/config-store';
import { installMenus, onMenuClick, refreshMenus, type MenuApi, type MenuTab } from '../engine/context-menu';

export default defineBackground(() => {
  const store = new ConfigStore();
  // One compiled Program for every engine consumer (ruling R4); recompiled when the config revision or the
  // PermissionsManager's paused set (recipes / rules waiting for a permission) changes.
  const programs = new ProgramCache(() => store.get(), { paused: () => permissions.paused() });
  const getProgram = () => programs.get();
  const updateConfig = async (fn: (c: Config) => Config) => {
    await store.update(fn);
  };
  const port = new ChromePort();
  const whyLog = new WhyLog();
  const recentlyClosed = new RecentlyClosed();
  const warn = (what: string) => (e: unknown) => console.warn(`[tabchef] ${what} failed`, e);
  // The one owner of the watch registration (R5, constraint 8): chrome.scripting is undefined until `scripting` is
  // granted, so the API is looked up per call and every call is a no-op without it.
  const permissions: PermissionsManager = new PermissionsManager(port, getProgram, createWatchScripting(() => {
    const s = browser.scripting;
    if (!s?.registerContentScripts) return undefined;
    return {
      getRegistered: () => s.getRegisteredContentScripts({ ids: [WATCH_SCRIPT_ID] }),
      register: (x) => s.registerContentScripts(x),
      update: (x) => s.updateContentScripts(x),
      unregister: (ids) => s.unregisterContentScripts({ ids }),
      inject: async (tabId) => { await s.executeScript({ target: { tabId }, files: [WATCH_FILE as never] }); },
    };
  }), {
    onPausedChanged: () => {
      reconciler.schedule('permissions');
      void closeExecutor.rearm(); // closes kept pending while their recipe waited for a permission
      void closeExecutor.evaluateAll(); // the Program changed (R51): a resumed close rule applies to open tabs
    },
  });
  // Page facts from the watch content script (M2 T7), mirrored to storage.session.
  const pageFacts = new PageFacts({
    session: {
      get: async (k) => (await browser.storage.session.get(k))[k],
      set: (k, v) => browser.storage.session.set({ [k]: v }),
    },
    onHoldExpired: () => reconciler.schedule('pageFacts-hold'),
    // Hold only where the watch is registered: elsewhere no facts will come.
    covers: (url) => permissions.covers(url),
  });
  // `safety` is used lazily by the closures below (it needs the reconciler and dedupe handler, which need it).
  const reconciler: Reconciler = new Reconciler(port, getProgram, {
    log: whyLog,
    isPaused: () => safety.isPaused(),
    beforeRun: async () => { await Promise.all([safety.ready, pageFacts.ready, permissions.ready]); },
    extraLeaveAlone: () => safety.lockedTabIds(),
    pageFacts,
    anchors: { onGroupCreated: (...a) => anchors.onGroupCreated(...a) },
  });
  // Anchor tabs (M2 T11): opened when Tabchef creates a group; their state is the reconciler's RuntimeState.
  const anchors: AnchorService = new AnchorService(port, {
    state: () => reconciler.liveState(),
    armExemption: (url, windowId) => dedupe.armExemption(url, windowId),
    log: whyLog,
  });
  const schedule = (reason: string) => () => reconciler.schedule(reason);
  store.onChange((c) => {
    reconciler.schedule('config');
    // Enabled recipes changed: their needs, the paused set and the watch origins. Then every open tab is re-evaluated
    // for close rules against the new Program (R51), so a newly enabled close rule applies to tabs already open.
    // Then the badge, which counts the shown views (R60): they depend on the config. scheduleBadge is declared below.
    void afterConfigChange(() => permissions.onChanged(), closeExecutor, () => scheduleBadge()).catch(warn('close re-evaluation'));
    // Tell open extension pages (options) the config changed; "no receiver" rejections are expected.
    Promise.resolve(browser.runtime.sendMessage({ type: 'config.changed', rev: configRev(c) })).catch(() => {});
  });
  // Persist a pending (debounced) config write before the worker is torn down.
  browser.runtime.onSuspend.addListener(() => { store.flush().catch(warn('config flush')); });

  const askController = createAskController(port, {
    // scripting / notifications are optional permissions: the namespaces are undefined until granted (the port checks first).
    api: {
      executeScript: async (tabId, file) => {
        await browser.scripting.executeScript({ target: { tabId }, files: [file as never] });
      },
      sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
      waitForComplete: (tabId, timeoutMs) => new Promise<boolean>((resolve) => {
        const onUpdated = (id: number, info: { status?: string }) => {
          if (id === tabId && info.status === 'complete') done(true);
        };
        function done(ok: boolean) {
          clearTimeout(timer);
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve(ok);
        }
        const timer = setTimeout(() => done(false), timeoutMs);
        browser.tabs.onUpdated.addListener(onUpdated);
        browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') done(true); }, () => done(false));
      }),
      clearNotification: async (id) => { await browser.notifications.clear(id); },
      listNotificationIds: async () => (browser.notifications ? Object.keys(await browser.notifications.getAll()) : []),
      createNotification: async (id, o) => {
        await browser.notifications.create(id, {
          type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), requireInteraction: true, ...o,
        });
      },
      session: {
        get: async (k) => (await browser.storage.session.get(k))[k],
        set: (k, v) => browser.storage.session.set({ [k]: v }),
      },
    },
    bannerFile: 'content-scripts/banner.js',
    getProgram,
    updateConfig,
    recentlyClosed,
    log: whyLog,
    // scheduleBadge is defined below; this only runs after startup.
    scheduleBadge: () => scheduleBadge(),
    isLocked: (id) => safety.isLocked(id),
    onClosed: (id, entry, focused) => { safety.toast(id, entry, focused).catch(warn('undo toast')); },
  });
  const dedupe: DedupeHandler = new DedupeHandler(port, getProgram, {
    recentlyClosed,
    log: whyLog,
    ask: askController.ask,
    isPaused: () => safety.isPaused(),
    isLocked: (id) => safety.isLocked(id),
    isAnchor: (id) => anchors.isAnchor(id),
    // M3: the paused set (rule keys waiting for a permission) is loaded too before any dedupe decision.
    beforeDecide: async () => { await Promise.all([safety.ready, anchors.ready, permissions.ready]); },
    onClosed: (id, entry, focused) => { safety.toast(id, entry, focused).catch(warn('undo toast')); },
    // Cleared on browser restart: a missing marker at worker start opens the startup grace (order-independent).
    session: {
      get: async (k) => (await browser.storage.session.get(k))[k],
      set: (k, v) => browser.storage.session.set({ [k]: v }),
    },
  });
  const safety: SafetyService = new SafetyService(port, {
    recentlyClosed,
    log: whyLog,
    schedule: (r) => reconciler.schedule(r),
    exemptOnce: (id) => dedupe.exemptOnce(id),
    armExemption: (url, windowId) => dedupe.armExemption(url, windowId),
    api: {
      executeScript: async (tabId, file) => {
        await browser.scripting.executeScript({ target: { tabId }, files: [file as never] });
      },
      sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
      createNotification: async (id, o) => {
        await browser.notifications.create(id, {
          type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), ...o,
        });
      },
    },
    bannerFile: 'content-scripts/banner.js',
    pageFormEdited: (id) => pageFacts.get(id)?.formEdited === true,
    onResume: () => { void closeExecutor.rearm(); },
    onUndone: (id, url) => { void closeExecutor.exempt(id, url); },
  });
  // Delayed / suggested closes (M2 T9), persisted in storage.session.
  const closeExecutor: CloseExecutor = new CloseExecutor(port, getProgram, {
    safety,
    recentlyClosed,
    log: whyLog,
    facts: pageFacts,
    banner: async (tabId) => {
      const t = (await port.snapshot()).tabs.find((x) => x.id === tabId);
      return t ? safety.protectedCloseBanner(t) : false;
    },
    alarms: {
      create: (name, when) => browser.alarms.create(name, { when }),
      clear: (name) => browser.alarms.clear(name),
    },
    session: {
      get: async (k) => (await browser.storage.session.get(k))[k],
      set: (k, v) => browser.storage.session.set({ [k]: v }),
    },
    isRulePaused: (key) => permissions.paused().has(key),
    // I1: evidence-based (the executor also requires page facts for the tab); covers() is only for the page-facts hold.
    observesForm: (url) => permissions.coversKnown(url),
    beforeRun: async () => { await Promise.all([safety.ready, pageFacts.ready, permissions.ready, anchors.ready]); },
    isAnchor: (id) => anchors.isAnchor(id),
  });
  // A restarted worker re-arms its stored pending closes (timers die with the worker; overdue ones fire now).
  void closeExecutor.rearm();
  const candidate = (...a: Parameters<DedupeHandler['onCandidate']>) => {
    dedupe.onCandidate(...a).catch((e: unknown) => console.warn('[tabchef] dedupe failed', e));
  };
  // Tabs already on a new-tab page when this worker starts are still "fresh" (rule: never committed a real URL).
  port.snapshot().then((s) => dedupe.seed(s.tabs), (e: unknown) => console.warn('[tabchef] dedupe seed failed', e));

  // Context menu (M2 T16): items are created on onInstalled; title / enabled follow the active tab and its lock.
  const menuApi: MenuApi = {
    removeAll: () => browser.contextMenus.removeAll(),
    create: (p) => { browser.contextMenus.create(p, () => void browser.runtime.lastError); },
    update: async (id, p) => { await browser.contextMenus.update(id, p); },
  };
  const refreshMenu = (tab: MenuTab | undefined) => {
    safety.ready.then(() => refreshMenus(menuApi, tab, (id) => safety.isLocked(id))).catch(warn('menu refresh'));
  };
  const refreshActiveMenu = () => {
    browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => refreshMenu(t), warn('menu refresh'));
  };
  const openOptions = async (hash: string) => { await browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}${hash}` }); };

  // MV3: every listener is registered synchronously at the top level so a restarted worker receives the event.
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) {
      safety.onTabSeen({ id: tab.id, url: tab.url ?? tab.pendingUrl ?? '', windowId: tab.windowId });
      dedupe.recordCreated(tab.id, { discarded: tab.discarded, status: tab.status });
      const url = tab.pendingUrl || tab.url;
      if (url) candidate(tab.id, url, 'pending');
    }
    reconciler.schedule('tab-created');
  });
  // onUpdated(url) arrives ~4 ms before onCommitted and both carry the final post-redirect URL: act on whichever is first.
  browser.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    pageFacts.onCommitted(d.tabId, d.url, d.documentId);
    candidate(d.tabId, d.url, 'committed');
    void closeExecutor.onCommitted(d.tabId);
    void closeExecutor.evaluate(d.tabId);
  });
  browser.tabs.onActivated.addListener((info) => {
    void closeExecutor.onActivated(info.tabId);
    browser.tabs.get(info.tabId).then(refreshMenu, warn('menu refresh'));
  });
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    const dedupeUrl = info.url ?? (info.status === 'loading' ? tab.pendingUrl : undefined);
    if (dedupeUrl) candidate(tabId, dedupeUrl, 'pending');
    // Title-aware dedupe (R18): a candidate awaiting its title re-enters here, outside the serialized chain.
    const titleUrl = tab.pendingUrl || tab.url;
    if (info.title !== undefined && titleUrl) {
      dedupe.onTitleChanged(tabId, titleUrl).catch((e: unknown) => console.warn('[tabchef] dedupe failed', e));
    }
    if (info.url !== undefined) {
      safety.onTabSeen({ id: tabId, url: info.url, windowId: tab.windowId });
      void reconciler.onTabUrlChanged(tabId, info.url);
      void closeExecutor.evaluate(tabId); // also same-document navigations, which fire no onCommitted
      if (tab.active) refreshActiveMenu(); // e.g. a new tab (chrome://newtab) navigating to a site
    }
    if (info.groupId !== undefined) void reconciler.onTabGroupChanged(tabId, info.groupId, tab.url);
    if (info.url !== undefined || info.groupId !== undefined || info.pinned !== undefined) {
      reconciler.schedule('tab-updated');
    }
  });
  const movedOrAttached = (reason: string) => () => {
    reconciler.onTabMovedOrAttached();
    reconciler.schedule(reason);
  };
  browser.tabs.onMoved.addListener(movedOrAttached('tab-moved'));
  browser.tabs.onAttached.addListener(movedOrAttached('tab-attached'));
  browser.tabs.onRemoved.addListener((tabId, info) => {
    safety.onTabRemoved(tabId, info.isWindowClosing);
    pageFacts.clear(tabId);
    void closeExecutor.onTabRemoved(tabId);
    dedupe.onRemoved(tabId);
    anchors.onTabRemoved(tabId, info.isWindowClosing).catch(warn('anchor cleanup'));
    askController.onTabRemoved(tabId).catch((e: unknown) => console.warn('[tabchef] pending ask cleanup failed', e));
    reconciler.schedule('tab-removed');
  });
  browser.tabs.onReplaced.addListener((added, removed) => {
    pageFacts.clear(removed);
    void closeExecutor.onTabRemoved(removed);
    dedupe.onReplaced(added, removed);
    anchors.onTabReplaced(added, removed).catch(warn('anchor replace'));
  });
  browser.tabGroups.onUpdated.addListener(schedule('group-updated'));
  browser.tabGroups.onRemoved.addListener((g) => {
    anchors.onGroupRemoved(g).catch(warn('anchor group cleanup')); // the group may be created again with its anchors
    reconciler.schedule('group-removed');
  });
  browser.windows.onCreated.addListener(schedule('window-created'));
  // The menu is global: it follows the active tab of the focused window.
  browser.windows.onFocusChanged.addListener(() => refreshActiveMenu());
  browser.runtime.onStartup.addListener(() => {
    dedupe.noteStartup();
    reconciler.schedule('startup');
    void closeExecutor.evaluateAll(); // storage.session (pending closes) is empty after a browser start
  });
  const session = { get: async (k: string) => (await browser.storage.session.get(k))[k] };
  const badgeDeps = {
    port,
    // Anchors are never closed by dupes.close* (R11), so they are not counted as closable extras.
    isLocked: (id: number) => safety.isLocked(id) || anchors.isAnchor(id),
    // Effective settings (config dedupe + recipe urlTransforms), so the popup and badge agree with the engine.
    getSettings: async () => (await getProgram()).dedupe,
    // Per-rule dedupe overrides (R25) for duplicate sets, as the engine decides them (M2 T17).
    getProgram,
    // Which views are shown (R58 / R59): the badge counts only those (R60).
    getConfig: () => store.get(),
    // Recipe views (M2 T17): the popup tabs, and the list views' counts in the toolbar badge (R20).
    views: {
      builtins: builtinRecipes(),
      getProgram,
      facts: (id: number) => { const page = pageFacts.get(id); return page ? { page } : {}; },
      permissions,
      closes: {
        ready: closeExecutor.ready,
        suggestions: () => closeExecutor.suggestions(),
        exempt: (id: number, url: string) => closeExecutor.exempt(id, url),
      },
    },
    ask: {
      listPending: () => listPendingAsks(session),
      resolvePending: (n: number, e: number, c: 'switch' | 'keep') => askController.resolvePending(n, e, c),
    },
  };
  const scheduleBadge = createDebounce(() => { refreshBadge(badgeDeps).catch(warn('badge refresh')); }, 500, 2000);
  for (const ev of [browser.tabs.onCreated, browser.tabs.onRemoved, browser.tabs.onUpdated, browser.tabs.onReplaced, browser.tabs.onAttached]) {
    ev.addListener(scheduleBadge);
  }
  // Finished suggestions are counted in the badge: recount when CloseExecutor stores a change to them.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && CLOSE_SUGGESTIONS_KEY in changes) scheduleBadge();
  });
  scheduleBadge();
  const handleRequest = createHandler({
    ...badgeDeps,
    runtimeId: browser.runtime.id,
    extensionOrigin: new URL(browser.runtime.getURL('/')).origin,
    store,
    // Lock changes from the popup also update the menu's Lock / Unlock title.
    safety: {
      pause: (d) => safety.pause(d), resume: () => safety.resume(), isPaused: () => safety.isPaused(),
      isLocked: (id) => safety.isLocked(id), lockedTabIds: () => safety.lockedTabIds(), undo: (id) => safety.undo(id),
      lock: (id) => { safety.lock(id); refreshActiveMenu(); },
      unlock: (id) => { safety.unlock(id); refreshActiveMenu(); },
    },
    recentlyClosed,
    whyLog,
    recipes: { builtins: builtinRecipes(), permissions },
    isAnchor: (id) => anchors.isAnchor(id),
    // M3: dupes.close* / view.close decide on loaded locks and anchors, never on empty sets.
    beforeClose: async () => { await Promise.all([safety.ready, anchors.ready]); },
    // preview.change (M2 T13): read-only views of the engine (Program, planner state, page facts); nothing is applied.
    preview: {
      builtins: builtinRecipes(),
      getProgram,
      planContext: (snap, p) => reconciler.planContext(snap, p),
      facts: (id) => { const page = pageFacts.get(id); return page ? { page } : {}; },
      permissions,
    },
    // explain.tab / rules.shadowed (M2 T14): read-only, like preview.
    explain: {
      builtins: builtinRecipes(),
      facts: (id) => { const page = pageFacts.get(id); return page ? { page } : {}; },
      permissions,
    },
  });
  // Watch content script (ruling R12): its own sender-checked channel, never createHandler.
  const handleContent = createContentHandler({
    runtimeId: browser.runtime.id,
    extensionOrigin: new URL(browser.runtime.getURL('/')).origin,
    getProgram,
    pageFacts,
    safety,
    schedule: (r) => reconciler.schedule(r),
    // New page facts can change list views (pageText showInView), hence the badge (R60).
    onFacts: (id) => { void closeExecutor.onFacts(id); scheduleBadge(); },
    onCloseChoice: (id, choice) => { void closeExecutor.onCloseChoice(id, choice); },
  });
  // UI requests (popup / options), banner choices (content script in the duplicate tab) and the watch script.
  browser.runtime.onMessage.addListener(createOnMessage({
    runtimeId: browser.runtime.id,
    handleRequest,
    handleContent,
    handleBanner: (msg, sender) => {
      if (!isBannerChoiceMessage(msg) && !isUndoChoiceMessage(msg)) return false;
      const tabId = sender.tab?.id;
      if (tabId === undefined) return true;
      if (isBannerChoiceMessage(msg)) {
        askController.handleChoice(tabId, msg.existingTabId, msg.choice).catch(warn('banner choice'));
      } else {
        safety.undo(msg.entryId).catch(warn('undo'));
      }
      return true;
    },
  }));
  // Alarms are routed by name prefix: `close:<tabId>` to the CloseExecutor, the rest (resume) to SafetyService.
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith(CLOSE_ALARM_PREFIX)) void closeExecutor.onAlarm(alarm.name);
    else safety.onAlarm(alarm);
  });
  // notifications is an optional permission: its events exist only once granted, so (re)register on grant as well.
  let notificationsWired = false;
  const wireNotifications = () => {
    if (notificationsWired || !browser.notifications) return;
    notificationsWired = true;
    const onErr = warn('notification handler');
    browser.notifications.onButtonClicked.addListener((id, i) => {
      if (id.startsWith(UNDO_NOTIFICATION_PREFIX)) safety.undo(id.slice(UNDO_NOTIFICATION_PREFIX.length)).catch(onErr);
      else askController.onNotificationButton(id, i).catch(onErr);
      void browser.notifications.clear(id);
    });
    browser.notifications.onClosed.addListener((id) => { askController.onNotificationClosed(id).catch(onErr); });
  };
  wireNotifications();
  browser.permissions.onAdded.addListener(wireNotifications);
  // Permission grants / revocations (also from chrome://extensions) and worker start: re-check needs, pause or resume
  // recipes and re-register the watch for the granted origins enabled recipes need.
  const syncPermissions = () => { void permissions.onChanged(); };
  browser.permissions.onAdded.addListener(syncPermissions);
  browser.permissions.onRemoved.addListener(syncPermissions);
  syncPermissions();
  browser.runtime.onInstalled.addListener(() => {
    reconciler.schedule('installed');
    installMenus(menuApi).then(refreshActiveMenu, warn('context menu install'));
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    safety.ready
      .then(() => onMenuClick(info, tab, { openPage: openOptions, safety, refresh: () => refreshMenu(tab) }))
      .catch(warn('context menu click'));
  });
});
