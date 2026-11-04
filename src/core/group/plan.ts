import { evaluateGroup, type GroupMatch, type GroupTarget } from './evaluate';
import { parseTemplateLenient } from '../match/template';
import { isExemptUrl } from '../url/normalize';
import type { Program, TabFacts } from '../lang/types';
import type { GroupSnap, Op, Snapshot, TabSnap } from '../types';

export interface PlanContext {
  /** Tabs the user dragged out of a Tabchef group; untouched until their URL changes. */
  leaveAlone: Set<number>;
  /** Titles of groups Tabchef created or adopted. Other titled groups are the user's and are never touched. */
  managedTitles: Set<string>;
  /** `"<windowId>|<title>"` → monotonically increasing creation number. */
  creationOrder: Map<string, number>;
  /**
   * M3 (M3-R39): per-tab targets from outside the rule language (project targets, T14 projectTargets). A target
   * competes with the tab's evaluated group: the lower ruleIndex wins (the evaluated one on a tie). `null`: the tab
   * has no target at all. Applied in planTargets, so managed groups, tracking and planning agree.
   */
  overrides?: Map<number, GroupTarget | null>;
}

/** One desired group: an existing group to adopt (`groupId`) or a new one, plus the tabs that must join it. */
interface Bucket {
  windowId: number;
  title: string;
  match: GroupMatch;
  groupId?: number;
  join: TabSnap[];
}

const byPos = (a: TabSnap, b: TabSnap): number => a.windowId - b.windowId || a.index - b.index;
const cmp = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
const urlOf = (t: TabSnap): string => (t.pendingUrl ? t.pendingUrl : t.url);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True if `title` could have been rendered from the rule's title template. */
function templateProduces(template: string, title: string): boolean {
  const re = new RegExp(`^${parseTemplateLenient(template).map((p) => ('lit' in p ? escapeRe(p.lit) : '[\\s\\S]*')).join('')}$`);
  return re.test(title);
}

/**
 * Desired sort: (ruleIndex, title | creation order, group id, first tab position). An adopted group's creation number
 * is read under its current title (`groupTitle`), so a group being renamed keeps its place (M3-R41).
 */
function bucketCompare(ctx: PlanContext, groupTitle: (gid: number) => string | undefined) {
  const createdAt = (b: Bucket): number => {
    const title = (b.groupId !== undefined ? groupTitle(b.groupId) : undefined) ?? b.title;
    return ctx.creationOrder.get(`${b.windowId}|${title}`) ?? Infinity;
  };
  return (a: Bucket, b: Bucket): number => {
    const byRule = cmp(a.match.ruleIndex, b.match.ruleIndex);
    if (byRule) return byRule;
    const second = a.match.sortGroups === 'alphabetical'
      ? a.title.localeCompare(b.title)
      : cmp(createdAt(a), createdAt(b));
    if (second) return second;
    const byId = cmp(a.groupId ?? Infinity, b.groupId ?? Infinity);
    if (byId) return byId;
    return cmp(a.join[0]?.index ?? Infinity, b.join[0]?.index ?? Infinity);
  };
}

/**
 * moveGroup ops that put `desired` (existing group ids, in order) right after the pinned tabs, computed against
 * a simulated tab strip so sequential application yields the desired order. Groups already in place emit nothing.
 */
function planMoves(windowTabs: TabSnap[], desired: number[]): Op[] {
  const units: { gid: number; size: number }[] = [];
  let pinned = 0;
  for (const t of windowTabs) {
    if (t.pinned) { pinned++; continue; }
    const last = units[units.length - 1];
    if (t.groupId !== -1 && last?.gid === t.groupId) last.size++;
    else units.push({ gid: t.groupId, size: 1 });
  }
  const ops: Op[] = [];
  let index = pinned;
  desired.forEach((gid, k) => {
    const at = units.findIndex((u) => u.gid === gid);
    if (at < 0) return;
    const [unit] = units.splice(at, 1) as [{ gid: number; size: number }];
    if (at !== k) ops.push({ kind: 'moveGroup', groupId: gid, index });
    units.splice(k, 0, unit);
    index += unit.size;
  });
  return ops;
}

type ManagedCtx = Pick<PlanContext, 'leaveAlone' | 'managedTitles' | 'overrides'>;

