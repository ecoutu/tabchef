import { planGroups, planTargets, syncCreationOrder, type PageLookup, type PlanContext, type Targets } from '../core/group/plan';
import type { Op, Snapshot } from '../core/types';
import type { Program } from '../core/lang/types';
import type { BrowserPort } from '../platform/browser-port';
import { DragRetryExhausted, withDragRetry } from '../platform/retry';
import { anchorLeaveAlone, type AnchorService } from './anchors';
import { EXPECTATION_TTL_MS, loadState, saveState, type LiveState } from './state';

/** Structural why-log (Task 12 provides the real ring buffer). */
export interface WhyLog {
  add(e: { tabId?: number; ruleId?: string; action: string; detail: string; at: number }): void;
}

export interface ReconcilerOptions {
  debounceMs?: number;
  log?: WhyLog;
  isPaused?: () => boolean;
  /** Awaited before each run, ahead of the pause check (e.g. SafetyService.ready). */
  beforeRun?: () => Promise<void>;
  /** Tab ids (e.g. locked tabs) merged into the planner's leaveAlone at plan time; never persisted. */
  extraLeaveAlone?: () => Iterable<number>;
  /** Page facts per tab (background PageFacts, M2 T7): page conditions and selector extracts, and the page hold. */
  pageFacts?: PageLookup;
  now?: () => number;
  /** Anchor tabs (M2 T11): told about every group this reconciler creates (never adopted ones, ruling R9). */
  anchors?: Pick<AnchorService, 'onGroupCreated'>;
  /** Console-level warnings (a rule whose color renders outside Chrome's 9 colors). Default: console.warn. */
  warn?: (message: string) => void;
}

const MAX_PASSES = 3;
/** Consecutive non-drag failures after which a pending retitle is given up. */
const MAX_RETITLE_FAILURES = 3;
/** Marks an expectation an event already consumed. */
const CONSUMED = -1;

