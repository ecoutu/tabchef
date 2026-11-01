import { browser } from 'wxt/browser';
import { defaultConfig } from '../core/config/defaults';
import { DedupeHandler, type LogEntry, type RecentlyClosedEntry } from '../engine/dedupe-handler';
import { Reconciler } from '../engine/reconciler';
import { ChromePort } from '../platform/chrome-port';

export default defineBackground(() => {
  // TODO(Task 13): replace with ConfigStore.get().
  const getConfig = async () => defaultConfig();
  const port = new ChromePort();
  const reconciler = new Reconciler(port, getConfig);
  const schedule = (reason: string) => () => reconciler.schedule(reason);

  // TODO(Task 12): replace with RecentlyClosed / WhyLog. Minimal in-memory stubs until then.
  const recentlyClosed: RecentlyClosedEntry[] = [];
  const whyLog: LogEntry[] = [];
  const dedupe = new DedupeHandler(port, getConfig, {
    recentlyClosed: {
      add: (e) => {
        recentlyClosed.unshift(e);
        recentlyClosed.length = Math.min(recentlyClosed.length, 100);
        return `${e.at}-${recentlyClosed.length}`;
      },
    },
    log: {
      add: (e) => {
        whyLog.push(e);
        if (whyLog.length > 1000) whyLog.shift();
      },
    },
    // TODO(Task 11): replace with the in-page ask prompt.
    ask: async (newTab, existing) => console.debug('[tabchef] dedupe ask (stub)', newTab.id, existing.id),
    isPaused: () => false,
    isLocked: () => false,
    // Cleared on browser restart: a missing marker at worker start opens the startup grace (order-independent).
    session: {
      get: async (k) => (await browser.storage.session.get(k))[k],
      set: (k, v) => browser.storage.session.set({ [k]: v }),
    },
  });
  const candidate = (...a: Parameters<DedupeHandler['onCandidate']>) => {
    dedupe.onCandidate(...a).catch((e: unknown) => console.warn('[tabchef] dedupe failed', e));
  };
  // Tabs already on a new-tab page when this worker starts are still "fresh" (rule: never committed a real URL).
  port.snapshot().then((s) => dedupe.seed(s.tabs), (e: unknown) => console.warn('[tabchef] dedupe seed failed', e));

  // MV3: every listener is registered synchronously at the top level so a restarted worker receives the event.
  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) {
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
    if (info.url !== undefined) void reconciler.onTabUrlChanged(tabId);
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
  browser.tabs.onRemoved.addListener((tabId) => {
    dedupe.onRemoved(tabId);
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
  browser.runtime.onInstalled.addListener(schedule('installed'));
});
