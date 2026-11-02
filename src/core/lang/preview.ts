// Preview before apply (M2 T13, rulings R27 / R30): what a config change would do to the open tabs. Pure: works on
// one snapshot (cloned, never mutated) and never touches the browser.
//
// The engine's grouping is simulated on a cloned snapshot (planGroups re-planned until no structural op is left, like
// the Reconciler's passes) under each Program, and the resulting placements are diffed:
//  - Real effects (counted): the live outcome before vs after. Live = what the engine applies: dry-run rules fall
//    through (liveProgram, R48), a dry-run rule's existing group is left alone (dryRunGroupTabs, R49), and under global
//    dry run (`Program.dryRun`) nothing is applied at all.
//  - Dry-run effects (R30, listed with `dryRun: true`, never counted): what the dry-run rules would do on top of the
//    live outcome (the engine's would-* pass: the full Program planned over the live result). Only would-effects this
//    change adds or alters are listed, so an unchanged dry-run rule does not reappear on every Save. They are shown
//    in the dialog when it opens, but never open it on their own (R52).
// Closes come from evaluateTab(...).close (auto mode only; a `suggest` close only lists the tab): a tab is listed when
// `after` closes it and `before` did not. Page-text closes are only as exact as the page facts passed in (R5).
import { dryRunGroupTabs, planGroups, planTargets, type PageLookup, type PlanContext } from '../group/plan';
import type { GroupMatch } from '../group/evaluate';
import { normalizeUrl } from '../url/normalize';
import { hasDryRun, liveProgram } from './dry-run';
import { evaluateTab, type CloseResult } from './evaluate';
import type { Program, TabFacts } from './types';
import type { Op, Snapshot, TabSnap } from '../types';

export interface PreviewMove {
  tabId: number; title: string;
  /** Group title before / after (undefined = not in a group). For a dry-run entry, `from` is the live outcome. */
  from?: string; to?: string;
  /** The rule whose op moves the tab, when known. */
  ruleKey?: string;
  /** A dry-run rule's would-move (R30): shown labelled, never counted. */
  dryRun?: true;
}
export interface PreviewClose { tabId: number; title: string; ruleKey: string; afterMs: number; dryRun?: true }
export interface PreviewResult {
  moves: PreviewMove[];
  closes: PreviewClose[];
  /** Titles of the groups the change would really create. */
  groupsCreated: string[];
  /** Open tabs with no move and no close listed. */
  unchanged: number;
  /** Anchor tabs (T11) the groups created by the change would open (dismissed anchors and reused tabs excluded). */
  anchorsOpened: number;
  /** Global dry run is on in `after`: nothing would really move or close. */
  dryRun: boolean;
}
/** The planner context (Reconciler.planContext) plus the dismissed anchor groups (`"<windowId>|<title>"`). */
export interface PreviewContext extends PlanContext {
  anchorsDismissed?: Set<string>;
  /**
   * M3 T15: the project overrides of the "after" Program (`overrides` are the "before" one's), since a draft may
   * enable, disable or reorder a project recipe. Absent: "after" plans with `overrides` too.
   */
  afterOverrides?: PlanContext['overrides'];
}

/** Stops a simulation that does not converge (the Reconciler stops after 3 re-plans too). */
const MAX_PASSES = 4;
const STRUCTURAL = new Set<Op['kind']>(['group', 'ungroup', 'moveTabs']);
const urlOf = (t: TabSnap): string => (t.pendingUrl ? t.pendingUrl : t.url);

/** `p` with no rules: the "before" of "test against my open tabs" (previewChange(snap, emptyProgram(p), p, ...)). */
export function emptyProgram(p: Program): Program {
  return { ...p, rules: [], dryRun: false };
}

/** The counted effects: real moves and closes (dry-run entries excluded, R30). */
export function previewCounts(r: PreviewResult): { moves: number; closes: number } {
  return { moves: r.moves.filter((m) => !m.dryRun).length, closes: r.closes.filter((c) => !c.dryRun).length };
}