/**
 * Page facts per tab (M2 T7, background PageFacts). `awaiting`: no facts yet but the tab's watch script should report
 * soon. `source` (M3 T11): the tab's source data per rule key at `url` (background SourceService.factsFor).
 * `loading`: the tab's page has not finished loading (background LoadHold), so its title may still change.
 */
export interface PageLookup {
  get(tabId: number): TabFacts['page'] | undefined;
  awaiting(tabId: number): boolean;
  source?(tabId: number, url: string): TabFacts['source'];
  loading?(tab: TabSnap): boolean;
}

/** Per-pass rule evaluation shared by managedGroupIds and planGroups (compute once with planTargets). */
export interface Targets {
  normal: Set<number>;
  /** Tabs of normal windows in (window, index) order. */
  tabs: TabSnap[];
  eligible: (t: TabSnap) => boolean;
  matches: Map<number, GroupMatch>;
  /** Lowest-ruleIndex match per target title. */
  titleMatch: Map<string, GroupMatch>;
  managed: Set<number>;
}

/**
 * Evaluates every eligible tab against `p` at time `now`. Facts come from the snapshot (opener tab, current group
 * title) and `page` (page facts); creation times are not known here yet.
 *
 * A tab whose group outcome waits on page facts that are on their way (`page.awaiting`) is held, so a
 * selector-extract title is not grouped half-rendered and a pageText group is not strict-ungrouped meanwhile. So is a
 * tab whose page is still loading (`page.loading`): its final title can name a project or match another rule, so it
 * is not grouped by its URL alone and moved again once it loads.
 *
 * The planner treats every rule of `p` as live. The engine plans live ops with liveProgram(p) (dry-run rules fall
 * through, R48) and plans what dry-run rules would do in a separate pass over the full Program (R10, M2 T12).
 */
export function planTargets(snap: Snapshot, p: Program, ctx: ManagedCtx, now: number = Date.now(), page?: PageLookup): Targets {
  const normal = new Set(snap.windows.filter((w) => w.type === 'normal').map((w) => w.id));
  const tabs = snap.tabs.filter((t) => normal.has(t.windowId)).sort(byPos);
  const held = new Set<number>();
  const baseEligible = (t: TabSnap): boolean => !t.pinned && !ctx.leaveAlone.has(t.id) && !isExemptUrl(urlOf(t));
  const eligible = (t: TabSnap): boolean => baseEligible(t) && !held.has(t.id);
  const matches = new Map<number, GroupMatch>();
  const titleMatch = new Map<string, GroupMatch>();
  const byId = new Map(snap.tabs.map((t) => [t.id, t]));
  const groupTitles = new Map(snap.groups.map((g) => [g.id, g.title]));
  // An override ranked ahead of every group rule wins whatever the page says: neither evaluated nor held (M3-R56).
  // Infinity when no rule has a group action (Math.min of nothing): then every override wins outright.
  const firstGroupRule = Math.min(...p.rules.filter((r) => r.rule.actions.some((a) => 'group' in a)).map((r) => r.index));
  for (const t of tabs) {
    if (!baseEligible(t)) continue;
    const override = ctx.overrides?.get(t.id);
    if (override === null) continue;
    let m: GroupMatch | null | undefined = override;
    if (!override || override.ruleIndex >= firstGroupRule) {
      if (page?.loading?.(t)) { held.add(t.id); continue; }
      const opener = t.openerTabId !== undefined ? byId.get(t.openerTabId) : undefined;
      const groupTitle = t.groupId !== -1 ? groupTitles.get(t.groupId) : undefined;
      const pf = page?.get(t.id);
      const source = page?.source?.(t.id, urlOf(t));
      const { target: evaluated, needsPage } = evaluateGroup(t, p, {
        ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }), ...(pf && { page: pf }), ...(source && { source }),
      }, now);
      if (needsPage && page?.awaiting(t.id)) { held.add(t.id); continue; }
      m = override && (!evaluated || override.ruleIndex < evaluated.ruleIndex) ? override : evaluated;
    }
    if (!m) continue;
    matches.set(t.id, m);
    const prev = titleMatch.get(m.title);
    if (!prev || m.ruleIndex < prev.ruleIndex) titleMatch.set(m.title, m);
  }
  // Untitled groups are always the user's (Tabchef never renders an empty title).
  const managed = new Set(snap.groups
    .filter((g) => normal.has(g.windowId) && g.title !== '' && (ctx.managedTitles.has(g.title) || titleMatch.has(g.title)))
    .map((g) => g.id));
  return { normal, tabs, eligible, matches, titleMatch, managed };
}

