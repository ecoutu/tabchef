import { browser } from 'wxt/browser';
import { defaultConfig } from '../core/config/defaults';
import { Reconciler } from '../engine/reconciler';
import { ChromePort } from '../platform/chrome-port';

export default defineBackground(() => {
  // TODO(Task 13): replace with ConfigStore.get().
  const reconciler = new Reconciler(new ChromePort(), async () => defaultConfig());
  const schedule = (reason: string) => () => reconciler.schedule(reason);

  // MV3: every listener is registered synchronously at the top level so a restarted worker receives the event.
  browser.tabs.onCreated.addListener(schedule('tab-created'));
  browser.tabs.onUpdated.addListener((tabId, info) => {
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
  browser.tabs.onRemoved.addListener(schedule('tab-removed'));
  browser.tabGroups.onUpdated.addListener(schedule('group-updated'));
  browser.tabGroups.onRemoved.addListener(schedule('group-removed'));
  browser.windows.onCreated.addListener(schedule('window-created'));
  browser.runtime.onStartup.addListener(schedule('startup'));
  browser.runtime.onInstalled.addListener(schedule('installed'));
});
