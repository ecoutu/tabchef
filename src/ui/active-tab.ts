// The active tab of the page's own window: the popup's window, or the side panel's (#212).
import { browser } from 'wxt/browser';

/** Either id can be missing (a tab Chrome reports without one), as tabs.Tab has them. */
export interface ActiveTab { tabId?: number; windowId?: number }

/** The active tab of the current window; undefined when there is none (e.g. devtools) or the query fails. */
export async function currentTab(): Promise<ActiveTab | undefined> {
  try {
    const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    return tab ? { tabId: tab.id, windowId: tab.windowId } : undefined;
  } catch {
    return undefined;
  }
}

export interface ActiveTabFollower {
  /** Reads the active tab again, for what tabs.onActivated does not report (e.g. tabs.onReplaced swapping its id). */
  sync(): Promise<void>;
  stop(): void;
}

/**
 * Calls `onChange` with the active tab of the current window, then each time a tab is activated in that window (a tab
 * switch in another window is not this page's), and on sync() when it differs. An activation is newer than a query
 * that was on its way when it came: a switch made while the first query runs is not lost, and no query result
 * replaces a later switch.
 */
export function followActiveTab(onChange: (tabId: number) => void): ActiveTabFollower {
  let windowId: number | undefined;
  /** Activations heard so far, in any window: a query started at `n` is older than activation n + 1 on. */
  let n = 0;
  /** The latest activation per window, heard before this page's window is known. */
  const early = new Map<number, { tabId: number; at: number }>();
  /** The number (`n`) of the latest activation in this window; 0 for none. */
  let switched = 0;
  let last: number | undefined;
  let stopped = false;
  const report = (tabId: number): void => {
    if (tabId === last) return;
    last = tabId;
    onChange(tabId);
  };
  const onActivated = (info: { tabId: number; windowId: number }): void => {
    n++;
    if (windowId === undefined) { early.set(info.windowId, { tabId: info.tabId, at: n }); return; }
    if (info.windowId !== windowId) return;
    switched = n;
    report(info.tabId);
  };
  browser.tabs.onActivated.addListener(onActivated);

  async function sync(): Promise<void> {
    const at = n;
    const t = await currentTab();
    if (stopped || t?.windowId === undefined || (windowId !== undefined && t.windowId !== windowId)) return;
    if (windowId === undefined) {
      windowId = t.windowId;
      const e = early.get(windowId);
      early.clear();
      if (e) {
        switched = e.at;
        if (e.at > at) report(e.tabId); // else this answer is newer and reports below
      }
    }
    if (switched > at) return; // a switch came while this query ran
    if (t.tabId !== undefined) report(t.tabId);
  }
  void sync();
  return {
    sync,
    stop: () => {
      stopped = true;
      browser.tabs.onActivated.removeListener(onActivated);
    },
  };
}
