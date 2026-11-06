import { browser } from 'wxt/browser';
import type { Config } from '../core/types';
import { AnchorService } from '../engine/anchors';
import { createAskController } from '../engine/ask';
import { RecentlyClosed } from '../core/safety/recently-closed';
import { WhyLog } from '../core/safety/why-log';
import {
  adoptReport, configRev, createContentHandler, createDebounce, createHandler, createOnMessage, isBannerChoiceMessage, isUndoChoiceMessage, refreshBadge,
  UNDO_NOTIFICATION_PREFIX, type ContentDeps,
} from '../engine/messages';
import { listPendingAsks } from '../engine/ask';
import { afterConfigChange, CLOSE_ALARM_PREFIX, CLOSE_SUGGESTIONS_KEY, CloseExecutor } from '../engine/close-executor';
import { DedupeHandler } from '../engine/dedupe-handler';
import { AGE_TICK_ALARM, TabAges } from '../engine/tab-ages';
import { usesAge } from '../core/lang/cond';
import { PageFacts } from '../engine/page-facts';
import { createWatchScripting, WATCH_FILE, WATCH_SCRIPT_ID } from '../engine/watch-registration';
import { PermissionsManager } from '../engine/permissions';
import { builtinRecipes } from '../recipes/load';
import { ProgramCache } from '../engine/program-cache';
import { Reconciler } from '../engine/reconciler';
import { LoadHold } from '../engine/load-hold';
import { SafetyService } from '../engine/safety';
import { ChromePort } from '../platform/chrome-port';
import { ConfigStore } from '../storage/config-store';
import { createProjectMenu, onMenuClick, refreshMenus, type MenuApi, type MenuTab } from '../engine/context-menu';
import { ProjectService, ProjectStore } from '../engine/projects';
import { ConnectionManager } from '../engine/connections/manager';
import { SecretStore, type KeyValueArea } from '../engine/connections/secret-store';
import { RateLimiter } from '../engine/connections/rate-limiter';
import { GitHubDeviceAuth } from '../engine/connections/github-auth';
import { TokenAuth, setGitHubToken } from '../engine/connections/token-auth';
import { JiraAuth, JiraSessionAuth, setJiraSession, setJiraToken } from '../engine/connections/jira-auth';
import type { ConnectionsChangedMessage } from '../engine/messages';
import { refreshPeriodMinutes, SourceService, SOURCES_ALARM } from '../engine/sources';

