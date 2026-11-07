// The `Tabchef` bookmark folders (M4 T14): reads the project folders under Other bookmarks and writes a SyncPlan's
// changes with a minimal diff. Only nodes inside a `Tabchef` folder directly under Other bookmarks are ever changed, and
// in it only folders whose project metadata parsed (M4-R25 rulings): anything else there is left as it is.
import { fromFolder, META_URL_PREFIX, ROOT_TITLE, toFolder, type FolderNode, type SyncedProject } from '../core/projects/bookmark-format';
import { canon, mergeProject } from '../core/projects/merge';
import type { BookmarkNode, BookmarkPort } from '../platform/browser-port';

export interface FolderState {
  otherId: string;
  /** The first `Tabchef` folder: where new project folders go. */
  rootId?: string;
  /** Projects by id; a project in two folders is their merge. */
  remote: Map<string, SyncedProject>;
  /** id → the first folder holding it (with its subtree). */
  home: Map<string, BookmarkNode>;
  /** id → the further folders holding it: removed once its home folder holds the merge. */
  dupes: Map<string, string[]>;
  /** Further `Tabchef` folders whose every child is a project: their folders move into the first, then they go. */
  extraRoots: BookmarkNode[];
  ignored: string[];
  /**
   * A folder that could not be read (metadata missing, edited or naming a wrong id) or a second root left as it is
   * (its projects are not in `remote`): a project missing from `remote` may be in one, so this sync deletes none.
   */
  unreadable: boolean;
}

/** The project folders of every `Tabchef` folder under Other bookmarks. `base` merges a project found twice. */
export async function readFolders(port: BookmarkPort, base: Record<string, SyncedProject>): Promise<FolderState> {
  const otherId = await port.otherId();
  const s: FolderState = { otherId, remote: new Map(), home: new Map(), dupes: new Map(), extraRoots: [], ignored: [], unreadable: false };
  const roots = (await port.children(otherId)).filter((n) => n.url === undefined && n.title === ROOT_TITLE);
  for (const [i, r] of roots.entries()) {
    const tree = await port.subtree(r.id);
    // A folder with no children (left when the worker or Chrome stopped right after creating it) holds no project:
    // it is treated as absent, so it neither counts as unreadable nor holds a delete.
    const kids = (tree.children ?? []).map((node, at) => ({ node, at }))
      .filter(({ node }) => node.url !== undefined || (node.children?.length ?? 0) > 0)
      .map(({ node, at }) => ({ node, p: node.url === undefined ? parse(node, at) : undefined }));
    if (i === 0) {
      s.rootId = r.id;
      for (const { node, p } of kids) {
        if (p && 'error' in p) { s.ignored.push(p.error); s.unreadable = true; } // a folder without project data: never modified
        else if (p) add(s, base, p, node);
      }
    } else if (kids.every(({ p }) => p && !('error' in p))) {
      for (const { node, p } of kids) add(s, base, p as SyncedProject, node);
      s.extraRoots.push(tree);
    } else {
      s.ignored.push(`A second ${ROOT_TITLE} folder in Other bookmarks (#${i + 1}) holds more than projects: it was left as it is.`);
      s.unreadable = true;
    }
  }
  return s;
}

/** `at`: the folder's place among the Tabchef folder's items, so two folders with one title read differently (M4-R49). */
function parse(node: BookmarkNode, at: number): SyncedProject | { error: string } {
  const p = fromFolder(node);
  const where = `folder "${node.title}" (#${at + 1} in the ${ROOT_TITLE} folder)`;
  if ('error' in p) return { error: p.error.replace(`folder "${node.title}"`, () => where) }; // no $& in a title expanded
  if (p.id !== `${p.recipeId}:${p.key}`) return { error: `${where}: project metadata names a wrong id` };
  return p;
}

function add(s: FolderState, base: Record<string, SyncedProject>, p: SyncedProject, node: BookmarkNode): void {
  const seen = s.remote.get(p.id);
  if (!seen) {
    s.remote.set(p.id, p);
    s.home.set(p.id, node);
    return;
  }
  s.remote.set(p.id, mergeProject(base[p.id], seen, p).result ?? seen);
  s.dupes.set(p.id, [...(s.dupes.get(p.id) ?? []), node.id]);
}

/**
 * Writes `write` (id → folder, or null: it goes) into the folders `s` read. A project found twice is rewritten into its
 * home folder (from `base`, the merged result) even when `write` skips it, and the other copy removed, but only when
 * this sync merged it (`fresh`): a skipped project's copies stay as they are. Further roots whose folders all parsed
 * are emptied into the first and removed. Returns the projects whose write failed (id → message), the other failures and
 * the first `Tabchef` folder's id (the one read, or the one created here; none when there is none).
 */
