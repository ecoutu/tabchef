import { dryRunGroupTabs, planGroups, planTargets, syncCreationOrder, type PageLookup, type PlanContext, type Targets } from '../core/group/plan';
import type { GroupTarget } from '../core/group/evaluate';
import type { Op, Snapshot } from '../core/types';
import type { Program, TabFacts } from '../core/lang/types';
import type { PreviewContext } from '../core/lang/preview';
import { hasDryRun, isDryRunRule, liveProgram } from '../core/lang/dry-run';
import type { BrowserPort } from '../platform/browser-port';
import { DragRetryExhausted, withDragRetry } from '../platform/retry';
import { anchorLeaveAlone, type AnchorService } from './anchors';
import { EXPECTATION_TTL_MS, loadState, saveState, type LiveState } from './state';

/** Structural why-log (Task 12 provides the real ring buffer). */
export interface WhyLog {
  add(e: { tabId?: number; ruleId?: string; action: string; detail: string; at: number; dryRun?: true }): void;
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
  /** Source data per tab (background SourceService, M3 T11): `TabFacts.source` for the planner. */
  sources?: { factsFor(tabId: number, url?: string): TabFacts['source'] };
  now?: () => number;
  /** Anchor tabs (M2 T11): told about every group this reconciler creates (never adopted ones, ruling R9). */
  anchors?: Pick<AnchorService, 'onGroupCreated'>;
  /**
   * Project targets (M3 T15, ProjectService): per-tab group targets from outside the rule language, planned as
   * PlanContext.overrides (M3-R39/R66). `targets` (live, dry-run rules fall through) once per live pass with that
   * pass's snapshot; `previewTargets` (no side effects) for the dry-run pass (full Program) and previews.
   */
  projects?: {
    targets(snap: Snapshot): Promise<Map<number, GroupTarget | null>>;
    previewTargets(snap: Snapshot, program: Program): Promise<Map<number, GroupTarget | null>>;
  };
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
  /**
   * would-* entries planned by the last dry-run pass, by (tab, rule, target): logged once while they stay planned
   * (unapplied ops never converge, so every flush plans them again). Memory only.
   */
  private wouldSeen = new Set<string>();
  /** What the planner reads per tab: page facts (opts.pageFacts) and source data (opts.sources). */
  private readonly facts?: PageLookup;