/** Exact dialog copy. */
export function previewText(r: PreviewResult): string {
  const n = previewCounts(r);
  return `${n.moves} tabs would move, ${n.closes} would close.`;
}

/**
 * True when the change has real effects: a counted move or close, or anchor tabs that would open (ruling R52). Only
 * then does the dialog open; a change whose only entries are dry-run ones saves / enables straight through. Tolerates
 * a malformed result.
 */
export function hasEffects(r: Partial<PreviewResult> | null | undefined): boolean {
  if (!r) return false;
  const n = previewCounts({ moves: Array.isArray(r.moves) ? r.moves : [], closes: Array.isArray(r.closes) ? r.closes : [] } as PreviewResult);
  return n.moves > 0 || n.closes > 0 || (r.anchorsOpened ?? 0) > 0;
}

interface Placement { title?: string; windowId: number }
interface Sim {
  snap: Snapshot;
  /** Tab id → the rule key of the last op that moved it. */
  by: Map<number, string | undefined>;
  /** Groups the simulation created, with their anchor URLs. */
  created: { windowId: number; title: string; tabIds: number[]; anchors: string[] }[];
  /** The planner context after the simulated passes (titles adopted, creation numbers given). */
  ctx: PlanContext;
}

/** Simulates the Reconciler's grouping passes on a clone of `snap`. */
function simulate(snap: Snapshot, p: Program, base: PlanContext, now: number, page: PageLookup): Sim {
  const s = structuredClone(snap);
  // Project overrides (M3 T15) are per tab, so they hold across the simulated passes as in the engine.
  const ctx: PlanContext = {
    leaveAlone: base.leaveAlone, managedTitles: new Set(base.managedTitles), creationOrder: new Map(base.creationOrder),
    ...(base.overrides && { overrides: base.overrides }),
  };
  const sim: Sim = { snap: s, by: new Map(), created: [], ctx };
  let nextId = Math.min(-2, ...s.groups.map((g) => g.id - 1));
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const pre = planTargets(s, p, ctx, now, page);
    const ops = planGroups(s, p, ctx, pre).filter((o) => STRUCTURAL.has(o.kind));
    if (ops.length === 0) break;
    for (const op of ops) applyOp(s, op, sim, ctx, pre.matches, () => nextId--);
  }
  return sim;
}

function applyOp(s: Snapshot, op: Op, sim: Sim, ctx: PlanContext, matches: Map<number, GroupMatch>, newId: () => number): void {
  const tabs = (ids: number[]) => s.tabs.filter((t) => ids.includes(t.id));
  const mark = (ids: number[], ruleId: string | undefined) => { for (const id of ids) sim.by.set(id, ruleId); };
  switch (op.kind) {
    case 'group': {
      let gid = op.existingGroupId;
      if (gid === undefined) {
        gid = newId();
        s.groups.push({ id: gid, windowId: op.windowId, title: op.title, color: op.color, collapsed: op.collapsed ?? false });
        const key = `${op.windowId}|${op.title}`;
        if (!ctx.creationOrder.has(key)) ctx.creationOrder.set(key, Math.max(0, ...ctx.creationOrder.values()) + 1);
        // As Reconciler.openAnchors: the anchors of a tab that formed the group, matched by title and rule.
        const m = op.tabIds.map((id) => matches.get(id))
          .find((x) => x !== undefined && x.title === op.title && (op.ruleId === undefined || x.ruleId === op.ruleId));
        sim.created.push({ windowId: op.windowId, title: op.title, tabIds: [...op.tabIds], anchors: m?.anchors ?? [] });
      }
      for (const t of tabs(op.tabIds)) { t.groupId = gid; t.windowId = op.windowId; }
      ctx.managedTitles.add(op.title);
      mark(op.tabIds, op.ruleId);
      break;
    }
    case 'ungroup':
      for (const t of tabs(op.tabIds)) t.groupId = -1;
      mark(op.tabIds, op.ruleId);
      break;
    case 'moveTabs': {
      const end = Math.max(-1, ...s.tabs.filter((t) => t.windowId === op.windowId).map((t) => t.index));
      tabs(op.tabIds).forEach((t, i) => { t.windowId = op.windowId; t.groupId = op.groupId; t.index = end + 1 + i; });
      mark(op.tabIds, op.ruleId);
      break;
    }
    default:
      return;
  }
  // Chrome removes a group once its last tab leaves.
  const used = new Set(s.tabs.map((t) => t.groupId));
  s.groups = s.groups.filter((g) => used.has(g.id));
}

