import { planGroups } from '../core/group/plan';
import type { Config, Op, Snapshot } from '../core/types';
import type { BrowserPort } from '../platform/browser-port';
import { DragRetryExhausted, withDragRetry } from '../platform/retry';
import { EXPECTATION_TTL_MS, loadState, saveState, type LiveState } from './state';

/** Structural why-log (Task 12 provides the real ring buffer). */
export interface WhyLog {
  add(e: { tabId?: number; ruleId?: string; action: string; detail: string; at: number }): void;
}

export interface ReconcilerOptions {
  debounceMs?: number;
  log?: WhyLog;
  isPaused?: () => boolean;
  now?: () => number;
}

const MAX_PASSES = 3;
const DRAG_FALLBACK_MS = 5000;

/**
 * Debounced engine loop: snapshot → planGroups → apply, re-planning until the planner is satisfied.
 * Flushes never overlap; a flush requested while one runs is queued (once) behind it.
 */
export class Reconciler {
  private readonly debounceMs: number;
  private state?: Promise<LiveState>;
  private timer?: ReturnType<typeof setTimeout>;
  private fallback?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private pendingAfterDrag = false;
  private readonly now: () => number;

  constructor(
    private readonly port: BrowserPort,
    private readonly getConfig: () => Promise<Config>,
    private readonly opts: ReconcilerOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.now = opts.now ?? Date.now;
  }