/**
 * Ids of groups Tabchef manages: titled groups (normal windows) whose title Tabchef created/adopted or that some
 * eligible tab currently targets. The planner and the reconciler's membership tracking share this definition.
 */
export function managedGroupIds(snap: Snapshot, p: Program, ctx: ManagedCtx, pre?: Targets): Set<number> {
  return (pre ?? planTargets(snap, p, ctx)).managed;
}

/**
 * Ruling R49: tabs the engine merges into leaveAlone for per-rule dry run, so switching a rule to dry-run never
 * ungroups, moves or would-ungroups its existing group's tabs; new or ungrouped tabs still fall through (R48).
 * - Every tab of a titled group (normal windows) whose title some dry-run rule's group template produces and no live
 *   rule's does.
 * - In a group whose title a live rule also produces, the tabs whose winner over the FULL Program is a dry-run rule
 *   targeting that title. Other tabs there stay the live rule's: a dry-run rule never makes a live strict group
 *   non-strict, so a tab matching neither rule is still strict-ungrouped.
 */
export function dryRunGroupTabs(snap: Snapshot, p: Program, now: number = Date.now(), page?: PageLookup): number[] {
  const templates = (dry: boolean) => p.rules.filter((r) => r.dryRun === dry)
    .flatMap((r) => r.rule.actions.flatMap((a) => ('group' in a ? [a.group.title] : [])));
  const dry = templates(true);
  if (dry.length === 0) return [];
  const live = templates(false);
  const normal = new Set(snap.windows.filter((w) => w.type === 'normal').map((w) => w.id));
  const byId = new Map(snap.tabs.map((t) => [t.id, t]));
  const out: number[] = [];
  for (const g of snap.groups) {
    if (!normal.has(g.windowId) || g.title === '' || !dry.some((t) => templateProduces(t, g.title))) continue;
    const members = snap.tabs.filter((t) => t.groupId === g.id);
    if (!live.some((t) => templateProduces(t, g.title))) { out.push(...members.map((t) => t.id)); continue; }
    for (const t of members) {
      const opener = t.openerTabId !== undefined ? byId.get(t.openerTabId) : undefined;
      const pf = page?.get(t.id);
      const source = page?.source?.(t.id, urlOf(t));
      const { target } = evaluateGroup(t, p, { ...(opener && { opener }), groupTitle: g.title, ...(pf && { page: pf }), ...(source && { source }) }, now);
      if (target?.dryRun && target.title === g.title) out.push(t.id);
    }
  }
  return out;
}

/** Options for syncCreationOrder's deletion of numbers whose group is not live. */
export interface CreationPrune {
  /** Titles of groups created but not titled yet (they are untitled meanwhile): their numbers are kept. */
  pendingTitles?: Iterable<string>;
  /** Tombstones: key → consecutive counted calls it was absent. A key is dropped once it reaches ABSENT_LIMIT. */
  absent: Map<string, number>;
  /** Count absence on this call (once per flush; later passes of the same flush pass false). */
  count: boolean;
}
const ABSENT_LIMIT = 2;
const titleOfKey = (k: string): string => k.slice(k.indexOf('|') + 1);

/**
 * Gives every managed group without a creation number one (after all known numbers, in tab-strip order), so groups
 * restored by the browser keep their place when new ones are created; drops numbers of groups that no longer exist.
 * With `prune`, a number survives while its title is pending a retitle, and is dropped only after its group was
 * absent for ABSENT_LIMIT consecutive flushes (a group that is briefly empty or untitled keeps its place).
 */