export default defineBackground(() => {
  const store = new ConfigStore();
  // One compiled Program for every engine consumer (ruling R4); recompiled when the config revision or the
  // PermissionsManager's paused set (recipes / rules waiting for a permission) changes.
  const programs = new ProgramCache(() => store.get(), { paused: () => permissions.paused() });
  const getProgram = () => programs.get();
  const updateConfig = async (fn: (c: Config) => Config) => {
    await store.update(fn);
  };
  // Every snapshot carries tab creation times (TabSnap.created, M3-R2). tabAges is declared below (it needs dedupe).
  const port = new ChromePort(browser, undefined, (s) => tabAges.annotate(s));
  const whyLog = new WhyLog();
  const recentlyClosed = new RecentlyClosed();
  // storage.session (cleared on browser restart) as the engine's key-value seam.
  const session = {
    get: async (k: string): Promise<unknown> => (await browser.storage.session.get(k))[k],
    set: (k: string, v: unknown): Promise<void> => browser.storage.session.set({ [k]: v }),
  };
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
    // Connection states feed the capability levels (M3 T12). Lazy: the manager is built below; syncs run after start.
    connections: () => connectionInfo(),
    // M3-R107: a rule whose level kind changed (no pause or resume, so no new Program) looks its sources up now.
    onKindsChanged: (keys) => { sources.refresh('manual', keys).catch(warn('source refresh')); },
    onPausedChanged: () => {
      reconciler.schedule('permissions');
      syncAgeTick(); // a paused or resumed rule may use age
      startSourcesAlarm(); // ... or have a source
      void closeExecutor.rearm(); // closes kept pending while their recipe waited for a permission
      void closeExecutor.evaluateAll(); // the Program changed (R51): a resumed close rule applies to open tabs
    },
  });
  /** Each connection's id, label and state (the manager is built below; only called after start). */
  async function connectionInfo() {
    const [defs, status] = await Promise.all([connections.defs(), connections.status()]);
    return status.map((st) => ({ id: st.id, label: defs.find((d) => d.id === st.id)?.label ?? st.id, state: st.state }));
  }
  // Page facts from the watch content script (M2 T7), mirrored to storage.session.
  const pageFacts = new PageFacts({
    session,
    onHoldExpired: () => reconciler.schedule('pageFacts-hold'),
    // Hold only where the watch is registered: elsewhere no facts will come.
    covers: (url) => permissions.covers(url),
    // A report that beat its document's commit, adopted by that commit: applied like an accepted one (contentDeps).
    onAdopt: (id, r) => { adoptReport(contentDeps, id, r); },
  });
  // Tabs still loading are held by the planner until they load (their final title may assign a project), at most LOAD_HOLD_MS.
  const loadHold = new LoadHold({ onExpired: () => reconciler.schedule('load-hold') });
  // `safety` is used lazily by the closures below (it needs the reconciler and dedupe handler, which need it).
  const reconciler: Reconciler = new Reconciler(port, getProgram, {
    log: whyLog,
    isPaused: () => safety.isPaused(),
    beforeRun: async () => { await Promise.all([safety.ready, pageFacts.ready, permissions.ready, sources.ready]); },
    extraLeaveAlone: () => safety.lockedTabIds(),
    pageFacts,
    loading: (t) => loadHold.held(t),
    // `sources` is declared below (it needs the connection manager); only called once a run starts.
    sources: { factsFor: (id, url) => sources.factsFor(id, url) },
    anchors: { onGroupCreated: (...a) => anchors.onGroupCreated(...a) },
    // Project groups (M3 T15): `projects` is declared below (it needs the SourceService).
    projects: { targets: (snap) => projects.targets(snap), previewTargets: (snap, p) => projects.previewTargets(snap, p) },
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
    syncAgeTick(); // declared below
    startSourcesAlarm(); // refreshEvery may have changed (M3-R75); declared below
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
      session,
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
    session,
  });
  // Tab creation times for `age` conditions (R66, M3-R4); a tab created in the startup grace is a lower bound.
  const tabAges = new TabAges({ session, inStartupGrace: (at) => dedupe.inStartupGrace(at), graceReady: dedupe.ready });
  // While a Program rule uses age, a 1-minute alarm re-evaluates it (M3-R5): nothing else fires when a tab gets old.
  // A running alarm is left alone, so frequent config changes never postpone its next tick.
  const syncAgeTick = () => {
    (async () => {
      if (!(await getProgram()).rules.some((r) => usesAge(r.rule))) await browser.alarms.clear(AGE_TICK_ALARM);
      else if (!(await browser.alarms.get(AGE_TICK_ALARM))) await browser.alarms.create(AGE_TICK_ALARM, { periodInMinutes: 1 });
    })().catch(warn('age alarm sync'));
  };
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
    // Undo of a Close group entry revives the project first (M3-R84).
    beforeUndo: (entryId) => projects.onUndo(entryId),
  });
  // Delayed / suggested closes (M2 T9), persisted in storage.session.
  const closeExecutor: CloseExecutor = new CloseExecutor(port, getProgram, {
    safety,
    recentlyClosed,
    log: whyLog,
    facts: pageFacts,
    sources: { factsFor: (id, url) => sources.factsFor(id, url) },
    banner: async (tabId) => {
      const t = (await port.snapshot()).tabs.find((x) => x.id === tabId);
      return t ? safety.protectedCloseBanner(t) : false;
    },
    alarms: {
      create: (name, when) => browser.alarms.create(name, { when }),
      clear: (name) => browser.alarms.clear(name),
    },
    session,
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
    remove: async (id) => { await browser.contextMenus.remove(id); },
  };
  const refreshMenu = (tab: MenuTab | undefined) => {
    safety.ready.then(() => refreshMenus(menuApi, tab, (id) => safety.isLocked(id))).catch(warn('menu refresh'));
  };
  const refreshActiveMenu = () => {
    browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => refreshMenu(t), warn('menu refresh'));
  };
  // Connections (M3): one ConnectionManager, SecretStore and limiter shared by every consumer. The e2e-only
  // build flag allows http://localhost APIs (M3-R35); it is read here only, never in core or the engine.
  const allowLocalhost = import.meta.env.WXT_E2E_LOCALHOST === '1';
  const localArea = browser.storage.local as unknown as KeyValueArea;
  const sessionArea = browser.storage.session as unknown as KeyValueArea;
  const secrets = new SecretStore({ local: localArea, session: sessionArea });
  // Restrict storage.local to trusted contexts at every worker start, not only before a write (M3-R46): a token stored
  // in an earlier session is protected before anything else runs. Idempotent; it warns once where unsupported.
  secrets.init().catch(warn('secret store init'));
  const limiter = new RateLimiter(sessionArea);
  const connFetch: typeof fetch = (input, init) => fetch(input, init);
  const githubAuth: GitHubDeviceAuth = new GitHubDeviceAuth({
    fetch: connFetch, secrets, session: sessionArea, port,
    // Lazy: the manager is built below with this provider in its auth map.
    manager: () => connections,
  });
  // Jira tokens (scoped / classic, Basic email:token) and session mode (read-only, the browser's cookies).
  // setJiraToken / setJiraSession (connections.setToken / setSession) take these instances.
  const jiraAuth = new JiraAuth({ fetch: connFetch, secrets, now: Date.now });
  const tokenAuth = new TokenAuth({ jira: jiraAuth });
  const jiraSession = new JiraSessionAuth();
  const connections: ConnectionManager = new ConnectionManager({
    local: localArea, session: sessionArea, secrets, limiter, port, fetch: connFetch, log: whyLog,
    // oauth-* sign-in is not implemented yet: their defs never reach the manager.
    auth: { 'device-code': githubAuth, token: tokenAuth, session: jiraSession, 'oauth-pkce': tokenAuth, 'oauth-proxy': tokenAuth },
    allowLocalhost,
  });
  // Tell open extension pages (Connections) a status changed; they re-list. "No receiver" rejections are expected.
  // The capability levels follow (M3 T12): a rule that gains or loses its last alternative pauses / resumes, which
  // recompiles the Program through onPausedChanged.
  connections.onStatusChange((s) => {
    const m: ConnectionsChangedMessage = { type: 'connections.changed', id: s.id };
    Promise.resolve(browser.runtime.sendMessage(m)).catch(() => {});
    void permissions.onChanged();
  });
  // Source lookups of recipe rules (M3 T11), cached in storage.local. Changed data re-plans, re-evaluates closes of
  // the changed tabs and recounts the badge (list views may show source fields).
  const sources: SourceService = new SourceService({
    conn: connections, limiter, getProgram, port, facts: pageFacts, local: localArea,
    levelFor: (...a) => permissions.levelFor(...a),
    onUpdated: (tabIds) => {
      reconciler.schedule('sourceUpdated');
      for (const id of tabIds) void closeExecutor.evaluate(id);
      scheduleBadge();
    },
  });
  // Projects (M3 T15): stored in storage.local `projects` (not synced); sticky membership in the reconciler's state.
  // Each pass reports the open projects, which the "Add to project" submenu follows.
  const projectMenu = createProjectMenu(menuApi);
  /** Open projects as of the last pass: the Projects tab's count. */
  let openProjects = 0;
  const projects: ProjectService = new ProjectService({
    store: new ProjectStore(localArea), port, getProgram, sources, facts: pageFacts, log: whyLog, recentlyClosed, safety, session,
    state: () => reconciler.liveState(),
    schedule: (r) => reconciler.schedule(r),
    onProjectsChanged: (ps) => { openProjects = ps.length; projectMenu.sync(ps).catch(warn('project menu')); },
    toast: (ids, text, focused) => { safety.toastGroup(ids, text, focused).catch(warn('undo toast')); },
  });
  // Tabs and page facts changed: look up what new or navigated tabs need (cache first; at most every few seconds).
  const scheduleSources = createDebounce(() => { sources.refresh('tabs').catch(warn('source refresh')); }, 1000, 5000);
  // A title change re-plans (title conditions and extracts, e.g. a PR title naming its ticket). A same-document
  // navigation (GitHub repo → Pull requests → a PR) changes the URL first and the title later, so the URL's pass saw
  // the old title. Debounced with a max wait: a page whose title ticks still re-plans, without a pass per tick.
  const scheduleTitlePass = createDebounce(() => reconciler.schedule('tab-title'), 1000, 5000);
  // M3-R75: the period is the smallest `refreshEvery` of the enabled recipes (default 5 min); the alarm is re-created
  // only when it is missing or its period differs, so config changes never postpone its next tick. Without a rule that
  // has a `source` (enabled and not paused) nothing can make a request: the alarm is cleared (as syncAgeTick does).
  const startSourcesAlarm = () => {
    (async () => {
      const p = await getProgram();
      if (!p.rules.some((r) => r.rule.source)) {
        await browser.alarms.clear(SOURCES_ALARM);
        return;
      }
      const period = refreshPeriodMinutes(p);
      if ((await browser.alarms.get(SOURCES_ALARM))?.periodInMinutes !== period) {
        await browser.alarms.create(SOURCES_ALARM, { periodInMinutes: period });
      }
    })().catch(warn('source alarm'));
  };
  /**
   * Tab facts for read-only views (popup views, preview, explain): page facts and source data. `url` is the snapshot
   * tab's: SourceService drops data looked up for a previous page, so a just-navigated tab shows no stale pill.
   */
  const tabFacts = (id: number, url?: string) => {
    const page = pageFacts.get(id);
    const source = sources.factsFor(id, url);
    return { ...(page && { page }), ...(source && { source }) };
  };
  const openOptions = async (hash: string) => { await browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}${hash}` }); };

  // MV3: every listener is registered synchronously at the top level so a restarted worker receives the event.
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) {
      // A new tab's url is '' until its navigation commits: use the pending URL, so a parked lock reattaches now.
      safety.onTabSeen({ id: tab.id, url: tab.url || tab.pendingUrl || '', windowId: tab.windowId });
      dedupe.recordCreated(tab.id, { discarded: tab.discarded, status: tab.status });
      tabAges.onCreated(tab);
      if (tab.status === 'loading') loadHold.onLoading(tab.id);
      const url = tab.pendingUrl || tab.url;
      if (url) candidate(tab.id, url, 'pending');
    }
    reconciler.schedule('tab-created');
    scheduleSources();
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
    if (info.status === 'loading') loadHold.onLoading(tabId);
    if (info.status === 'complete') {
      loadHold.onComplete(tabId);
      reconciler.schedule('tab-loaded'); // the planner held it while it loaded
    }
    // The title an in-page navigation sets after complete ends its hold: re-plan now, not after the title debounce.
    if (info.title !== undefined && loadHold.onTitle(tabId, info.title, tab.url)) reconciler.schedule('tab-titled');
    const dedupeUrl = info.url ?? (info.status === 'loading' ? tab.pendingUrl : undefined);
    if (dedupeUrl) candidate(tabId, dedupeUrl, 'pending');
    // Title-aware dedupe (R18): a candidate awaiting its title re-enters here, outside the serialized chain.
    const titleUrl = tab.pendingUrl || tab.url;
    if (info.title !== undefined && titleUrl) {
      dedupe.onTitleChanged(tabId, titleUrl).catch((e: unknown) => console.warn('[tabchef] dedupe failed', e));
    }
    if (info.title !== undefined) scheduleTitlePass();
    if (info.url !== undefined) {
      safety.onTabSeen({ id: tabId, url: info.url, windowId: tab.windowId });
      void reconciler.onTabUrlChanged(tabId, info.url);
      void closeExecutor.evaluate(tabId); // also same-document navigations, which fire no onCommitted
      if (tab.active) refreshActiveMenu(); // e.g. a new tab (chrome://newtab) navigating to a site
      scheduleSources();
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
    tabAges.onRemoved(tabId);
    loadHold.onDone(tabId);
    anchors.onTabRemoved(tabId, info.isWindowClosing).catch(warn('anchor cleanup'));
    askController.onTabRemoved(tabId).catch((e: unknown) => console.warn('[tabchef] pending ask cleanup failed', e));
    reconciler.schedule('tab-removed');
  });
  browser.tabs.onReplaced.addListener((added, removed) => {
    pageFacts.clear(removed);
    void closeExecutor.onTabRemoved(removed);
    dedupe.onReplaced(added, removed);
    tabAges.onReplaced(added, removed);
    loadHold.onDone(removed);
    anchors.onTabReplaced(added, removed).catch(warn('anchor replace'));
    projects.onReplaced(added, removed).catch(warn('project replace')); // a discarded tab keeps its project (Review Focus #4)
  });
  browser.tabGroups.onUpdated.addListener((g) => {
    anchors.onGroupUpdated(g).catch(warn('anchor group rename')); // a renamed group keeps its anchors
    reconciler.schedule('group-updated');
  });
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
    startSourcesAlarm();
  });
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
      facts: tabFacts,
      permissions,
      connections: () => connectionInfo(),
      projectCount: () => openProjects,
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
    // view.close's fire-time protection (M3-R76 / M3-R78): unsaved form edits, besides pinned / locked / anchor.
    isFormEdited: (id) => safety.isFormEdited(id),
    // M3: dupes.close* / view.close decide on loaded locks, anchors and page facts (form edits), never on empty sets.
    beforeClose: async () => { await Promise.all([safety.ready, anchors.ready, pageFacts.ready]); },
    // preview.change (M2 T13): read-only views of the engine (Program, planner state, page facts); nothing is applied.
    preview: {
      builtins: builtinRecipes(),
      getProgram,
      planContext: (snap, p) => reconciler.planContext(snap, p),
      projectOverrides: (snap, p) => reconciler.previewOverrides(snap, p),
      facts: tabFacts,
      permissions,
    },
    // connections.* (M3 T7): the shared instances; setToken validates and stores a GitHub PAT or a Jira API
    // token, setSession switches Jira to session mode.
    connections: {
      manager: connections,
      github: githubAuth,
      setGitHubToken: (token) => setGitHubToken({ manager: connections, secrets, port, fetch: connFetch, allowLocalhost }, token),
      setJiraToken: (input) => setJiraToken({ manager: connections, secrets, port, fetch: connFetch, allowLocalhost, jira: jiraAuth }, input),
      setJiraSession: (site) => setJiraSession({ manager: connections, secrets, port, fetch: connFetch, allowLocalhost, jira: jiraAuth }, { site }),
      knownSecrets: () => secrets.knownSecrets(),
    },
    projects,
    // sources.refresh (M3 T17): the popup's Projects tab refreshes source data (refresh('popup'), throttled).
    sources,
    // explain.tab / rules.shadowed (M2 T14): read-only, like preview.
    explain: {
      builtins: builtinRecipes(),
      facts: tabFacts,
      permissions,
    },
  });
  // Watch content script (ruling R12): its own sender-checked channel, never createHandler.
  const contentDeps: ContentDeps = {
    runtimeId: browser.runtime.id,
    extensionOrigin: new URL(browser.runtime.getURL('/')).origin,
    getProgram,
    pageFacts,
    safety,
    schedule: (r) => reconciler.schedule(r),
    // New page facts can change list views (pageText showInView), hence the badge (R60).
    // New page facts can also be a source's page fallback (M3 T11).
    onFacts: (id) => { void closeExecutor.onFacts(id); scheduleBadge(); scheduleSources(); },
    onCloseChoice: (id, choice) => { void closeExecutor.onCloseChoice(id, choice); },
  };
  const handleContent = createContentHandler(contentDeps);
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
  // Alarms are routed by name prefix: `close:<tabId>` to the CloseExecutor, `age.tick` re-evaluates age conditions
  // (M3-R5), `sources.refresh` refreshes source data (M3 T11), the rest (resume) to SafetyService.
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith(CLOSE_ALARM_PREFIX)) void closeExecutor.onAlarm(alarm.name);
    else if (alarm.name === SOURCES_ALARM) sources.refresh('alarm').catch(warn('source refresh'));
    else if (alarm.name === AGE_TICK_ALARM) {
      reconciler.schedule('age');
      void closeExecutor.evaluateAll();
    } else safety.onAlarm(alarm);
  });
  syncAgeTick();
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
  // recipes and re-register the watch for the granted origins enabled recipes need. A connection's state depends on
  // its host permissions too (revoked api.github.com → not-configured): every status is re-emitted, so the Connections
  // page re-lists and the capability levels follow.
  const syncPermissions = () => {
    void permissions.onChanged();
    connections.permissionsChanged().catch(warn('connection status'));
  };
  browser.permissions.onAdded.addListener(syncPermissions);
  browser.permissions.onRemoved.addListener(syncPermissions);
  syncPermissions();
  browser.runtime.onInstalled.addListener(() => {
    reconciler.schedule('installed');
    projectMenu.install().then(refreshActiveMenu, warn('context menu install')); // installMenus, then the open projects
    startSourcesAlarm();
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    safety.ready
      .then(() => onMenuClick(info, tab, { openPage: openOptions, safety, refresh: () => refreshMenu(tab), projects }))
      .catch(warn('context menu click'));
  });
});