const withoutFragment = (url: string): string => {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
};
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
  /** Rule keys already warned about an invalid rendered color (once per key, not per tab). */
  private readonly warnedColor = new Set<string>();

  constructor(
    private readonly port: BrowserPort,
    /** The shared compiled Program (background ProgramCache.get, ruling R4). */
    private readonly getProgram: () => Promise<Program>,
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

  /**
   * tabs.onUpdated with a groupId change. A tab leaving a managed group that Tabchef didn't move was dragged out.
   * `url` (the tab's current URL) lets a later fragment-only change keep it left alone.
   */
  async onTabGroupChanged(tabId: number, newGroupId: number, url?: string): Promise<void> {
    const st = await this.load();
    const prev = st.managedTabs.get(tabId);
    if (newGroupId !== -1 && new Set(st.managedTabs.values()).has(newGroupId)) st.managedTabs.set(tabId, newGroupId);
    else st.managedTabs.delete(tabId);
    this.pruneExpectations(st);
    const i = st.expectedGroupChanges.findIndex(([id]) => id === tabId);
    if (i >= 0) {
      const [hit] = st.expectedGroupChanges.splice(i, 1) as [[number, number]];
      hit[1] = CONSUMED; // a pending refresh-at-resolve must not resurrect it
    } else if (newGroupId === -1 && prev !== undefined) {
      st.leaveAlone.add(tabId);
      if (url !== undefined) st.leaveAloneUrls.set(tabId, withoutFragment(url));
      this.log({ tabId, action: 'leave-alone', detail: `user moved tab out of group ${prev}` });
    }
    await saveState(st);
  }

  /** A navigation ends leave-alone; a change of only the #fragment does not (when the previous URL is known). */
  async onTabUrlChanged(tabId: number, url?: string): Promise<void> {
    const st = await this.load();
    if (!st.leaveAlone.has(tabId)) return;
    const prev = st.leaveAloneUrls.get(tabId);
    if (url !== undefined && prev !== undefined && withoutFragment(url) === prev) return;
    st.leaveAlone.delete(tabId);
    st.leaveAloneUrls.delete(tabId);
    await saveState(st);
  }

  /** tabs.onMoved / onAttached: a drag just ended, so retry a reconcile that gave up on a drag lock. */
  onTabMovedOrAttached(): void {
    if (!this.pendingAfterDrag) return;
    this.clearPendingDrag();
    this.schedule('after-drag');
  }

  /** The live runtime state, shared with the AnchorService (anchors live in RuntimeState). */
  liveState(): Promise<LiveState> {
    return this.load();
  }

  private load(): Promise<LiveState> {
    this.state ??= loadState();
    return this.state;
  }

  private log(e: { tabId?: number; ruleId?: string; action: string; detail: string }): void {
    this.opts.log?.add({ ...e, at: Date.now() });
  }

  private clearPendingDrag(): void {
    this.pendingAfterDrag = false;
    if (this.fallback !== undefined) clearTimeout(this.fallback);
    this.fallback = undefined;
  }

  private async flushOnce(): Promise<void> {
    await this.opts.beforeRun?.();
    if (this.opts.isPaused?.()) return;
    const st = await this.load();
    this.clearPendingDrag();
    try {
      const program = await this.getProgram();
      await this.retitlePending(st);
      for (let pass = 0; ; pass++) {
        const snap = await this.port.snapshot();
        // Locked tabs and anchors still at their anchor URL (R21: strict would ungroup an anchor outside the rule).
        const extra = [...(this.opts.extraLeaveAlone?.() ?? []), ...anchorLeaveAlone(st.anchors, snap, program)];
        const ctx: PlanContext = extra.length ? { ...st, leaveAlone: new Set([...st.leaveAlone, ...extra]) } : st;
        const pre = planTargets(snap, program, ctx, this.now(), this.opts.pageFacts); // once per pass, shared by tracking and planning
        this.warnInvalidColors(pre);
        this.track(snap, st, pre, pass === 0);
        const ops = planGroups(snap, program, ctx, pre);
        if (ops.length === 0) break;
        if (pass === MAX_PASSES) {
          this.log({ action: 'reconcile-not-converged', detail: `${ops.length} op(s) still planned after ${MAX_PASSES} passes` });
          break;
        }
        for (const op of ops) await this.apply(op, snap, st, program, pre);
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

  /** evaluateTab flags a color that rendered outside Chrome's colors (grey is used); warn once per rule key. */
  private warnInvalidColors(pre: Targets): void {
    for (const m of pre.matches.values()) {
      if (!m.invalidColor || this.warnedColor.has(m.key)) continue;
      this.warnedColor.add(m.key);
      (this.opts.warn ?? console.warn)(`[tabchef] rule ${m.key}: group color is not a Chrome color; using grey`);
    }
  }

  private pruneExpectations(st: LiveState): void {
    const t = this.now();
    st.expectedGroupChanges = st.expectedGroupChanges.filter(([, exp]) => exp > t);
  }

  /**
   * Membership tracking uses the planner's managed-group definition, so groups restored by the browser (no session
   * state) are tracked too; restored groups also get creation numbers in their current tab-strip order.
   */
  private track(snap: Snapshot, st: LiveState, pre: Targets, firstPass: boolean): void {
    const { managed } = pre;
    st.managedTabs = new Map(snap.tabs.filter((t) => managed.has(t.groupId)).map((t) => [t.id, t.groupId]));
    syncCreationOrder(snap, managed, st.creationOrder, {
      pendingTitles: [...st.pendingTitles.values()].map((p) => p.title), absent: st.creationAbsent, count: firstPass,
    });
    const urls = new Map(snap.tabs.map((t) => [t.id, t.url]));
    for (const id of st.leaveAlone) {
      const url = urls.get(id);
      if (url === undefined) st.leaveAlone.delete(id);
      else if (!st.leaveAloneUrls.has(id)) st.leaveAloneUrls.set(id, withoutFragment(url));
    }
    for (const id of st.leaveAloneUrls.keys()) if (!st.leaveAlone.has(id)) st.leaveAloneUrls.delete(id);
  }

  /**
   * Titles groups Tabchef created whose title call failed; drops entries for groups that are gone or now titled.
   * A non-drag failure is logged and never blocks planning; the entry is dropped after MAX_RETITLE_FAILURES in a row.
   * A drag lock still aborts the flush (it is retried when the drag ends).
   */
  private async retitlePending(st: LiveState): Promise<void> {
    for (const gid of st.retitleFailures.keys()) if (!st.pendingTitles.has(gid)) st.retitleFailures.delete(gid);
    if (st.pendingTitles.size === 0) return;
    const snap = await this.port.snapshot();
    for (const [gid, p] of [...st.pendingTitles]) {
      const g = snap.groups.find((x) => x.id === gid);
      if (g && g.title === '') {
        try {
          await this.call(() => this.port.updateGroup(gid, p));
        } catch (e) {
          if (e instanceof DragRetryExhausted) throw e;
          const n = (st.retitleFailures.get(gid) ?? 0) + 1;
          const giveUp = n >= MAX_RETITLE_FAILURES;
          this.log({
            action: 'retitle-failed',
            detail: `Could not title group ${gid} "${p.title}" (${e instanceof Error ? e.message : String(e)})${giveUp ? '; giving up' : ''}`,
          });
          if (giveUp) { st.pendingTitles.delete(gid); st.retitleFailures.delete(gid); } else st.retitleFailures.set(gid, n);
          continue;
        }
        this.adopt(st, gid, p.title);
      }
      st.pendingTitles.delete(gid);
      st.retitleFailures.delete(gid);
    }
  }

  /** Marks a group as Tabchef's; `tabIds` (if given) are now known members of it. */
  private adopt(st: LiveState, groupId: number, title: string | undefined, tabIds: number[] = []): void {
    if (title === undefined) return;
    st.managedTitles.add(title);
    for (const id of tabIds) st.managedTabs.set(id, groupId);
  }

  /** Records expected group-change events; returns them so the window can restart when the call resolves. */
  private expect(st: LiveState, tabIds: number[]): [number, number][] {
    const exp = this.now() + EXPECTATION_TTL_MS;
    const added = tabIds.map((id): [number, number] => [id, exp]);
    st.expectedGroupChanges.push(...added);
    return added;
  }

  /**
   * The browser fires the events after the call resolves, which can be seconds after it was issued (drag retries):
   * restart each unconsumed expectation's window now (re-adding it if it was pruned meanwhile).
   */
  private refresh(st: LiveState, expected: [number, number][]): void {
    const exp = this.now() + EXPECTATION_TTL_MS;
    for (const e of expected) {
      if (e[1] === CONSUMED) continue;
      e[1] = exp;
      if (!st.expectedGroupChanges.includes(e)) st.expectedGroupChanges.push(e);
    }
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return withDragRetry(fn);
  }

  private ruleName(p: Program, ruleId: string | undefined): string | undefined {
    if (ruleId === undefined) return undefined;
    // ruleId is a rule key (R19); M1 why-log entries may still hold a bare id.
    return p.rules.find((r) => r.key === ruleId)?.rule.name || ruleId;
  }

  /** One why-log entry per tab that really joined `title` (tabs already in a group of that title are skipped). */
  private logJoined(snap: Snapshot, p: Program, tabIds: number[], title: string, ruleId: string | undefined): void {
    const name = this.ruleName(p, ruleId);
    for (const tabId of tabIds) {
      const from = snap.tabs.find((t) => t.id === tabId)?.groupId ?? -1;
      if (from !== -1 && snap.groups.find((g) => g.id === from)?.title === title) continue;
      this.log({ tabId, ...(ruleId !== undefined && { ruleId }), action: 'grouped', detail: `Moved to ${title}${name ? ` by rule ${name}` : ''}` });
    }
  }

  /** A group was just created (not adopted): open its anchors (rendered by the rule for the tabs that formed it). */
  private async openAnchors(op: Extract<Op, { kind: 'group' }>, gid: number, snap: Snapshot, st: LiveState, program: Program, pre: Targets): Promise<void> {
    if (!this.opts.anchors) return;
    const m = op.tabIds.map((id) => pre.matches.get(id))
      .find((x) => x !== undefined && x.title === op.title && (op.ruleId === undefined || x.ruleId === op.ruleId));
    if (!m || m.anchors.length === 0) return;
    const more = await this.opts.anchors.onGroupCreated(st, {
      groupId: gid, windowId: op.windowId, title: op.title, color: op.color, tabIds: op.tabIds, urls: m.anchors,
      ...(op.ruleId !== undefined && { ruleId: op.ruleId }),
    }, snap, program);
    for (const o of more) await this.apply(o, snap, st, program, pre);
  }

  private async apply(op: Op, snap: Snapshot, st: LiveState, program: Program, pre: Targets): Promise<void> {
    const titleOf = (gid: number) => snap.groups.find((g) => g.id === gid)?.title;
    switch (op.kind) {
      case 'group': {
        const expected = this.expect(st, op.tabIds);
        const { windowId, title, color } = op;
        let gid: number;
        if (op.existingGroupId !== undefined) {
          const groupId = op.existingGroupId;
          gid = await this.call(() => this.port.group(op.tabIds, { groupId, windowId }));
          this.refresh(st, expected);
        } else {
          gid = await this.call(() => this.port.group(op.tabIds, { windowId }));
          this.refresh(st, expected);
          const p = op.collapsed === undefined ? { title, color } : { title, color, collapsed: op.collapsed };
          const key = `${windowId}|${title}`;
          if (!st.creationOrder.has(key)) st.creationOrder.set(key, Math.max(0, ...st.creationOrder.values()) + 1);
          // Until the title lands the group is untitled (never managed); remember it so the next flush can title it.
          st.pendingTitles.set(gid, p);
          await this.call(() => this.port.updateGroup(gid, p));
          st.pendingTitles.delete(gid);
        }
        this.adopt(st, gid, title, op.tabIds);
        this.logJoined(snap, program, op.tabIds, title, op.ruleId);
        if (op.existingGroupId === undefined) await this.openAnchors(op, gid, snap, st, program, pre);
        return;
      }
      case 'ungroup': {
        const expected = this.expect(st, op.tabIds);
        await this.call(() => this.port.ungroup(op.tabIds));
        this.refresh(st, expected);
        for (const id of op.tabIds) st.managedTabs.delete(id);
        const name = this.ruleName(program, op.ruleId);
        for (const tabId of op.tabIds) {
          const gid = snap.tabs.find((t) => t.id === tabId)?.groupId ?? -1;
          const from = gid === -1 ? undefined : titleOf(gid);
          this.log({
            tabId, ...(op.ruleId !== undefined && { ruleId: op.ruleId }), action: 'ungrouped',
            detail: `Removed from ${from ?? 'group'} (no longer matches ${name ?? 'any rule'})`,
          });
        }
        return;
      }
      case 'moveTabs': {
        // Moving ungroups the tabs (one event), regrouping into the home group fires another.
        const expected = this.expect(st, [...op.tabIds, ...op.tabIds]);
        await this.call(() => this.port.moveTabs(op.tabIds, op.windowId, -1));
        this.refresh(st, expected);
        await this.call(() => this.port.group(op.tabIds, { groupId: op.groupId, windowId: op.windowId }));
        this.refresh(st, expected);
        const title = titleOf(op.groupId);
        this.adopt(st, op.groupId, title, op.tabIds);
        if (title !== undefined) this.logJoined(snap, program, op.tabIds, title, op.ruleId);
        return;
      }
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
