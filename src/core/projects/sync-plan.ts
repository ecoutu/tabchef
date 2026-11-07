// Kept projects ↔ synced bookmark folders (M4 T14, slice 4.3). Pure: the ProjectSync engine reads the folders, runs
// planSync inside the ProjectService queue on the stored projects, stores `put` / `remove` and writes `write`.
//
// Only kept projects sync (D2). The base snapshots (the last synced copy of each project, M4-R19) are the deletion
// marker: base present and local absent → its folder goes; base present and folder gone → the local copy goes if it is
// unchanged since (M4-R23). Tab order and updatedAt alone never count as a change to write or apply: two devices with
// a project open in different tab-bar orders would otherwise rewrite each other's copy forever.
import { toFolder, type FolderNode, type SyncedProject } from './bookmark-format';
import { canon, keyOf, mergeProject, normalize } from './merge';
import type { Project, SavedTab } from './types';

/** A kept project as its bookmark folder carries it (M4-R22): groups by SavedTab.group, ungrouped last; pinned and tombstone stay local. */
export function toSynced(p: Project): SyncedProject {
  const byGroup = new Map<string, { url: string; title: string }[]>();
  for (const t of p.saved?.tabs ?? []) {
    const g = t.group ?? '';
    byGroup.set(g, [...(byGroup.get(g) ?? []), { url: t.url, title: t.title }]);
  }
  const titles = [...byGroup.keys()];
  const groups = [...titles.filter((g) => g !== ''), ...titles.filter((g) => g === '')].map((title) => ({ title, tabs: byGroup.get(title)! }));
  return {
    id: p.id, recipeId: p.recipeId, key: p.key, ...(p.name !== undefined && { name: p.name }), ...(p.color !== undefined && { color: p.color }),
    updatedAt: p.updatedAt, ...(p.archivedAt !== undefined && { archivedAt: p.archivedAt }), groups, ...(p.syncExtra && { extra: p.syncExtra }),
  };
}

/**
 * `s` applied onto the local project (M4-R22), or a new kept project from it. Local-only fields (manual, excluded,
 * linked, summary, status, tombstone, the frozen flag) stay; a saved tab keeps its local pinned flag by normalized URL.
 */
export function applySynced(local: Project | undefined, s: SyncedProject): Project {
  const pinned = new Set((local?.saved?.tabs ?? []).filter((t) => t.pinned).map((t) => keyOf(t.url)));
  const tabs: SavedTab[] = s.groups.flatMap((g) => g.tabs.map((t) => ({
    url: t.url, title: t.title, ...(g.title !== '' && { group: g.title }), ...(pinned.has(keyOf(t.url)) && { pinned: true }),
  })));
  const p: Project = local
    ? structuredClone(local)
    : { id: s.id, recipeId: s.recipeId, key: s.key, createdAt: s.updatedAt, updatedAt: s.updatedAt, manual: [], excluded: [], linked: [] };
  p.keep = true;
  p.updatedAt = s.updatedAt;
  for (const [k, v] of [['name', s.name], ['color', s.color], ['archivedAt', s.archivedAt], ['syncExtra', s.extra]] as const) {
    if (v === undefined) delete p[k];
    else Object.assign(p, { [k]: v });
  }
  if (tabs.length || p.saved) p.saved = { tabs, at: s.updatedAt, ...(p.saved?.closed && { closed: true }) };
  return p;
}

/** Equal for syncing: the canonical project with updatedAt, group order and tab order left out (see the header). */
export function sameContent(a: SyncedProject, b: SyncedProject): boolean {
  const unordered = (p: SyncedProject): string => {
    const n = normalize(p);
    const groups = n.groups.map((g) => ({ title: g.title, tabs: [...g.tabs].sort((x, y) => (x.url < y.url ? -1 : x.url > y.url ? 1 : 0)) }))
      .sort((x, y) => (x.title < y.title ? -1 : x.title > y.title ? 1 : 0));
    return canon({ ...n, updatedAt: 0, groups });
  };
  return unordered(a) === unordered(b);
}

export interface SyncInput {
  stored: Project[];
  /** Projects with open member tabs (M4-R23: a remote delete only un-keeps them). */
  open: Set<string>;
  /** The projects of the Tabchef folders, by id. */
  remote: Map<string, SyncedProject>;
  base: Record<string, SyncedProject>;
  /**
   * No Tabchef folder was found though `base` has projects (Chrome signed out, the folder moved or deleted): a missing
   * folder then deletes nothing here. A kept project syncs as if never synced (its folder is written again).
   */
  rootMissing?: boolean;
}

export interface SyncPlan {
  put: Project[];
  remove: string[];
  /** Folders to write: id → the folder as it should be, or null when it goes. Only folders that change. */
  write: Map<string, FolderNode | null>;
  /** The base snapshots once every write succeeded. */
  base: Record<string, SyncedProject>;
  /** Projects changed here or in their folder. */
  merged: number;
  conflicts: string[];
  ignored: string[];
}

export function planSync({ stored, open, remote, base, rootMissing }: SyncInput): SyncPlan {
  const plan: SyncPlan = { put: [], remove: [], write: new Map(), base: {}, merged: 0, conflicts: [], ignored: [] };
  const localOf = new Map(stored.map((p) => [p.id, p]));
  const ids = new Set([...stored.filter((p) => p.keep).map((p) => p.id), ...remote.keys(), ...Object.keys(base)]);
  for (const id of ids) {
    const local = localOf.get(id);
    const r = remote.get(id);
    const b = base[id];
    // Un-kept here (M4-R23): it leaves the sync set; its folder goes.
    if (local && !local.keep && b) {
      if (r) plan.write.set(id, null);
      plan.merged += r ? 1 : 0;
      continue;
    }
    const mine = local?.keep ? toSynced(local) : undefined;
    const known = rootMissing && !r ? undefined : b;
    const { result, conflicts } = mergeProject(local && !local.keep ? undefined : known, mine, r);
    let folder: FolderNode | null = null;
    if (result) {
      try {
        folder = toFolder(result);
      } catch (e) {
        plan.ignored.push(e instanceof Error ? e.message : String(e));
        if (b) plan.base[id] = b;
        continue;
      }
    }
    plan.conflicts.push(...conflicts);
    let changed = false;
    if (!result) {
      if (r) { plan.write.set(id, null); changed = true; }
      if (local?.keep) {
        changed = true;
        if (open.has(id)) {
          const q = structuredClone(local);
          delete q.keep;
          plan.put.push(q);
        } else plan.remove.push(id);
      }
    } else {
      if (!mine || !sameContent(result, mine)) { plan.put.push(applySynced(local, result)); changed = true; }
      if (!r || !sameContent(result, r)) { plan.write.set(id, folder); changed = true; }
      plan.base[id] = result;
    }
    if (changed) plan.merged++;
  }
  return plan;
}