  constructor(
    private readonly port: BrowserPort,
    /** The shared compiled Program (background ProgramCache.get, ruling R4). */
    private readonly getProgram: () => Promise<Program>,
    private readonly opts: ReconcilerOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.now = opts.now ?? Date.now;
    const { pageFacts, sources } = opts;
    this.facts = !sources ? pageFacts : {
      get: (id) => pageFacts?.get(id),
      awaiting: (id) => pageFacts?.awaiting(id) ?? false,
      source: (id, url) => sources.factsFor(id, url),
    };
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

  /**
   * Read-only planner context for previews (M2 T13): copies of leave-alone (plus locked tabs and anchors at their URL,
   * as each flush adds them), managed titles, creation order and dismissed anchor groups. R49's per-program dry-run
   * leave-alone is not included: previewChange adds it for each Program it plans.
   */
  async planContext(snap: Snapshot, program: Program): Promise<PreviewContext> {
    const st = await this.load();
    // Project tabs keep their project group in the preview as in the engine (M3-R39); computed without side effects.
    const overrides = await this.previewOverrides(snap, program);
    return {
      leaveAlone: new Set([...st.leaveAlone, ...this.extraLeaveAlone(st, snap, program)]),
      managedTitles: new Set(st.managedTitles),
      creationOrder: new Map(st.creationOrder),
      anchorsDismissed: new Set(st.anchorsDismissed),
      ...(overrides?.size && { overrides }),
    };
  }

  /**
   * The project overrides a preview plans `program` with (M3-R39): side-effect free, over its live rules. A failure
   * (e.g. the project store cannot be read) previews without them rather than failing the preview.
   */
  async previewOverrides(snap: Snapshot, program: Program): Promise<Map<number, GroupTarget | null> | undefined> {
    try {
      return await this.opts.projects?.previewTargets(snap, liveProgram(program));
    } catch (e) {
      (this.opts.warn ?? console.warn)(`[tabchef] project targets for the preview failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /** Locked tabs and anchors still at their anchor URL (R21: strict would ungroup an anchor outside the rule). */
  private extraLeaveAlone(st: LiveState, snap: Snapshot, program: Program): number[] {
    return [...(this.opts.extraLeaveAlone?.() ?? []), ...anchorLeaveAlone(st.anchors, snap, program)];
  }

  private load(): Promise<LiveState> {
    this.state ??= loadState();
    return this.state;
  }

  private log(e: { tabId?: number; ruleId?: string; action: string; detail: string; dryRun?: true }): void {
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
      const ctxOf = (snap: Snapshot): PlanContext => {
        // R49 (per-rule dry run only): a dry-run rule's existing group is left alone, by both passes.
        const extra = [...this.extraLeaveAlone(st, snap, program),
          ...(program.dryRun ? [] : dryRunGroupTabs(snap, program, this.now(), this.facts))];
        return extra.length ? { ...st, leaveAlone: new Set([...st.leaveAlone, ...extra]) } : st;
      };
      const withOverrides = (ctx: PlanContext, overrides: Map<number, GroupTarget | null> | undefined): PlanContext =>
        (overrides?.size ? { ...ctx, overrides } : ctx);
      // The dry-run pass plans project targets of the full Program (dry-run assignProject rules included, R10), with
      // no side effects: under global dry run (R50) no project is stored and no join is logged.
      const dryRun = async (snap: Snapshot, ctx: PlanContext): Promise<void> => {
        if (!hasDryRun(program)) { this.dryRunPass(snap, program, ctx); return; }
        this.dryRunPass(snap, program, withOverrides(ctx, await this.opts.projects?.previewTargets(snap, program)));
      };
      // Global dry run (R50): engine-initiated changes are only logged. User-initiated actions (popup close / close-all,
      // banner choices, undo) still apply: they go through their own handlers, not this loop.
      if (program.dryRun) {
        const snap = await this.port.snapshot();
        await dryRun(snap, ctxOf(snap));
        return;
      }
      // Dry-run rules fall through (R48): the live pass plans as if they did not exist.
      const live = liveProgram(program);
      await this.retitlePending(st);
      for (let pass = 0; ; pass++) {
        const snap = await this.port.snapshot();
        const base = ctxOf(snap);
        const ctx = withOverrides(base, await this.opts.projects?.targets(snap));
        const pre = planTargets(snap, live, ctx, this.now(), this.facts); // once per pass, shared by tracking and planning
        this.warnInvalidColors(pre);
        this.track(snap, st, pre, pass === 0);
        const ops = planGroups(snap, live, ctx, pre);
        if (ops.length === 0 || pass === MAX_PASSES) {
          if (ops.length) this.log({ action: 'reconcile-not-converged', detail: `${ops.length} op(s) still planned after ${MAX_PASSES} passes` });
          await dryRun(snap, base);
          break;
        }
        for (const op of ops) await this.apply(op, snap, st, live, pre);
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

  /**
   * R10: what dry-run rules would do, planned over the full Program on the same snapshot as the live pass, and logged
   * (never applied) as would-group / would-ungroup, once per (tab, rule, target) while it stays planned. Per-rule dry
   * run reports only ops of dry-run rules; global dry run (`program.dryRun`) reports every op. Anchors a dry-run group
   * would open are skipped (not logged). Changes no state: dry-run titles are never adopted or tracked.
   */
  private dryRunPass(snap: Snapshot, program: Program, ctx: PlanContext): void {
    if (!hasDryRun(program)) { this.wouldSeen.clear(); return; }
    const global = program.dryRun === true;
    const pre = planTargets(snap, program, ctx, this.now(), this.facts);
    const ops = planGroups(snap, program, ctx, pre);
    const reported = (ruleId: string | undefined): boolean => global || isDryRunRule(program, ruleId);
    const titleOf = (gid: number) => snap.groups.find((g) => g.id === gid)?.title;
    const seen = new Set<string>();
    const would = (k: string, e: { tabId?: number; ruleId?: string; action: string; detail: string }): void => {
      seen.add(k);
      if (!this.wouldSeen.has(k)) this.log({ ...e, dryRun: true });
    };
    const joined = (tabIds: number[], windowId: number, title: string, ruleId: string | undefined): void => {
      const name = this.ruleName(program, ruleId);
      for (const tabId of tabIds) {
        const from = snap.tabs.find((t) => t.id === tabId)?.groupId ?? -1;
        if (from !== -1 && titleOf(from) === title) continue;
        would(`${tabId}|${ruleId ?? ''}|group|${windowId}|${title}`, {
          tabId, ...(ruleId !== undefined && { ruleId }), action: 'would-group',
          detail: `Would move to ${title}${name ? ` by rule ${name}` : ''} (dry run)`,
        });
      }
    };
    for (const op of ops) {
      switch (op.kind) {
        case 'group':
          if (reported(op.ruleId)) joined(op.tabIds, op.windowId, op.title, op.ruleId);
          break;
        case 'moveTabs': {
          const title = titleOf(op.groupId);
          if (reported(op.ruleId) && title !== undefined) joined(op.tabIds, op.windowId, title, op.ruleId);
          break;
        }
        case 'ungroup': {
          if (!reported(op.ruleId)) break;
          const name = this.ruleName(program, op.ruleId);
          for (const tabId of op.tabIds) {
            const gid = snap.tabs.find((t) => t.id === tabId)?.groupId ?? -1;
            const from = gid === -1 ? undefined : titleOf(gid);
            would(`${tabId}|${op.ruleId ?? ''}|ungroup|${gid}`, {
              tabId, ...(op.ruleId !== undefined && { ruleId: op.ruleId }), action: 'would-ungroup',
              detail: `Would remove from ${from ?? 'group'} (no longer matches ${name ?? 'any rule'}) (dry run)`,
            });
          }
          break;
        }
        // Order and color carry no rule: reported under global dry run only.
        case 'moveGroup':
          if (global) would(`g${op.groupId}|move|${op.index}`, { action: 'would-group', detail: `Would move group ${titleOf(op.groupId) ?? op.groupId} to position ${op.index} (dry run)` });
          break;
        case 'updateGroup':
          if (global && op.title !== undefined) would(`g${op.groupId}|title|${op.title}`, { action: 'would-group', detail: `Would rename group ${titleOf(op.groupId) ?? op.groupId} to ${op.title} (dry run)` });
          if (global && op.color !== undefined) would(`g${op.groupId}|color|${op.color}`, { action: 'would-group', detail: `Would recolor group ${titleOf(op.groupId) ?? op.groupId} ${op.color} (dry run)` });
          break;
        default:
          break;
      }
    }
    this.wouldSeen = seen;
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

  /** A renamed group keeps its place (M3-R41): its creation number moves from `w|from` to `w|to`. */
  private rekeyCreation(st: LiveState, windowId: number, from: string, to: string): void {
    const old = `${windowId}|${from}`;
    const n = st.creationOrder.get(old);
    if (n === undefined) return;
    st.creationOrder.delete(old);
    st.creationAbsent.delete(old);
    const key = `${windowId}|${to}`;
    if (!st.creationOrder.has(key)) st.creationOrder.set(key, n);
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
    const urls = this.anchorUrls(op, pre);
    if (!this.opts.anchors || urls.length === 0) return;
    const more = await this.opts.anchors.onGroupCreated(st, {
      groupId: gid, windowId: op.windowId, title: op.title, color: op.color, tabIds: op.tabIds, urls,
      ...(op.ruleId !== undefined && { ruleId: op.ruleId }),
    }, snap, program);
    for (const o of more) {
      try {
        await this.apply(o, snap, st, program, pre);
      } catch (e) {
        // Not in the group, an anchor would stay ungrouped for good (the planner leaves anchors alone, R21): it is
        // a plain tab again. A drag lock still aborts the flush.
        const failed = new Set(o.kind === 'group' ? o.tabIds : []);
        st.anchors = st.anchors.filter((a) => !failed.has(a.tabId));
        this.log({
          ...(op.ruleId !== undefined && { ruleId: op.ruleId }), action: 'anchor-failed',
          detail: `Could not move anchors into ${op.title} (${e instanceof Error ? e.message : String(e)})`,
        });
        if (e instanceof DragRetryExhausted) throw e;
      }
    }
  }

  /** The anchors the rule rendered for the tabs that formed a new group. */
  private anchorUrls(op: Extract<Op, { kind: 'group' }>, pre: Targets): string[] {
    const m = op.tabIds.map((id) => pre.matches.get(id))
      .find((x) => x !== undefined && x.title === op.title && (op.ruleId === undefined || x.ruleId === op.ruleId));
    return m?.anchors ?? [];
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
          try {
            await this.call(() => this.port.updateGroup(gid, p));
          } catch (e) {
            // The next flush titles it (pendingTitles) and adopts it then; anchors open only for a group created now.
            if (this.opts.anchors && this.anchorUrls(op, pre).length > 0) {
              this.log({
                ...(op.ruleId !== undefined && { ruleId: op.ruleId }), action: 'anchor-skipped',
                detail: `Anchors of ${title} not opened: the group could not be titled`,
              });
            }
            throw e;
          }
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
        const p = {
          ...(op.title !== undefined && { title: op.title }), ...(op.color !== undefined && { color: op.color }),
          ...(op.collapsed !== undefined && { collapsed: op.collapsed }),
        };
        await this.call(() => this.port.updateGroup(op.groupId, p));
        const g = snap.groups.find((x) => x.id === op.groupId);
        if (g && op.title !== undefined && op.title !== g.title) {
          const old = g.title;
          this.rekeyCreation(st, g.windowId, old, op.title);
          // The pass's snapshot follows the rename, so later ops (and their why-log entries) see the new title.
          g.title = op.title;
          // A user group later titled `old` must not count as Tabchef's; keep it while another group still has it.
          if (!snap.groups.some((x) => x.title === old)) st.managedTitles.delete(old);
        }
        this.adopt(st, op.groupId, op.title ?? titleOf(op.groupId));
        return;
      }
      default:
        return; // closeTab/focusTab belong to dedupe, not the group planner
    }
  }
}
