import { evaluateGroupRules, type GroupMatch } from './evaluate';
import { isExemptUrl } from '../url/normalize';
import type { Config, GroupRule, GroupSnap, Op, Snapshot, TabSnap } from '../types';

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

const TOKEN = /\{\w+(?:\|\w+)?\}/g;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True if `title` could have been rendered from the rule's title template. */
function templateProduces(template: string, title: string): boolean {
  const re = new RegExp(`^${template.split(TOKEN).map(escapeRe).join('[\\s\\S]*')}$`);
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

/**
 * Plans grouping ops for a snapshot. Pure. Groups are matched by title + window, never by stored id.
 * Windows that get structural ops (group/ungroup/moveTabs) get no moveGroup ops this pass; the reconciler re-plans.
 */
export function planGroups(snap: Snapshot, config: Config, ctx: PlanContext): Op[] {
  const normal = new Set(snap.windows.filter((w) => w.type === 'normal').map((w) => w.id));
  const tabs = snap.tabs.filter((t) => normal.has(t.windowId)).sort(byPos);
  const groupsById = new Map(snap.groups.map((g) => [g.id, g]));
  const incognitoWindows = new Set(tabs.filter((t) => t.incognito).map((t) => t.windowId));

  // One title index across all windows, lowest id first (merge rules use it whole; others filter by window).
  const byTitle = new Map<string, GroupSnap[]>();
  for (const g of [...snap.groups].filter((x) => normal.has(x.windowId)).sort((a, b) => a.id - b.id)) {
    const list = byTitle.get(g.title);
    if (list) list.push(g); else byTitle.set(g.title, [g]);
  }

  const eligible = (t: TabSnap): boolean => !t.pinned && !ctx.leaveAlone.has(t.id) && !isExemptUrl(urlOf(t));
  const matches = new Map<number, GroupMatch>();
  const titleMatch = new Map<string, GroupMatch>(); // lowest-ruleIndex match per target title
  for (const t of tabs) {
    if (!eligible(t)) continue;
    const m = evaluateGroupRules(t, config.groupRules);
    if (!m) continue;
    matches.set(t.id, m);
    const prev = titleMatch.get(m.title);
    if (!prev || m.ruleIndex < prev.ruleIndex) titleMatch.set(m.title, m);
  }

  const isManaged = (g: GroupSnap): boolean => ctx.managedTitles.has(g.title) || titleMatch.has(g.title);
  const strictFor = (g: GroupSnap): boolean => {
    const m = titleMatch.get(g.title);
    if (m) return m.strict;
    const rule = config.groupRules.find((r: GroupRule) => r.enabled && templateProduces(r.group.title, g.title));
    return rule?.strict ?? true;
  };

  const buckets = new Map<string, Bucket>();
  const moveTabs = new Map<string, { from: number; to: GroupSnap; tabIds: number[] }>();
  const ungroups = new Map<number, number[]>();
  const dirty = new Set<number>();

  for (const t of tabs) {
    if (!eligible(t)) continue;
    const cur = t.groupId === -1 ? undefined : groupsById.get(t.groupId);
    if (t.groupId !== -1 && (!cur || !isManaged(cur))) continue; // user-made group: hands off
    const m = matches.get(t.id);
    if (!m) {
      if (cur && strictFor(cur)) {
        const list = ungroups.get(t.windowId) ?? [];
        list.push(t.id);
        ungroups.set(t.windowId, list);
      }
      continue;
    }
    if (cur && cur.title !== m.title && !strictFor(cur)) continue; // non-strict: stays until the user moves it

    const candidates = byTitle.get(m.title) ?? [];
    let key: string;
    let home: GroupSnap | undefined;
    if (m.merge) {
      const incog = t.incognito;
      home = candidates.find((g) => incognitoWindows.has(g.windowId) === incog);
      if (home && home.windowId !== t.windowId) {
        const k = `${t.windowId}|${home.id}`;
        const mv = moveTabs.get(k) ?? { from: t.windowId, to: home, tabIds: [] };
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
    const ug = ungroups.get(w);
    if (ug) ops.push({ kind: 'ungroup', tabIds: ug });
    for (const mv of moveTabs.values()) {
      if (mv.from === w) ops.push({ kind: 'moveTabs', tabIds: mv.tabIds, windowId: mv.to.windowId, groupId: mv.to.id });
    }
    const mine = [...buckets.values()].filter((b) => b.windowId === w).sort(order);
    for (const b of mine) {
      if (b.join.length === 0) continue;
      const tabIds = b.join.map((t) => t.id);
      const base = { kind: 'group' as const, tabIds, windowId: w, title: b.title, color: b.match.color };
      ops.push(b.groupId !== undefined
        ? { ...base, existingGroupId: b.groupId }
        : { ...base, collapsed: b.match.collapsed });
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
