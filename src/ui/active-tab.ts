// The active tab of the page's own window: the popup's window, or the side panel's.
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