  schedule(reason: string): void {
    void reason;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  flush(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.flushOnce();
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** tabs.onUpdated with a groupId change. A tab leaving a managed group that Tabchef didn't move was dragged out. */
  async onTabGroupChanged(tabId: number, newGroupId: number): Promise<void> {
    const st = await this.load();
    const prev = st.managedTabs.get(tabId);
    if (newGroupId !== -1 && new Set(st.managedTabs.values()).has(newGroupId)) st.managedTabs.set(tabId, newGroupId);
    else st.managedTabs.delete(tabId);
    this.pruneExpectations(st);
    const i = st.expectedGroupChanges.findIndex(([id]) => id === tabId);
    if (i >= 0) {
      st.expectedGroupChanges.splice(i, 1);
    } else if (newGroupId === -1 && prev !== undefined) {
      st.leaveAlone.add(tabId);
      this.log({ tabId, action: 'leave-alone', detail: `user moved tab out of group ${prev}` });
    }
    await saveState(st);
  }

  async onTabUrlChanged(tabId: number): Promise<void> {
    const st = await this.load();
    if (st.leaveAlone.delete(tabId)) await saveState(st);
  }

  /** tabs.onMoved / onAttached: a drag just ended, so retry a reconcile that gave up on a drag lock. */
  onTabMovedOrAttached(): void {
    if (!this.pendingAfterDrag) return;
    this.clearPendingDrag();
    this.schedule('after-drag');
  }

  private load(): Promise<LiveState> {
    this.state ??= loadState();
    return this.state;
  }

  private log(e: { tabId?: number; action: string; detail: string }): void {
    this.opts.log?.add({ ...e, at: Date.now() });
  }

  private clearPendingDrag(): void {
    this.pendingAfterDrag = false;
    if (this.fallback !== undefined) clearTimeout(this.fallback);
    this.fallback = undefined;
  }

  private async flushOnce(): Promise<void> {
    if (this.opts.isPaused?.()) return;
    const st = await this.load();
    this.clearPendingDrag();
    try {
      const config = await this.getConfig();
      for (let pass = 0; ; pass++) {
        const snap = await this.port.snapshot();
        this.track(snap, st);
        const ops = planGroups(snap, config, st);
        if (ops.length === 0) break;
        if (pass === MAX_PASSES) {
          this.log({ action: 'reconcile-not-converged', detail: `${ops.length} op(s) still planned after ${MAX_PASSES} passes` });
          break;
        }
        for (const op of ops) await this.apply(op, snap, st);
      }
    } catch (e) {
      if (e instanceof DragRetryExhausted) {
        this.pendingAfterDrag = true;
        this.fallback = setTimeout(() => {
          this.fallback = undefined;
          if (!this.pendingAfterDrag) return;
          this.pendingAfterDrag = false;
          this.schedule('after-drag-fallback');
        }, DRAG_FALLBACK_MS);
        this.log({ action: 'drag-retry-exhausted', detail: `${e.message}; waiting for the drag to end` });
      } else {
        this.log({ action: 'reconcile-error', detail: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      this.pruneExpectations(st);
      await saveState(st);
    }
  }

  private pruneExpectations(st: LiveState): void {
    const t = this.now();
    st.expectedGroupChanges = st.expectedGroupChanges.filter(([, exp]) => exp > t);
  }

  private track(snap: Snapshot, st: LiveState): void {
    const managed = new Set(snap.groups.filter((g) => st.managedTitles.has(g.title)).map((g) => g.id));
    st.managedTabs = new Map(snap.tabs.filter((t) => managed.has(t.groupId)).map((t) => [t.id, t.groupId]));
    const alive = new Set(snap.tabs.map((t) => t.id));
    for (const id of st.leaveAlone) if (!alive.has(id)) st.leaveAlone.delete(id);
  }

  /** Marks a group as Tabchef's; `tabIds` (if given) are now known members of it. */
  private adopt(st: LiveState, groupId: number, title: string | undefined, tabIds: number[] = []): void {
    if (title === undefined) return;
    st.managedTitles.add(title);
    for (const id of tabIds) st.managedTabs.set(id, groupId);
  }

  private expect(st: LiveState, tabIds: number[]): void {
    const exp = this.now() + EXPECTATION_TTL_MS;
    for (const id of tabIds) st.expectedGroupChanges.push([id, exp]);
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return withDragRetry(fn);
  }

  private async apply(op: Op, snap: Snapshot, st: LiveState): Promise<void> {
    const titleOf = (gid: number) => snap.groups.find((g) => g.id === gid)?.title;
    switch (op.kind) {
      case 'group': {
        this.expect(st, op.tabIds);
        const { windowId, title, color } = op;
        let gid: number;
        if (op.existingGroupId !== undefined) {
          const groupId = op.existingGroupId;
          gid = await this.call(() => this.port.group(op.tabIds, { groupId, windowId }));
        } else {
          gid = await this.call(() => this.port.group(op.tabIds, { windowId }));
          const p = op.collapsed === undefined ? { title, color } : { title, color, collapsed: op.collapsed };
          await this.call(() => this.port.updateGroup(gid, p));
          const key = `${windowId}|${title}`;
          if (!st.creationOrder.has(key)) st.creationOrder.set(key, Math.max(0, ...st.creationOrder.values()) + 1);
        }
        this.adopt(st, gid, title, op.tabIds);
        return;
      }
      case 'ungroup':
        this.expect(st, op.tabIds);
        await this.call(() => this.port.ungroup(op.tabIds));
        for (const id of op.tabIds) st.managedTabs.delete(id);
        return;
      case 'moveTabs':
        // Moving ungroups the tabs (one event), regrouping into the home group fires another.
        this.expect(st, [...op.tabIds, ...op.tabIds]);
        await this.call(() => this.port.moveTabs(op.tabIds, op.windowId, -1));
        await this.call(() => this.port.group(op.tabIds, { groupId: op.groupId, windowId: op.windowId }));
        this.adopt(st, op.groupId, titleOf(op.groupId), op.tabIds);
        return;
      case 'moveGroup':
        await this.call(() => this.port.moveGroup(op.groupId, op.index));
        this.adopt(st, op.groupId, titleOf(op.groupId));
        return;
      case 'updateGroup': {
        const p = { ...(op.color !== undefined && { color: op.color }), ...(op.collapsed !== undefined && { collapsed: op.collapsed }) };
        await this.call(() => this.port.updateGroup(op.groupId, p));
        this.adopt(st, op.groupId, titleOf(op.groupId));
        return;
      }
      default:
        return; // closeTab/focusTab belong to dedupe, not the group planner
    }
  }
}