export function syncCreationOrder(snap: Snapshot, managed: Set<number>, order: Map<string, number>, prune?: CreationPrune): void {
  const groupsById = new Map(snap.groups.map((g) => [g.id, g]));
  const live = new Set(snap.groups.map((g) => `${g.windowId}|${g.title}`));
  const pending = new Set(prune?.pendingTitles ?? []);
  for (const k of [...order.keys()]) {
    if (live.has(k) || pending.has(titleOfKey(k))) { prune?.absent.delete(k); continue; }
    if (!prune) { order.delete(k); continue; }
    if (!prune.count) continue;
    const n = (prune.absent.get(k) ?? 0) + 1;
    if (n >= ABSENT_LIMIT) { order.delete(k); prune.absent.delete(k); } else prune.absent.set(k, n);
  }
  if (prune) for (const k of [...prune.absent.keys()]) if (!order.has(k)) prune.absent.delete(k);
  let next = Math.max(0, ...order.values());
  for (const t of [...snap.tabs].sort(byPos)) {
    const g = groupsById.get(t.groupId);
    if (!g || !managed.has(g.id)) continue;
    const k = `${g.windowId}|${g.title}`;
    if (!order.has(k)) order.set(k, ++next);
  }
}

/**
 * Plans grouping ops for a snapshot. Pure. Groups are matched by title + window, never by stored id.
 * Windows that get structural ops (group/ungroup/moveTabs) get no moveGroup ops this pass; the reconciler re-plans.
 * `pre` is planTargets(snap, p, ctx) when the caller already computed it this pass.
 *
 * Merge titles are global: a title that any merge rule claims (some eligible tab matched it via a merge rule) gets
 * one group across all windows (per incognito-ness), and every tab targeting that title joins it, including tabs
 * matched by a non-merge rule with the same title. Titles no merge rule claims get one group per window.
 */
