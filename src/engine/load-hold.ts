// Tabs whose page is still loading (chrome.tabs.Tab.status 'loading'): the planner holds them until the page has
// loaded, so a rule reading the final title (a ticket key in a PR title, which assigns a project) decides the tab's group,
// not its URL alone. Without the hold a tab joins its URL rule's group first and moves again once the title lands.
// A page that never finishes loading is held for LOAD_HOLD_MS at most. Memory only: after a worker restart a loading
// tab is held from when a pass first sees it.
import type { TabSnap } from '../core/types';
import { TabHolds } from './tab-holds';

/** How long the planner holds a tab whose page is still loading. */
export const LOAD_HOLD_MS = 10_000;

export interface LoadHoldDeps {
  /** A hold expired with the page still loading: re-plan so the tab is grouped after all (background: reconciler.schedule). */
  onExpired: () => void;
  now?: () => number;
}

export class LoadHold {
  private readonly holds: TabHolds;

  constructor(deps: LoadHoldDeps) {
    this.holds = new TabHolds(LOAD_HOLD_MS, deps.onExpired, deps.now);
  }

  /** tabs.onCreated / onUpdated with status 'loading'. A load already under way keeps its start, unless it expired. */
  onLoading(tabId: number): void {
    if (!this.holds.live(tabId)) this.holds.start(tabId);
  }

  /** tabs.onUpdated with status 'complete', and tabs.onRemoved / onReplaced. */
  onDone(tabId: number): void {
    this.holds.end(tabId);
  }

  /** PageLookup.loading: the tab is loading and its hold has not expired. */
  held(tab: TabSnap): boolean {
    if (tab.status !== 'loading') {
      this.holds.end(tab.id);
      return false;
    }
    // An expired hold stays known, so a page that never finishes loading is not held again.
    if (!this.holds.has(tab.id)) this.holds.start(tab.id);
    return this.holds.held(tab.id);
  }
}
