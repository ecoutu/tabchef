// Kept projects ↔ synced bookmark folders (M4 T14, slice 4.3). Pure: the ProjectSync engine reads the folders, runs
// planSync inside the ProjectService queue on the stored projects, stores `put` / `remove` and writes `write`.
//
// Only kept projects sync (D2). The base snapshots (the last synced copy of each project, M4-R19) are the deletion
// marker: base present and local absent → its folder goes; base present and folder gone → the local copy goes if it is
// unchanged since (M4-R23). Tab order and updatedAt alone never count as a change to write or apply: two devices with
// a project open in different tab-bar orders would otherwise rewrite each other's copy forever.
import { META_URL_PREFIX, ROOT_TITLE, toFolder, type FolderNode, type SyncedProject } from './bookmark-format';
import { canon, mergeProject, normalize } from './merge';
import { keyOf } from './url-key';
import type { Project, SavedTab } from './types';

/**
 * A kept project as its bookmark folder carries it (M4-R22): groups by SavedTab.group, ungrouped last; pinned and
 * tombstone stay local. A tab opened from a "Tabchef project data" bookmark is no saved tab: fromFolder never reads one
 * back, so writing it would flip in and out of the list on every sync.
 *
 * `ownTitle` is the project's own group title (projectGroupTitle; a Manual project's is its name, else its key). A
 * saved tab records its Chrome group's title, so the project's own tabs carry it: they are the project folder's own
 * tabs, synced ungrouped, never a subfolder repeating the project's name. Done here, not in toFolder, so a folder read
 * back equals the local copy and is not rewritten on every sync; a 1.6.0 folder with that subfolder is rewritten once.
 */
export function toSynced(p: Project, ownTitle: string = p.name ?? p.key): SyncedProject {
  const byGroup = new Map<string, { url: string; title: string }[]>();
  for (const t of p.saved?.tabs ?? []) {
    if (t.url.startsWith(META_URL_PREFIX)) continue;
    const g = t.group === undefined || t.group === ownTitle ? '' : t.group;
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
 * linked, summary, status, tombstone, the frozen flag) stay; a saved tab keeps its local pinned flag by URL (keyOf).
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
  /**
   * Projects whose stored saved list could not be read: left out of this sync (no put, no write, base kept), reported.
   * A copy of one in a second folder is left as it is too.
   */
  unsynced?: Set<string>;
  /** The projects of the Tabchef folders, by id. */
  remote: Map<string, SyncedProject>;
  base: Record<string, SyncedProject>;
  /**
   * No Tabchef folder was found though `base` has projects (Chrome signed out, the folder moved or deleted): a missing
   * folder then deletes nothing here. A kept project syncs as if never synced (its folder is written again).
   */
  rootMissing?: boolean;
  /**
   * Some Tabchef folders could not be read (FolderState.unreadable): a synced project (one with a base) missing from
   * `remote` may be in one, so it is held as it is: nothing deleted, no folder written (that would be a second copy of
   * it, and would bring back a project deleted on another device), its base kept (reported). Once they can be read, it
   * syncs as usual. A project with no base was never written, so it is in none of them: it is written as usual (M4-R35).
   */
  unreadable?: boolean;
  /** A project's own group title (see toSynced); by default a Manual project's: its name, else its key. */
  ownTitle?: (p: Project) => string;
}

export interface SyncPlan {
  put: Project[];
  remove: string[];
  /** Folders to write: id → the folder as it should be, or null when it goes. Only folders that change. */
  write: Map<string, FolderNode | null>;
  /** The base snapshots once every write succeeded. */
  base: Record<string, SyncedProject>;
  /** The ids whose `base` entry is this sync's merge result (not a kept old base): only these may rewrite a duplicate folder. */
  fresh: Set<string>;
  /** Projects changed here or in their folder. */
  merged: number;
  conflicts: string[];
  ignored: string[];
  /** One-time reports for the sync notes (M4-R46) that are no conflict: a project that is no longer kept (M4-R23). */
  notes: string[];
}

export function planSync({ stored, open, unsynced, remote, base, rootMissing, unreadable, ownTitle }: SyncInput): SyncPlan {
  const plan: SyncPlan = { put: [], remove: [], write: new Map(), base: {}, fresh: new Set(), merged: 0, conflicts: [], ignored: [], notes: [] };
  const localOf = new Map(stored.map((p) => [p.id, p]));
  const ids = new Set([...stored.filter((p) => p.keep).map((p) => p.id), ...remote.keys(), ...Object.keys(base)]);
  for (const id of ids) {
    const local = localOf.get(id);
    const r = remote.get(id);
    const b = base[id];
    if (unsynced?.has(id)) {
      plan.ignored.push(`project ${id}: its saved tab list could not be read here; it syncs again once its tabs are saved`);
      if (b) plan.base[id] = b;
      continue;
    }
    // Synced before and missing while some folders could not be read (see `unreadable`): held. rootMissing writes
    // everything again instead.
    if (unreadable && !rootMissing && !r && b) {
      if (local?.keep) plan.ignored.push(`project ${id}: not synced while a ${ROOT_TITLE} bookmark folder cannot be read; kept here as it is`);
      plan.base[id] = b;
      continue;
    }
    // Un-kept here (M4-R23): it leaves the sync set; its folder goes.
    if (local && !local.keep && b) {
      if (r) plan.write.set(id, null);
      plan.merged += r ? 1 : 0;
      continue;
    }
    const mine = local?.keep ? toSynced(local, ownTitle?.(local)) : undefined;
    const known = rootMissing && !r ? undefined : b;
    const prev = local && !local.keep ? undefined : known;
    // On one side only: a delete there applies when this side is unchanged since the base by the same measure as a
    // write (sameContent). Reopen and close-and-save bump updatedAt, and order-only edits are never written, so
    // mergeProject's exact comparison would turn such a delete into a conflict and bring the project back.
    const only = !mine !== !r ? mine ?? r : undefined;
    const { result, conflicts } = prev && only && sameContent(only, prev)
      ? { result: undefined, conflicts: [] }
      : mergeProject(prev, mine, r);
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
          // Not silent: once its tabs close it is listed nowhere and pruned.
          plan.notes.push(`Project “${local.name ?? local.key}” was removed from the ${ROOT_TITLE} bookmark folder. Its tabs are open here, so it stays until you close them, but it is no longer kept.`);
        } else plan.remove.push(id);
      }
    } else {
      if (!mine || !sameContent(result, mine)) { plan.put.push(applySynced(local, result)); changed = true; }
      if (!r || !sameContent(result, r)) { plan.write.set(id, folder); changed = true; }
      plan.base[id] = result;
      plan.fresh.add(id);
    }
    if (changed) plan.merged++;
  }
  return plan;
}
