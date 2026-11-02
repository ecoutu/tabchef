import { evaluateGroupRules, type GroupMatch } from './evaluate';
import { parseTemplateLenient } from '../match/template';
import { isExemptUrl } from '../url/normalize';
import type { Program } from '../lang/types';
import type { GroupSnap, Op, Snapshot, TabSnap } from '../types';

export interface PlanContext {
  /** Tabs the user dragged out of a Tabchef group; untouched until their URL changes. */
  leaveAlone: Set<number>;
  /** Titles of groups Tabchef created or adopted. Other titled groups are the user's and are never touched. */
  managedTitles: Set<string>;
  /** `"<windowId>|<title>"` → monotonically increasing creation number. */
  creationOrder: Map<string, number>;
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

/** Desired sort: (ruleIndex, title | creation order, group id, first tab position). */
function bucketCompare(ctx: PlanContext) {
  return (a: Bucket, b: Bucket): number => {
    const byRule = cmp(a.match.ruleIndex, b.match.ruleIndex);
    if (byRule) return byRule;
    const second = a.match.sortGroups === 'alphabetical'
      ? a.title.localeCompare(b.title)
      : cmp(ctx.creationOrder.get(`${a.windowId}|${a.title}`) ?? Infinity,
        ctx.creationOrder.get(`${b.windowId}|${b.title}`) ?? Infinity);
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

type ManagedCtx = Pick<PlanContext, 'leaveAlone' | 'managedTitles'>;

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
 * title); page facts and creation times are not known here yet (M2 T7).
 *
 * A tab whose winning group rule is a dry-run rule is held: not eligible, so this pass neither groups, moves nor
 * ungroups it (M2 T12 logs what it would do). planGroups also never strict-ungroups a dry-run rule's group.
 */
export function planTargets(snap: Snapshot, p: Program, ctx: ManagedCtx, now: number = Date.now()): Targets {
  const normal = new Set(snap.windows.filter((w) => w.type === 'normal').map((w) => w.id));
  const tabs = snap.tabs.filter((t) => normal.has(t.windowId)).sort(byPos);
  const held = new Set<number>();
  const baseEligible = (t: TabSnap): boolean => !t.pinned && !ctx.leaveAlone.has(t.id) && !isExemptUrl(urlOf(t));
  const eligible = (t: TabSnap): boolean => baseEligible(t) && !held.has(t.id);
  const matches = new Map<number, GroupMatch>();
  const titleMatch = new Map<string, GroupMatch>();
  const byId = new Map(snap.tabs.map((t) => [t.id, t]));
  const groupTitles = new Map(snap.groups.map((g) => [g.id, g.title]));
  for (const t of tabs) {
    if (!baseEligible(t)) continue;
    const opener = t.openerTabId !== undefined ? byId.get(t.openerTabId) : undefined;
    const groupTitle = t.groupId !== -1 ? groupTitles.get(t.groupId) : undefined;
    const m = evaluateGroupRules(t, p, { ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }) }, now);
    if (!m) continue;
    if (m.dryRun) { held.add(t.id); continue; }
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
  /**
   * The rule a managed group belongs to: one of its targeting tabs' rule, else the first program rule with a group
   * action whose title template produces it. A dry-run rule's group is never strict (it must not ungroup live tabs).
   */
  const ruleFor = (g: GroupSnap): { strict: boolean; ruleId?: string } => {
    const m = titleMatch.get(g.title);
    if (m) return { strict: m.strict, ruleId: m.ruleId };
    for (const r of p.rules) {
      for (const a of r.rule.actions) {
        if ('group' in a && templateProduces(a.group.title, g.title)) return { strict: !r.dryRun && (a.group.strict ?? true), ruleId: r.key };
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
      home = candidates.find((g) => g.windowId === t.windowId);
      key = `${t.windowId}|${m.title}`;
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

  const order = bucketCompare(ctx);
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
      if (g && g.color !== b.match.color) ops.push({ kind: 'updateGroup', groupId: g.id, color: b.match.color });
    }
    if (!dirty.has(w)) {
      const desired = mine.flatMap((b) => (b.groupId !== undefined ? [b.groupId] : []));
      ops.push(...planMoves(tabs.filter((t) => t.windowId === w), desired));
    }
  }
  return ops;
}
