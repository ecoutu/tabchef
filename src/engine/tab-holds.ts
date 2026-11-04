// Per-tab planner holds with a deadline (PageFacts: page facts on their way; LoadHold: a page still loading). A hold
// lasts from `start` until `end` or `ms` later. The expiry timer is armed lazily, only for holds the planner asked about,
// and calls `onExpired` so the planner looks again. An expired hold stays known (`has`) until it ends or starts again.
// Memory only.

export class TabHolds {
  /** tabId → when its hold started. */
  private readonly since = new Map<number, number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ms: number,
    private readonly onExpired: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts (or restarts) the tab's hold now. */
  start(tabId: number): void {
    this.end(tabId);
    this.since.set(tabId, this.now());
  }

  end(tabId: number): void {
    this.since.delete(tabId);
    const t = this.timers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(tabId);
  }

  /** A hold was started and has not ended (it may have expired). */
  has(tabId: number): boolean {
    return this.since.has(tabId);
  }

  /** The hold has not expired yet. Arms no timer. */
  live(tabId: number): boolean {
    return this.left(tabId) > 0;
  }

  /** The planner holds the tab: its hold has not expired. Arms the expiry timer. */
  held(tabId: number): boolean {
    const left = this.left(tabId);
    if (left <= 0) return false;
    if (!this.timers.has(tabId)) {
      this.timers.set(tabId, setTimeout(() => {
        this.timers.delete(tabId);
        this.onExpired();
      }, left));
    }
    return true;
  }

  private left(tabId: number): number {
    const at = this.since.get(tabId);
    return at === undefined ? 0 : at + this.ms - this.now();
  }
}