export async function writeFolders(port: BookmarkPort, s: FolderState, write: Map<string, FolderNode | null>, base: Record<string, SyncedProject>, fresh: Set<string>): Promise<{ failed: Map<string, string>; errors: string[]; rootId?: string }> {
  const failed = new Map<string, string>();
  const errors: string[] = [];
  const todo = new Map(write);
  for (const id of s.dupes.keys()) {
    const b = base[id];
    if (todo.has(id) || !b || !fresh.has(id)) continue; // a skipped project: both copies stay
    try { todo.set(id, toFolder(b)); } catch { /* reported by planSync; its copies stay */ }
  }
  const gone = new Set<string>();
  let rootId = s.rootId;
  if (!rootId && [...todo.values()].some((f) => f !== null)) rootId = await port.create({ parentId: s.otherId, title: ROOT_TITLE });
  for (const [id, want] of todo) {
    try {
      const home = s.home.get(id);
      if (want === null) {
        if (home) { await port.removeTree(home.id); gone.add(home.id); }
      } else if (home) await syncFolder(port, home, want);
      else await createFolder(port, rootId!, want);
      for (const d of s.dupes.get(id) ?? []) { await port.removeTree(d); gone.add(d); }
    } catch (e) {
      failed.set(id, `project ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const extra of s.extraRoots) {
    try {
      for (const c of extra.children ?? []) if (!gone.has(c.id)) await port.move(c.id, { parentId: rootId! });
      await port.remove(extra.id);
    } catch (e) {
      errors.push(`merging the second ${ROOT_TITLE} folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { failed, errors, ...(rootId !== undefined && { rootId }) };
}

/**
 * Creates `f` and its children. If a child fails, the part made is removed (best effort) and the error rethrown: an
 * empty project folder would read as unreadable and hold deletes.
 */
async function createFolder(port: BookmarkPort, parentId: string, f: FolderNode, index?: number): Promise<string> {
  const id = await port.create({ parentId, title: f.title, ...(f.url !== undefined && { url: f.url }), ...(index !== undefined && { index }) });
  try {
    for (const c of f.children ?? []) await createFolder(port, id, c);
  } catch (e) {
    await port.removeTree(id).catch(() => {});
    throw e;
  }
  return id;
}

async function syncFolder(port: BookmarkPort, have: BookmarkNode, want: FolderNode): Promise<void> {
  if (have.title !== want.title) await port.update(have.id, { title: want.title });
  await syncChildren(port, have.id, have.children ?? [], want.children ?? []);
}

const isMeta = (url: string | undefined): boolean => url?.startsWith(META_URL_PREFIX) ?? false;
/** The metadata as data: two URLs with the same JSON in another key order are the same (never compare URL strings). */
const metaData = (url: string): string => {
  const p = fromFolder({ title: '', children: [{ title: '', url }] });
  return 'error' in p ? url : canon(p);
};

/** `have` (one folder's children) made `want`: unmatched nodes removed, missing ones created, the rest updated in place and moved. */
async function syncChildren(port: BookmarkPort, parentId: string, have: BookmarkNode[], want: FolderNode[]): Promise<void> {
  const used = new Set<BookmarkNode>();
  const match = want.map((w) => {
    const m = have.find((h) => !used.has(h) && (w.url === undefined
      ? h.url === undefined && h.title === w.title
      : h.url !== undefined && (isMeta(w.url) ? isMeta(h.url) : h.url === w.url)));
    if (m) used.add(m);
    return m;
  });
  for (const h of have) {
    if (used.has(h)) continue;
    if (h.url === undefined) await port.removeTree(h.id);
    else await port.remove(h.id);
  }
  const cur = have.filter((h) => used.has(h));
  for (const [i, w] of want.entries()) {
    const m = match[i];
    if (!m) {
      const id = await createFolder(port, parentId, w, i);
      cur.splice(i, 0, { id, title: w.title });
      continue;
    }
    const j = cur.indexOf(m);
    if (j !== i) { // j > i: everything before i is in place, so a move is always towards the front
      await port.move(m.id, { parentId, index: i });
      cur.splice(j, 1);
      cur.splice(i, 0, m);
    }
    if (w.url === undefined) await syncFolder(port, m, w);
    else if (m.title !== w.title || (isMeta(w.url) && metaData(m.url!) !== metaData(w.url))) {
      await port.update(m.id, { title: w.title, ...(isMeta(w.url) && metaData(m.url!) !== metaData(w.url) && { url: w.url }) });
    }
  }
}
