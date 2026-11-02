// Tab creation times for `age` conditions (R66, M3-R2..R4). Recorded from tabs.onCreated, mirrored to storage.session
// (key `tabAges`, `[tabId, at, exact][]`) so a restarted worker keeps them, and set on every snapshot as
// `TabSnap.created` (ChromePort's snapshot hook). A time that is not exact is a lower bound (the tab is at least that
// old): restored tabs, tabs created during the startup grace, and tabs first seen without an onCreated (browser
// restart, where session storage is cleared and tab ids are new; extension install / update / enable; a missed event).
import type { Snapshot, TabSnap } from '../core/types';

export const TAB_AGES_KEY = 'tabAges';
/** The 1-minute browser.alarms alarm that re-evaluates age conditions while a Program rule uses one (M3-R5). */
export const AGE_TICK_ALARM = 'age.tick';

export interface KeyValueArea { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> }
export type TabCreated = NonNullable<TabSnap['created']>;

export interface TabAgesDeps {
  session: KeyValueArea;
  now?: () => number;
  /** Whether time `at` falls in the browser-startup grace (background: DedupeHandler.inStartupGrace). */
  inStartupGrace: (at: number) => boolean;
  /** Settles once the grace is known (background: DedupeHandler.ready, the session marker read). Default: now. */
  graceReady?: Promise<unknown>;
}

const isEntry = (e: unknown): e is [number, number, boolean] =>
  Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number' && typeof e[2] === 'boolean';

export class TabAges {
  private readonly ages = new Map<number, TabCreated>();
  /** Tabs recorded by an event in this worker: kept even when a snapshot taken just before their onCreated lacks them. */
  private readonly live = new Set<number>();
  private readonly now: () => number;
  /** The stored map is loaded and the startup grace is known. Every event is applied after it, in order. */
  readonly ready: Promise<void>;

  constructor(private readonly deps: TabAgesDeps) {
    this.now = deps.now ?? Date.now;
    this.ready = Promise.all([this.load(), Promise.resolve(deps.graceReady).catch(() => {})]).then(() => {});
  }

  private async load(): Promise<void> {
    try {
      const stored = await this.deps.session.get(TAB_AGES_KEY);
      if (Array.isArray(stored)) for (const e of stored) if (isEntry(e)) this.ages.set(e[0], { at: e[1], exact: e[2] });
    } catch {
      /* start empty: every tab is first seen as a lower bound */
    }
  }

  private save(): void {
    const entries = [...this.ages].map(([id, c]) => [id, c.at, c.exact]);
    this.deps.session.set(TAB_AGES_KEY, entries).catch(() => {});
  }

  /** Apply a change once loaded (in event order); persist when it changed something. */
  private apply(fn: () => boolean): void {
    void this.ready.then(() => { if (fn()) this.save(); });
  }

  /** Wire to tabs.onCreated. Restored tabs (discarded / unloaded, or created in the startup grace) are not new. */
  onCreated(tab: { id?: number; discarded?: boolean; status?: string }): void {
    const id = tab.id;
    if (id === undefined) return;
    const at = this.now();
    const restored = !!tab.discarded || tab.status === 'unloaded';
    this.apply(() => {
      this.ages.set(id, { at, exact: !restored && !this.deps.inStartupGrace(at) });
      this.live.add(id);
      return true;
    });
  }

  /** Wire to tabs.onReplaced: the new tab id inherits the replaced tab's creation time. */
  onReplaced(added: number, removed: number): void {
    this.apply(() => {
      const c = this.ages.get(removed);
      this.live.delete(removed);
      if (c === undefined) return false;
      this.ages.delete(removed);
      this.ages.set(added, c);
      this.live.add(added);
      return true;
    });
  }

  /** Wire to tabs.onRemoved. */
  onRemoved(tabId: number): void {
    this.apply(() => {
      this.live.delete(tabId);
      return this.ages.delete(tabId);
    });
  }

  /**
   * A copy of `snap` with `created` set on every tab. A tab with no entry is first seen now, as a lower bound, and
   * recorded; stored ids not in the snapshot (and not recorded by an event in this worker) are pruned.
   */
  async annotate(snap: Snapshot): Promise<Snapshot> {
    await this.ready;
    let changed = false;
    const now = this.now();
    const ids = new Set(snap.tabs.map((t) => t.id));
    for (const id of [...this.ages.keys()]) {
      if (!ids.has(id) && !this.live.has(id)) changed = this.ages.delete(id) || changed;
    }
    const tabs = snap.tabs.map((t): TabSnap => {
      let c = this.ages.get(t.id);
      if (c === undefined) {
        c = { at: now, exact: false };
        this.ages.set(t.id, c);
        changed = true;
      }
      return { ...t, created: { ...c } };
    });
    if (changed) this.save();
    return { ...snap, tabs };
  }
}
