import { browser } from 'wxt/browser';
import { defaultConfig } from '../core/config/defaults';
import type { Config } from '../core/types';
import { createAskController } from '../engine/ask';
import { RecentlyClosed } from '../core/safety/recently-closed';
import { WhyLog } from '../core/safety/why-log';
import {
  isBannerChoiceMessage, isFormEditedMessage, isUndoChoiceMessage, UNDO_NOTIFICATION_PREFIX,
} from '../engine/messages';
import { DedupeHandler } from '../engine/dedupe-handler';
import { Reconciler } from '../engine/reconciler';
import { SafetyService } from '../engine/safety';
import { ChromePort } from '../platform/chrome-port';

export default defineBackground(() => {
  // TODO(Task 13): replace with ConfigStore.get().
  // Task 13: persist via ConfigStore
  let config: Config = defaultConfig();
  const getConfig = async () => config;
  const updateConfig = async (fn: (c: Config) => Config) => {
    config = fn(config);
  };
  const port = new ChromePort();
  const whyLog = new WhyLog();
  const recentlyClosed = new RecentlyClosed();
  const warn = (what: string) => (e: unknown) => console.warn(`[tabchef] ${what} failed`, e);
  // `safety` is used lazily by the closures below (it needs the reconciler and dedupe handler, which need it).
  const reconciler = new Reconciler(port, getConfig, {
    log: whyLog,
    isPaused: () => safety.isPaused(),
    beforeRun: () => safety.ready,
    extraLeaveAlone: () => safety.lockedTabIds(),
  });
  const schedule = (reason: string) => () => reconciler.schedule(reason);

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
    getConfig,
    updateConfig,
    recentlyClosed,
    log: whyLog,
    isLocked: (id) => safety.isLocked(id),
    onClosed: (id, entry, focused) => { safety.toast(id, entry, focused).catch(warn('undo toast')); },
  });
  const dedupe: DedupeHandler = new DedupeHandler(port, getConfig, {
    recentlyClosed,
    log: whyLog,
    ask: askController.ask,
    isPaused: () => safety.isPaused(),
    isLocked: (id) => safety.isLocked(id),
    beforeDecide: () => safety.ready,
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
  });
  const candidate = (...a: Parameters<DedupeHandler['onCandidate']>) => {
    dedupe.onCandidate(...a).catch((e: unknown) => console.warn('[tabchef] dedupe failed', e));
  };
  // Tabs already on a new-tab page when this worker starts are still "fresh" (rule: never committed a real URL).
  port.snapshot().then((s) => dedupe.seed(s.tabs), (e: unknown) => console.warn('[tabchef] dedupe seed failed', e));

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
    if (d.frameId === 0) candidate(d.tabId, d.url, 'committed');
  });
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    const dedupeUrl = info.url ?? (info.status === 'loading' ? tab.pendingUrl : undefined);
    if (dedupeUrl) candidate(tabId, dedupeUrl, 'pending');
    if (info.url !== undefined) {
      safety.onTabSeen({ id: tabId, url: info.url, windowId: tab.windowId });
      void reconciler.onTabUrlChanged(tabId);
    }
    if (info.groupId !== undefined) void reconciler.onTabGroupChanged(tabId, info.groupId);
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
    dedupe.onRemoved(tabId);
    askController.onTabRemoved(tabId).catch((e: unknown) => console.warn('[tabchef] pending ask cleanup failed', e));
    reconciler.schedule('tab-removed');
  });
  browser.tabs.onReplaced.addListener((added, removed) => dedupe.onReplaced(added, removed));
  browser.tabGroups.onUpdated.addListener(schedule('group-updated'));
  browser.tabGroups.onRemoved.addListener(schedule('group-removed'));
  browser.windows.onCreated.addListener(schedule('window-created'));
  browser.runtime.onStartup.addListener(() => {
    dedupe.noteStartup();
    reconciler.schedule('startup');
  });
  // Banner choices arrive from the content script in the duplicate tab.
  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    if (sender.id !== browser.runtime.id) return;
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    if (isBannerChoiceMessage(msg)) {
      askController.handleChoice(tabId, msg.existingTabId, msg.choice).catch(warn('banner choice'));
    } else if (isUndoChoiceMessage(msg)) {
      safety.undo(msg.entryId).catch(warn('undo'));
    } else if (isFormEditedMessage(msg)) {
      safety.markFormEdited(tabId, sender.tab?.url);
    }
  });
  browser.alarms.onAlarm.addListener((alarm) => safety.onAlarm(alarm));
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
  browser.runtime.onInstalled.addListener(schedule('installed'));
});