function placements(s: Snapshot): Map<number, Placement> {
  const titles = new Map(s.groups.map((g) => [g.id, g.title]));
  return new Map(s.tabs.map((t) => {
    const title = t.groupId === -1 ? undefined : titles.get(t.groupId);
    return [t.id, title === undefined ? { windowId: t.windowId } : { title, windowId: t.windowId }];
  }));
}
const samePlace = (a: Placement | undefined, b: Placement | undefined): boolean =>
  a?.title === b?.title && (a?.title === undefined || a?.windowId === b?.windowId);

/** Anchor tabs a created group would open: http(s), not dismissed, and no reusable tab already at that URL. */
function anchorsToOpen(g: Sim['created'][number], s: Snapshot, p: Program, dismissed: Set<string> | undefined): number {
  if (g.anchors.length === 0 || dismissed?.has(`${g.windowId}|${g.title}`)) return 0;
  const key = (u: string) => normalizeUrl(u, p.dedupe)?.key ?? u;
  const inGroup = new Set(g.tabIds);
  const used = new Set<number>();
  let n = 0;
  for (const url of new Set(g.anchors)) {
    let http = false;
    try { http = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* not a URL */ }
    if (!http) continue;
    const existing = s.tabs.find((t) => t.windowId === g.windowId && !t.pinned && !used.has(t.id)
      && (t.groupId === -1 || inGroup.has(t.id)) && key(urlOf(t)) === key(url));
    if (existing) used.add(existing.id); else n++;
  }
  return n;
}

/**
 * What changing the engine's Program from `before` to `after` would do to the tabs of `snap` (see the header).
 * `facts` adds per-tab facts the snapshot lacks (page facts, creation time); `ctx` is the engine's planner context
 * (Reconciler.planContext), so leave-alone tabs, managed titles and group order match what the engine would do.
 */
