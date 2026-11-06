// The projects' closed-time clock (M3 T15): browser running time each project spends without an open tab
// (`Project.closedFor`), kept across MV3 worker restarts in storage.session; drives the startup prune.
import type { Project } from '../core/projects/types';
import type { Snapshot } from '../core/types';

/** Projects with no open tab for this long (browser running time) are pruned on startup. */
export const PRUNE_AFTER_MS = 7 * 24 * 3600_000;
/** Closed time is added to the store at most this often (pruning works in days). */
const CLOSED_FLUSH_MS = 3600_000;
/** At most this much closed time is counted between two passes (the browser may not have been running). */
const MAX_TICK_MS = 15 * 60_000;
export const CLOSED_CLOCK_KEY = 'projects.closedClock';
/** The last pass that saw open tabs, and closed time per project not yet added to its stored `closedFor`. */
interface ClosedClock { lastTick?: number; pending: Record<string, number> }
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

export class ProjectClock {
  private pruned = false;

  constructor(
    private readonly session: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> } | undefined,
    private readonly now: () => number,
  ) {}

  /**
   * Counts browser running time without an open tab per project (`closedFor`), only between passes that see open
   * tabs (a snapshot before session restore counts nothing), at most MAX_TICK_MS per gap. The clock (last tick and
   * pending time) is kept in storage.session, so it runs across worker restarts and stops with the browser; pending
   * time is added to the store hourly. The first such pass of a worker returns the projects closed for PRUNE_AFTER_MS.
   * A kept project (`keep`, M4 T7) is never pruned and counts no closed time, like an open one.
   */
  async closedTime(snap: Snapshot, projects: Project[], open: Set<string>, changed: Set<Project>): Promise<string[]> {
    if (snap.tabs.length === 0) return [];
    const now = this.now();
    const clock = await this.readClock();
    const dt = clock.lastTick === undefined ? 0 : Math.min(Math.max(0, now - clock.lastTick), MAX_TICK_MS);
    const pending: Record<string, number> = {};
    for (const p of projects) {
      if (open.has(p.id) || p.keep) {
        if (p.closedFor !== undefined) { delete p.closedFor; changed.add(p); }
        continue;
      }
      const ms = (clock.pending[p.id] ?? 0) + dt;
      if (ms < CLOSED_FLUSH_MS) { if (ms > 0) pending[p.id] = ms; continue; }
      p.closedFor = (p.closedFor ?? 0) + ms;
      changed.add(p);
    }
    const next: ClosedClock = { lastTick: now, pending };
    if (JSON.stringify(next) !== JSON.stringify(clock)) await this.writeClock(next); // unchanged: no session write
    if (this.pruned) return [];
    this.pruned = true;
    return projects.filter((p) => !open.has(p.id) && !p.keep && (p.closedFor ?? 0) + (pending[p.id] ?? 0) >= PRUNE_AFTER_MS).map((p) => p.id);
  }

  private memoryClock: ClosedClock = { pending: {} };
  private async readClock(): Promise<ClosedClock> {
    if (!this.session) return this.memoryClock;
    try {
      const v = await this.session.get(CLOSED_CLOCK_KEY);
      if (isObj(v) && isObj(v.pending)) {
        const pending = Object.fromEntries(Object.entries(v.pending).filter((e): e is [string, number] => typeof e[1] === 'number'));
        this.memoryClock = { ...(typeof v.lastTick === 'number' && { lastTick: v.lastTick }), pending };
      } else this.memoryClock = { pending: {} };
    } catch (e) {
      // The last clock this worker read or wrote: a fresh one would overwrite the stored pending time on the next write.
      console.warn('[tabchef] project clock read failed', e);
    }
    return this.memoryClock;
  }
  private async writeClock(c: ClosedClock): Promise<void> {
    this.memoryClock = c;
    await this.session?.set(CLOSED_CLOCK_KEY, c).catch((e: unknown) => console.warn('[tabchef] project clock write failed', e));
  }
}