export function planGroups(snap: Snapshot, p: Program, ctx: PlanContext, pre?: Targets): Op[] {
  const { normal, tabs, eligible, matches, titleMatch, managed } = pre ?? planTargets(snap, p, ctx);
  const mergeTitles = new Set([...matches.values()].filter((m) => m.merge).map((m) => m.title));
  const groupsById = new Map(snap.groups.map((g) => [g.id, g]));
  const incognitoWindows = new Set(tabs.filter((t) => t.incognito).map((t) => t.windowId));

  // One title index across all windows, lowest id first (merge rules use it whole; others filter by window).
  const byTitle = new Map<string, GroupSnap[]>();
  for (const g of [...snap.groups].filter((x) => normal.has(x.windowId)).sort((a, b) => a.id - b.id)) {
    const list = byTitle.get(g.title);
    if (list) list.push(g); else byTitle.set(g.title, [g]);
  }

  const isManaged = (g: GroupSnap): boolean => managed.has(g.id);
  /** Group id → the title a bucket adopted it for through titleMatches (M3-R40); one bucket per group. */
  const renamed = new Map<number, string>();
  /** M3-R40: the lowest-id managed group in window `w` that `m.titleMatches` accepts and no tab targets by title. */
  const adoptable = (w: number, m: GroupMatch): GroupSnap | undefined => {
    const accepts = m.titleMatches;
    if (!accepts) return undefined;
    const g = snap.groups
      .filter((x) => x.windowId === w && x.title !== '' && isManaged(x) && !titleMatch.has(x.title)
        && (renamed.get(x.id) ?? m.title) === m.title && accepts(x.title))
      .sort((a, b) => a.id - b.id)[0];
    if (g) renamed.set(g.id, m.title);
    return g;
  };
  /**
   * The rule a managed group belongs to: one of its targeting tabs' rule, else the first program rule with a group
   * action whose title template produces it.
   */
  const ruleFor = (g: GroupSnap): { strict: boolean; ruleId?: string } => {
    const m = titleMatch.get(g.title);
    if (m) return { strict: m.strict, ruleId: m.ruleId };
    for (const r of p.rules) {
      for (const a of r.rule.actions) {
        if ('group' in a && templateProduces(a.group.title, g.title)) return { strict: a.group.strict ?? true, ruleId: r.key };
      }
    }
    return { strict: true };
  };
  const strictFor = (g: GroupSnap): boolean => ruleFor(g).strict;

  const buckets = new Map<string, Bucket>();
  const moveTabs = new Map<string, { from: number; to: GroupSnap; tabIds: number[]; ruleId: string }>();
  /** window → source group id → tabs to ungroup (one op per source group, so each names its rule). */
  const ungroups = new Map<number, Map<number, number[]>>();
  const dirty = new Set<number>();

  for (const t of tabs) {
    if (!eligible(t)) continue;
    const cur = t.groupId === -1 ? undefined : groupsById.get(t.groupId);
    if (t.groupId !== -1 && (!cur || !isManaged(cur))) continue; // user-made group: hands off
    const m = matches.get(t.id);
    if (!m) {
      if (cur && strictFor(cur)) {
        const byGroup = ungroups.get(t.windowId) ?? new Map<number, number[]>();
        const list = byGroup.get(cur.id) ?? [];
        list.push(t.id);
        byGroup.set(cur.id, list);
        ungroups.set(t.windowId, byGroup);
      }
      continue;
    }
    if (cur && cur.title !== m.title && !strictFor(cur)) continue; // non-strict: stays until the user moves it

    const candidates = byTitle.get(m.title) ?? [];
    let key: string;
    let home: GroupSnap | undefined;
    if (mergeTitles.has(m.title)) {
      const incog = t.incognito;
      home = candidates.find((g) => incognitoWindows.has(g.windowId) === incog);
      if (home && home.windowId !== t.windowId) {
        const k = `${t.windowId}|${home.id}`;
        const mv = moveTabs.get(k) ?? { from: t.windowId, to: home, tabIds: [], ruleId: m.ruleId };
        mv.tabIds.push(t.id);
        moveTabs.set(k, mv);
        continue;
      }
      key = home ? `${t.windowId}|${m.title}` : `merge|${incog}|${m.title}`;
    } else {
      key = `${t.windowId}|${m.title}`;
      home = candidates.find((g) => g.windowId === t.windowId) ?? (buckets.has(key) ? undefined : adoptable(t.windowId, m));
    }
    let b = buckets.get(key);
    if (!b) {
      b = { windowId: t.windowId, title: m.title, match: m, join: [], ...(home ? { groupId: home.id } : {}) };
      buckets.set(key, b);
    } else if (m.ruleIndex < b.match.ruleIndex) b.match = m;
    if (b.groupId === undefined || t.groupId !== b.groupId) b.join.push(t);
  }

  for (const [w] of ungroups) dirty.add(w);
  for (const mv of moveTabs.values()) { dirty.add(mv.from); dirty.add(mv.to.windowId); }
  for (const b of buckets.values()) {
    if (b.join.length === 0) continue;
    dirty.add(b.windowId);
    for (const t of b.join) dirty.add(t.windowId);
  }

  const order = bucketCompare(ctx, (gid) => groupsById.get(gid)?.title);
  const ops: Op[] = [];
  for (const w of [...normal].sort((a, b) => a - b)) {
    for (const [gid, tabIds] of ungroups.get(w) ?? []) {
      const g = groupsById.get(gid);
      const ruleId = g ? ruleFor(g).ruleId : undefined;
      ops.push(ruleId !== undefined ? { kind: 'ungroup', tabIds, ruleId } : { kind: 'ungroup', tabIds });
    }
    for (const mv of moveTabs.values()) {
      if (mv.from === w) ops.push({ kind: 'moveTabs', tabIds: mv.tabIds, windowId: mv.to.windowId, groupId: mv.to.id, ruleId: mv.ruleId });
    }
    const mine = [...buckets.values()].filter((b) => b.windowId === w).sort(order);
    for (const b of mine) {
      if (b.join.length === 0) continue;
      const tabIds = b.join.map((t) => t.id);
      const base = { kind: 'group' as const, tabIds, windowId: w, title: b.title, color: b.match.color };
      ops.push(b.groupId !== undefined
        ? { ...base, existingGroupId: b.groupId, ruleId: b.match.ruleId }
        : { ...base, collapsed: b.match.collapsed, ruleId: b.match.ruleId });
    }
    for (const b of mine) {
      const g = b.groupId !== undefined ? groupsById.get(b.groupId) : undefined;
      if (!g || (g.title === b.title && g.color === b.match.color)) continue;
      ops.push({
        kind: 'updateGroup', groupId: g.id, ...(g.title !== b.title && { title: b.title }),
        ...(g.color !== b.match.color && { color: b.match.color }),
      });
    }
    if (!dirty.has(w)) {
      const desired = mine.flatMap((b) => (b.groupId !== undefined ? [b.groupId] : []));
      ops.push(...planMoves(tabs.filter((t) => t.windowId === w), desired));
    }
  }
  return ops;
}
