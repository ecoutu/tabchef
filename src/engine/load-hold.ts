// Tabs whose page is still loading (chrome.tabs.Tab.status 'loading'): the planner holds them until the page has
// loaded, so a rule reading the final title (a ticket key in a PR title, which assigns a project) decides the tab's group,
// not its URL alone. Without the hold a tab joins its URL rule's group first and moves again once the title lands.
// A page that never finishes loading is held for LOAD_HOLD_MS at most. Memory only: after a worker restart a loading
// tab is held from when a pass first sees it.
// In-page navigations (GitHub opening a PR from its list) report complete before the page sets its title: after a load
// with no real title yet, the hold goes on until one arrives (Chrome's URL placeholder doesn't count), TITLE_WAIT_MS
// at most.
import type { TabSnap } from '../core/types';
import { TabHolds } from './tab-holds';

/** How long the planner holds a tab whose page is still loading. */
export const LOAD_HOLD_MS = 10_000;
/** How long the planner keeps holding a loaded tab whose new title has not arrived (GitHub: ~0.5 s after complete). */
export const TITLE_WAIT_MS = 3_000;

export interface LoadHoldDeps {
  /** A hold expired with the page still loading: re-plan so the tab is grouped after all (background: reconciler.schedule). */
  onExpired: () => void;
  now?: () => number;
}

export class LoadHold {
  private readonly holds: TabHolds;
  /** Loaded tabs still waiting for the title of their new page. */
  private readonly titles: TabHolds;
  /** Tabs that got a real title since their current load started. */
  private readonly titled = new Set<number>();

  constructor(deps: LoadHoldDeps) {
    this.holds = new TabHolds(LOAD_HOLD_MS, deps.onExpired, deps.now);
    this.titles = new TabHolds(TITLE_WAIT_MS, deps.onExpired, deps.now);
  }

  /** tabs.onCreated / onUpdated with status 'loading'. A load already under way keeps its start, unless it expired. */
  onLoading(tabId: number): void {
    if (this.holds.live(tabId)) return;
    this.holds.start(tabId);
    this.titles.end(tabId);
    this.titled.delete(tabId);
  }

  /** tabs.onUpdated with status 'complete'. */
  onComplete(tabId: number): void {
    this.finish(tabId);
  }

  /**
   * tabs.onUpdated with a title. True when it ends a wait for the title (the caller re-plans now). Chrome's placeholder
   * (the URL without its scheme, before the page sets a title) is not the page's title.
   */
  onTitle(tabId: number, title: string, url?: string): boolean {
    if (title === '' || (url !== undefined && (title === url || title === url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')))) return false;
    this.titled.add(tabId);
    if (!this.titles.has(tabId)) return false;
    this.titles.end(tabId);
    return true;
  }

  /** tabs.onRemoved / onReplaced: every hold ends. */
  onDone(tabId: number): void {
    this.holds.end(tabId);
    this.titles.end(tabId);
    this.titled.delete(tabId);
  }

  /** PageLookup.loading: the tab is loading and its hold has not expired. */
  held(tab: TabSnap): boolean {
    if (tab.status !== 'loading') {
      this.finish(tab.id); // a snapshot can say complete before the complete event arrives
      return this.titles.held(tab.id);
    }
    // An expired hold stays known, so a page that never finishes loading is not held again.
    if (!this.holds.has(tab.id)) this.holds.start(tab.id);
    return this.holds.held(tab.id);
  }

  /** The load ended: without a real title yet (and within LOAD_HOLD_MS), wait for one. */
  private finish(tabId: number): void {
    if (!this.holds.has(tabId)) return;
    const waiting = this.holds.live(tabId) && !this.titled.has(tabId);
    this.holds.end(tabId);
    if (waiting) this.titles.start(tabId);
  }
}
