// Three-way merge of one project across two devices (M4 T13, slice 4.3). Pure: T14 calls it once per project with the
// last-synced copy (`base`) and the local and remote copies. Tabs are keyed by normalized URL; the newer side (by
// `updatedAt`) decides the project fields, `extra`, group order and a shared tab's title and group.
import { defaultConfig } from '../config/defaults';
import { normalizeUrl } from '../url/normalize';
import type { SyncedProject } from './bookmark-format';

type Tab = { url: string; title: string };
type Entry = Tab & { k: string; group: string };

const SETTINGS = defaultConfig().dedupe;

// Exempt or unparseable URLs (chrome://, about:blank) have no normalized key; the raw URL stands in.
export const keyOf = (url: string): string => normalizeUrl(url, SETTINGS)?.key ?? url;

/** Groups merged by title, empty ones dropped, the ungrouped group (title '') last, tabs deduped by key (first wins). */
export function normalize(p: SyncedProject): SyncedProject {
  const seen = new Set<string>();
  const byTitle = new Map<string, Tab[]>();
  for (const g of p.groups) {
    for (const t of g.tabs) {
      const k = keyOf(t.url);
      if (seen.has(k)) continue;
      seen.add(k);
      byTitle.set(g.title, [...(byTitle.get(g.title) ?? []), t]);
    }
  }
  const groups = [...byTitle].filter(([, tabs]) => tabs.length).map(([title, tabs]) => ({ title, tabs }));
  return { ...p, groups: [...groups.filter((g) => g.title !== ''), ...groups.filter((g) => g.title === '')] };
}

const entries = (p: SyncedProject): Entry[] =>
  p.groups.flatMap((g) => g.tabs.map((t) => ({ ...t, k: keyOf(t.url), group: g.title })));

// Key-order-independent JSON: object keys sorted recursively, so a project built by fromFolder equals the same one from the store.
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
};

/** Canonical form of a project: known fields, tabs as {url,title}, `extra` with sorted keys. */
export const canon = (p: SyncedProject): string => stable({
  id: p.id, recipeId: p.recipeId, key: p.key, name: p.name, color: p.color, updatedAt: p.updatedAt, archivedAt: p.archivedAt,
  groups: p.groups.map((g) => ({ title: g.title, tabs: g.tabs.map((t) => ({ url: t.url, title: t.title })) })),
  extra: p.extra,
});

const same = (a: SyncedProject, b: SyncedProject): boolean => canon(a) === canon(b);

/** The newer side; on a tie a fixed order on content, so both devices pick the same one. */
function newerOf(a: SyncedProject, b: SyncedProject): [newer: SyncedProject, older: SyncedProject] {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? [a, b] : [b, a];
  return canon(a) >= canon(b) ? [a, b] : [b, a];
}

function mergeBoth(base: SyncedProject | undefined, local: SyncedProject, remote: SyncedProject): SyncedProject {
  const [newer, older] = newerOf(local, remote);
  const baseKeys = new Set(base ? entries(base).map((e) => e.k) : []);
  const removed = new Set<string>();
  for (const side of [local, remote]) {
    const has = new Set(entries(side).map((e) => e.k));
    for (const k of baseKeys) if (!has.has(k)) removed.add(k);
  }
  const taken = new Set<string>();
  const kept: Entry[] = [];
  for (const e of [...entries(newer), ...entries(older)]) {
    if (removed.has(e.k) || taken.has(e.k)) continue;
    taken.add(e.k);
    kept.push(e);
  }
  const titles = [...newer.groups, ...older.groups].map((g) => g.title);
  const groups = [...new Set(titles)].map((title) => ({
    title,
    tabs: kept.filter((e) => e.group === title).map(({ url, title: tabTitle }) => ({ url, title: tabTitle })),
  }));
  return normalize({ ...newer, groups });
}

export function mergeProject(
  base: SyncedProject | undefined,
  local: SyncedProject | undefined,
  remote: SyncedProject | undefined,
): { result: SyncedProject | undefined; conflicts: string[] } {
  const b = base && normalize(base);
  const l = local && normalize(local);
  const r = remote && normalize(remote);
  if (l && r) return { result: mergeBoth(b, l, r), conflicts: [] };
  const only = l ?? r;
  if (!only) return { result: undefined, conflicts: [] };
  // Present on one side only: a first sync (no base) or a delete on the other side.
  if (!b || !same(only, b)) {
    const conflicts = b ? [`project ${only.id}: deleted on one device but edited on the other; kept the edit`] : [];
    return { result: only, conflicts };
  }
  return { result: undefined, conflicts: [] };
}
