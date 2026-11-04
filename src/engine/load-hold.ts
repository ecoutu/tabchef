// Tabs whose page is still loading (chrome.tabs.Tab.status 'loading'): the planner holds them until the page has
// loaded, so a rule reading the final title (a ticket key in a PR title, which assigns a project) decides the tab's group,
// not its URL alone. Without the hold a tab joins its URL rule's group first and moves again once the title lands.
// A page that never finishes loading is held for LOAD_HOLD_MS at most. Memory only: after a worker restart a loading
// tab is held from when a pass first sees it.
import type { TabSnap } from '../core/types';

/** How long the planner holds a tab whose page is still loading. */
export const LOAD_HOLD_MS = 10_000;

export interface LoadHoldDeps {
  /** A hold expired with the page still loading: re-plan so the tab is grouped after all (background: reconciler.schedule). */
  onExpired: () => void;
  now?: () => number;
}

export class LoadHold {
  /** tabId → when its current load started. */
  private readonly since = new Map<number, number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly deps: LoadHoldDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** tabs.onCreated / onUpdated with status 'loading'. A load already under way keeps its start, unless it expired. */
  onLoading(tabId: number): void {
    const at = this.since.get(tabId);
    if (at === undefined || at + LOAD_HOLD_MS <= this.now()) {
      this.onDone(tabId);
      this.since.set(tabId, this.now());
    }
  }

  /** tabs.onUpdated with status 'complete', and tabs.onRemoved / onReplaced. */
  onDone(tabId: number): void {
    this.since.delete(tabId);
    const t = this.timers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(tabId);
  }

  /** PageLookup.loading: the tab is loading and its hold has not expired. */
  held(tab: TabSnap): boolean {
    if (tab.status !== 'loading') {
      this.onDone(tab.id);
      return false;
    }
    let at = this.since.get(tab.id);
    if (at === undefined) {
      at = this.now();
      this.since.set(tab.id, at);
    }
    const left = at + LOAD_HOLD_MS - this.now();
    if (left <= 0) return false;
    // Armed lazily, only for tabs the planner actually holds: on expiry the planner must look again.
    if (!this.timers.has(tab.id)) {
      this.timers.set(tab.id, setTimeout(() => {
        this.timers.delete(tab.id);
        this.deps.onExpired();
      }, left));
    }
    return true;
  }
}