export function previewChange(
  snap: Snapshot, before: Program, after: Program, facts: (tabId: number) => Partial<TabFacts>,
  ctx: PreviewContext = { leaveAlone: new Set(), managedTitles: new Set(), creationOrder: new Map() },
  now: number = Date.now(),
): PreviewResult {
  const page: PageLookup = { get: (id) => facts(id).page, awaiting: () => false };
  // The engine's context for `p` on `s`: R49 leaves a dry-run rule's existing group alone (per-rule dry run only).
  // `base` carries the titles and creation numbers an earlier simulation adopted.
  const ctxFor = (p: Program, s: Snapshot, base: PlanContext = ctx): PlanContext => {
    const extra = p.dryRun ? [] : dryRunGroupTabs(s, p, now, page);
    const overrides = p === after && p !== before && 'afterOverrides' in ctx ? ctx.afterOverrides : ctx.overrides;
    return { ...base, leaveAlone: extra.length ? new Set([...ctx.leaveAlone, ...extra]) : ctx.leaveAlone, overrides };
  };
  const identity: Sim = { snap, by: new Map(), created: [], ctx };
  const live = (p: Program): Sim => (p.dryRun ? identity : simulate(snap, liveProgram(p), ctxFor(p, snap), now, page));
  // The would-* pass: the full Program (dry-run rules as live) over the live outcome.
  const full = (p: Program, l: Sim): Sim => (hasDryRun(p) ? simulate(l.snap, p, ctxFor(p, l.snap, l.ctx), now, page) : l);

  const B = live(before);
  const L = live(after);
  const F0 = full(before, B);
  const F = full(after, L);
  const [pB, pL, pF0, pF] = [B, L, F0, F].map((x) => placements(x.snap)) as [Map<number, Placement>, Map<number, Placement>, Map<number, Placement>, Map<number, Placement>];
  const isDry = (p: Program, key: string | undefined) => p.dryRun === true || (key !== undefined && p.rules.some((r) => r.key === key && r.dryRun));

  const moves: PreviewMove[] = [];
  const closes: PreviewClose[] = [];
  const byId = new Map(snap.tabs.map((t) => [t.id, t]));
  const groupTitles = new Map(snap.groups.map((g) => [g.id, g.title]));
  const closeOf = (p: Program, t: TabSnap): CloseResult | undefined => {
    const opener = t.openerTabId !== undefined ? byId.get(t.openerTabId) : undefined;
    const groupTitle = t.groupId !== -1 ? groupTitles.get(t.groupId) : undefined;
    const c = evaluateTab(p, { ...facts(t.id), tab: t, ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }) }, now).close;
    return c?.mode === 'auto' ? c : undefined;
  };
  /** The would-move a dry-run pass adds on top of the live outcome, as a placement (undefined: none). */
  const would = (live: Map<number, Placement>, fullP: Map<number, Placement>, id: number) =>
    (samePlace(live.get(id), fullP.get(id)) ? undefined : fullP.get(id));

  for (const t of snap.tabs) {
    if (!after.dryRun && !samePlace(pB.get(t.id), pL.get(t.id))) {
      const ruleKey = L.by.get(t.id) ?? B.by.get(t.id);
      moves.push({ tabId: t.id, title: t.title, from: pB.get(t.id)?.title, to: pL.get(t.id)?.title, ...(ruleKey !== undefined && { ruleKey }) });
    }
    const wA = would(pL, pF, t.id);
    const wB = would(pB, pF0, t.id);
    if (wA && !(wB && samePlace(wA, wB))) {
      const ruleKey = F.by.get(t.id);
      if (!isDry(after, ruleKey)) continue;
      moves.push({ tabId: t.id, title: t.title, from: pL.get(t.id)?.title, to: wA.title, ...(ruleKey !== undefined && { ruleKey }), dryRun: true });
    }
  }
  for (const t of snap.tabs) {
    // Real: the live close under `after` that `before` did not already schedule (nothing applies under global dry run).
    const cA = after.dryRun ? undefined : closeOf(liveProgram(after), t);
    const cB = before.dryRun ? undefined : closeOf(liveProgram(before), t);
    if (cA && !cB) {
      closes.push({ tabId: t.id, title: t.title, ruleKey: cA.key, afterMs: cA.afterMs });
      continue;
    }
    // Labelled (R30): a dry-run close that would win and is new with this change.
    const wA = closeOf(after, t);
    const wB = closeOf(before, t);
    if (!cA && wA?.dryRun && !(wB?.dryRun && wB.key === wA.key)) {
      closes.push({ tabId: t.id, title: t.title, ruleKey: wA.key, afterMs: wA.afterMs, dryRun: true });
    }
  }

  const createdBefore = new Set(B.created.map((g) => `${g.windowId}|${g.title}`));
  const createdNew = L.created.filter((g) => !createdBefore.has(`${g.windowId}|${g.title}`));
  const touched = new Set([...moves.map((m) => m.tabId), ...closes.map((c) => c.tabId)]);
  return {
    moves,
    closes,
    groupsCreated: [...new Set(createdNew.map((g) => g.title))],
    unchanged: snap.tabs.filter((t) => !touched.has(t.id)).length,
    anchorsOpened: createdNew.reduce((n, g) => n + anchorsToOpen(g, snap, after, ctx.anchorsDismissed), 0),
    dryRun: after.dryRun === true,
  };
}
