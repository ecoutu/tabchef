// M4 T14: ProjectSync — kept projects ↔ the `Tabchef` bookmark folder. Two devices share one FakeBookmarkPort (the
// tree Chrome Sync keeps equal); each has its own storage.local, ProjectStore and ProjectService.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { builtinRecipeRefs, defaultConfig } from '../../src/core/config/defaults';
import type { Config } from '../../src/core/types';
import { fromFolder, toFolder, ROOT_TITLE, type FolderNode, type SyncedProject } from '../../src/core/projects/bookmark-format';
import { projectGroupTitle } from '../../src/core/projects/resolve';
import { toSynced, sameContent } from '../../src/core/projects/sync-plan';
import type { Project } from '../../src/core/projects/types';
import { PROJECTS_KEY, ProjectService, ProjectStore } from '../../src/engine/projects';
import { readFolders } from '../../src/engine/bookmark-folders';
import { ProjectSync, SYNC_BASE_KEY, SYNC_ROOT_KEY, SYNC_STATUS_KEY, SYNC_TOGGLE_KEY } from '../../src/engine/project-sync';
import { toLive } from '../../src/engine/state';
import type { BookmarkNode } from '../../src/platform/browser-port';
import { FakeBookmarkPort, FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';

const MANUAL = 'manual-project';
const A = 'https://a.example/';
const B = 'https://b.example/';
const C = 'https://c.example/';

const memoryArea = (onSet?: (keys: string[]) => void) => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))])),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      onSet?.(Object.keys(items));
    },
  };
};

/** One device: its own storage, store, ProjectService and ProjectSync on the shared tree. */
function device(tree: FakeBookmarkPort, o: { granted?: boolean; debounceMs?: number; config?: Config } = {}) {
  const program = compileProgram(o.config ?? defaultConfig(), builtinRecipes()).program;
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  const clock = { now: 1_000 };
  const state = toLive(undefined);
  // eslint-disable-next-line prefer-const -- the storage hook reaches the sync built below
  let sync: ProjectSync;
  // storage.onChanged for `projects`, as background.ts wires it.
  const local = memoryArea((keys) => { if (keys.includes(PROJECTS_KEY)) sync?.schedule(); });
  const store = new ProjectStore(local);
  const svc = new ProjectService({
    store, port, getProgram: async () => program,
    sources: { factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined },
    facts: { get: () => undefined }, log: { add: () => {} }, recentlyClosed: { add: () => 'rc' }, safety: { isProtected: () => false },
    state: async () => state, now: () => clock.now,
  });
  const perms = { granted: o.granted ?? true };
  sync = new ProjectSync({
    projects: svc, bookmarks: tree, local, granted: async () => perms.granted, now: () => clock.now, debounceMs: o.debounceMs ?? 2000,
  });
  const get = async (id: string) => (await store.list()).find((p) => p.id === id);
  /** A kept Manual project stored directly (as a user action would), bumping the clock. */
  const keep = async (key: string, over: Partial<Project> = {}): Promise<Project> => {
    clock.now += 10;
    const p: Project = {
      id: `${MANUAL}:${key}`, recipeId: MANUAL, key, name: key, keep: true, createdAt: clock.now, updatedAt: clock.now,
      manual: [], excluded: [], linked: [], saved: { tabs: [{ url: A, title: 'A' }, { url: B, title: 'B', group: 'G' }], at: clock.now }, ...over,
    };
    await store.put(p);
    return p;
  };
  /** Edits a stored project as a user change would (updatedAt bumped). */
  const edit = async (id: string, f: (p: Project) => void) => {
    const p = (await get(id))!;
    f(p);
    clock.now += 10;
    p.updatedAt = clock.now;
    await store.put(p);
  };
  return { local, store, svc, sync, port, clock, perms, get, keep, edit, program };
}
/** The sync notes' texts (M4-R46): the one-time reports, kept until dismissed. */
const notes = async (d: ReturnType<typeof device>): Promise<string[]> => ((await d.sync.status()).notices ?? []).map((n) => n.text);

const rootOf = (tree: FakeBookmarkPort): BookmarkNode | undefined => tree.root.children![1]!.children!.find((c) => c.title === ROOT_TITLE && !c.url);
const folders = (tree: FakeBookmarkPort): SyncedProject[] =>
  (rootOf(tree)?.children ?? []).map((f) => fromFolder(f as FolderNode)).filter((p): p is SyncedProject => !('error' in p));
const content = (ps: (Project | undefined)[]) => ps.map((p) => p && toSynced(p));

describe('ProjectSync', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes each kept project as a folder under Other bookmarks/Tabchef; an unkept one is not; a second sync writes nothing', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.store.put({ ...p, id: `${MANUAL}:loose`, key: 'loose', keep: undefined });
    expect(await d.sync.syncNow()).toEqual({ merged: 1, conflicts: [], ignored: [] });
    expect(rootOf(tree)?.children?.map((c) => c.title)).toEqual(['taxes']);
    expect(folders(tree)).toEqual([toSynced(p)]);
    expect((d.local.data.get(SYNC_BASE_KEY) as Record<string, unknown>)[p.id]).toEqual(toSynced(p));
    const writes = tree.writes();
    expect(await d.sync.syncNow()).toEqual({ merged: 0, conflicts: [], ignored: [] });
    expect(tree.writes()).toBe(writes);
  });

  it('two devices on one tree converge after interleaved edits, then write nothing more', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(content([await b.get(p.id)])).toEqual([toSynced(p)]);
    // Interleaved: A renames and adds C; B (earlier) drops tab A and adds a tab of its own.
    b.clock.now = a.clock.now - 5;
    await a.edit(p.id, (x) => { x.name = 'Taxes 2026'; x.saved!.tabs.push({ url: C, title: 'C', group: 'G' }); });
    await b.edit(p.id, (x) => { x.saved!.tabs = x.saved!.tabs.filter((t) => t.url !== A).concat({ url: 'https://d.example/', title: 'D' }); });
    await b.sync.syncNow();
    await a.sync.syncNow();
    await b.sync.syncNow();
    const [pa, pb] = [await a.get(p.id), await b.get(p.id)];
    expect(sameContent(toSynced(pa!), toSynced(pb!))).toBe(true);
    expect(pa?.name).toBe('Taxes 2026');
    expect(pa?.saved?.tabs.map((t) => t.url).sort()).toEqual([B, C, 'https://d.example/'].sort());
    expect(folders(tree)).toHaveLength(1);
    const writes = tree.writes();
    for (const s of [a.sync, b.sync, a.sync]) expect((await s.syncNow()).merged).toBe(0);
    expect(tree.writes()).toBe(writes);
  });

  it('driven by events only (store and bookmark changes, debounced), two devices settle: a bounded number of writes', async () => {
    vi.useFakeTimers();
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    await a.sync.setEnabled(true);
    await b.sync.setEnabled(true);
    const p = await a.keep('taxes');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await b.get(p.id)).toMatchObject({ keep: true, name: 'taxes' });
    a.clock.now = 5_000;
    b.clock.now = 6_000; // B's rename is the later change
    await a.edit(p.id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); });
    await b.edit(p.id, (x) => { x.name = 'Renamed on B'; });
    await vi.advanceTimersByTimeAsync(30_000);
    const writes = tree.writes();
    expect(writes).toBeLessThan(25);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tree.writes()).toBe(writes); // settled: no echo ping-pong
    const [pa, pb] = [await a.get(p.id), await b.get(p.id)];
    expect(sameContent(toSynced(pa!), toSynced(pb!))).toBe(true);
    expect(pa).toMatchObject({ name: 'Renamed on B' });
    expect(pa?.saved?.tabs.map((t) => t.url)).toContain(C);
  });

  it('a hand-deleted project folder deletes the local kept project only if unchanged since the base', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const same = await d.keep('same');
    const edited = await d.keep('edited');
    await d.sync.syncNow();
    await d.edit(edited.id, (x) => { x.name = 'Edited here'; });
    for (const f of [...rootOf(tree)!.children!]) await tree.removeTree(f.id); // the user deletes both folders
    const r = await d.sync.syncNow();
    expect(await d.get(same.id)).toBeUndefined();
    expect(await d.get(edited.id)).toMatchObject({ name: 'Edited here', keep: true });
    expect(r.conflicts).toEqual([expect.stringContaining(edited.id)]);
    expect(folders(tree).map((x) => x.id)).toEqual([edited.id]); // the edit is written back
  });

  it('fix 1: the whole Tabchef folder gone (signed out, moved, deleted): no local project is removed; they are written again', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    const q = await d.keep('trip');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    const r = await d.sync.syncNow();
    expect(r.ignored).toEqual([]);
    expect(await notes(d)).toEqual([expect.stringMatching(/Tabchef bookmark folder was missing/)]);
    expect(content([await d.get(p.id), await d.get(q.id)])).toEqual([toSynced(p), toSynced(q)]);
    expect(folders(tree).map((x) => x.id).sort()).toEqual([p.id, q.id].sort());
  });

  it('fix 2: a remote change landing while this device writes is applied by the follow-up sync', async () => {
    vi.useFakeTimers();
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const p = await a.keep('taxes');
    const q = await a.keep('trip');
    await a.sync.syncNow();
    await a.sync.setEnabled(true);
    await vi.advanceTimersByTimeAsync(5000);
    tree.syncEvents = true; // events inside the calls: the remote edit is seen while A is still writing
    const create = tree.create.bind(tree);
    let once = true;
    tree.create = async (x) => {
      const id = await create(x);
      if (once) {
        once = false;
        // Another device renames "trip" right now (its metadata bookmark, newer updatedAt).
        const folder = rootOf(tree)!.children!.find((c) => c.title === 'trip')!;
        const remote = { ...toSynced(q), name: 'Trip 2027', updatedAt: q.updatedAt + 1_000 };
        await tree.update(folder.children![0]!.id, { title: toFolder(remote).children![0]!.title, url: toFolder(remote).children![0]!.url! });
      }
      return id;
    };
    await a.edit(p.id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); }); // A's write creates a bookmark
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await a.get(q.id)).toMatchObject({ name: 'Trip 2027' });
  });

  it("M4-R31: A renames, then B's pass refreshes the saved list (a tab closed by hand); after both sync, A's name wins", async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const tab = (id: number, url: string) => ({ id, windowId: 1, url, title: url, pinned: false, incognito: false, discarded: false, active: false, audible: false });
    b.port.addTab(tab(1, A));
    b.port.addTab(tab(2, B));
    const id = await b.svc.create(MANUAL, 'Taxes', [1, 2]); // open on B
    await b.svc.targets(await b.port.snapshot());
    await b.sync.syncNow();
    await a.sync.syncNow();
    a.clock.now = b.clock.now + 100;
    await a.edit(id, (x) => { x.name = 'Taxes 2026'; });
    b.clock.now = a.clock.now + 100; // B's pass comes after A's rename
    const before = (await b.get(id))!.updatedAt;
    await b.port.closeTab(2);
    await b.svc.targets(await b.port.snapshot());
    expect((await b.get(id))?.saved?.tabs.map((t) => t.url)).toEqual([A]);
    expect((await b.get(id))?.updatedAt).toBe(before);
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) {
      expect((await d.get(id))?.name).toBe('Taxes 2026');
      expect((await d.get(id))?.saved?.tabs.map((t) => t.url)).toEqual([A]);
    }
  });

  // M4-R38: an action that bumps updatedAt but changes nothing synced (reopen, Close group) must not undo an
  // edit made on the other device that this one hasn't synced yet.
  it('M4-R38: A renames, then B reopens the project before it syncs; the rename survives on both devices and in the folder', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    a.clock.now = 1_990;
    await a.edit(p.id, (x) => { x.name = 'Taxes 2026'; }); // at t=2000
    await a.sync.syncNow();
    b.clock.now = 2_500; // B reopens later, before it syncs
    const before = toSynced((await b.get(p.id))!);
    await b.svc.reopen(p.id);
    const after = toSynced((await b.get(p.id))!);
    expect(after.updatedAt).toBe(2_500);
    expect(sameContent(after, before)).toBe(true); // nothing synced changed on B
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) expect((await d.get(p.id))?.name).toBe('Taxes 2026');
    expect(folders(tree).map((f) => f.name)).toEqual(['Taxes 2026']);
    expect(await b.sync.syncNow()).toEqual({ merged: 0, conflicts: [], ignored: [] });
  });

  it('M4-R38: A archives, then B closes the open project (Close group); the archive survives on both devices', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const tab = (id: number, url: string) => ({ id, windowId: 1, url, title: url, pinned: false, incognito: false, discarded: false, active: false, audible: false });
    b.port.addTab(tab(1, A));
    b.port.addTab(tab(2, B));
    const id = await b.svc.create(MANUAL, 'Taxes', [1, 2]); // open on B
    await b.svc.targets(await b.port.snapshot());
    await b.sync.syncNow();
    await a.sync.syncNow();
    a.clock.now = b.clock.now + 100;
    await a.svc.archive(id); // not open on A
    await a.sync.syncNow();
    b.clock.now = a.clock.now + 100; // B's Close group comes later, before it syncs
    const before = toSynced((await b.get(id))!);
    expect((await b.svc.closeGroup(id)).closed).toBe(2);
    const after = toSynced((await b.get(id))!);
    expect(after.updatedAt).toBe(b.clock.now);
    expect(sameContent(after, before)).toBe(true); // nothing synced changed on B
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) expect((await d.get(id))?.archivedAt).toBeDefined();
    expect(folders(tree)[0]?.archivedAt).toBeDefined();
  });

  it('I1: a tab regrouped on B while the same URL sits ungrouped on A: the group syncs to A and both settle', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const tab = (id: number, url: string) => ({ id, windowId: 1, url, title: url, pinned: false, incognito: false, discarded: false, active: false, audible: false });
    a.port.addTab(tab(1, A));
    a.port.addTab(tab(2, B));
    const id = await a.svc.create(MANUAL, 'Taxes', [1, 2]); // open on A, ungrouped
    b.port.addTab(tab(1, A));
    await a.svc.targets(await a.port.snapshot());
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.svc.addTab(1, id); // open on B too
    await b.svc.targets(await b.port.snapshot());
    b.port.addGroup({ id: 50, windowId: 1, title: 'X', color: 'blue', collapsed: false });
    b.port.state.tabs.find((t) => t.id === 1)!.groupId = 50; // the user drags A into group X on B
    const sets = { a: vi.spyOn(a.local, 'set'), b: vi.spyOn(b.local, 'set') };
    const round = async () => {
      for (const d of [b, a]) {
        d.clock.now += 1_000;
        await d.svc.targets(await d.port.snapshot());
        await d.sync.syncNow();
      }
    };
    for (let i = 0; i < 3; i++) await round();
    const settled = { a: sets.a.mock.calls.length, b: sets.b.mock.calls.length, tree: tree.writes(), store: [a.local.data.get(PROJECTS_KEY), b.local.data.get(PROJECTS_KEY)] };
    for (let i = 0; i < 3; i++) await round();
    expect([a.local.data.get(PROJECTS_KEY), b.local.data.get(PROJECTS_KEY)]).toEqual(settled.store);
    expect(tree.writes()).toBe(settled.tree);
    // No more store writes on either device: no sync → pass → sync loop.
    expect(sets.a.mock.calls.slice(settled.a).some(([x]) => PROJECTS_KEY in x)).toBe(false);
    expect(sets.b.mock.calls.slice(settled.b).some(([x]) => PROJECTS_KEY in x)).toBe(false);
    for (const d of [a, b]) expect((await d.get(id))?.saved?.tabs.find((t) => t.url === A)?.group).toBe('X');
  });

  it('a URL added to an open project on another device survives a pass here and stays in the folder', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const tab = (id: number, url: string) => ({ id, windowId: 1, url, title: url, pinned: false, incognito: false, discarded: false, active: false, audible: false });
    a.port.addTab(tab(1, A));
    a.port.addTab(tab(2, B));
    const id = await a.svc.create(MANUAL, 'Taxes', [1, 2]); // open on A
    await a.svc.targets(await a.port.snapshot());
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.edit(id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); }); // added on B
    await b.sync.syncNow();
    await a.sync.syncNow();
    a.clock.now += 1_000;
    await a.svc.targets(await a.port.snapshot()); // C is not open on A
    await a.sync.syncNow();
    await b.sync.syncNow();
    for (const d of [a, b]) expect((await d.get(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
    expect(folders(tree)[0]?.groups.flatMap((g) => g.tabs.map((t) => t.url))).toContain(C);
  });

  it('M4-R19: removed on device A → its folder goes → device B removes its unchanged copy', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.svc.remove(p.id);
    await a.sync.syncNow();
    expect(folders(tree)).toEqual([]);
    await b.sync.syncNow();
    expect(await b.get(p.id)).toBeUndefined();
    expect(b.local.data.get(SYNC_BASE_KEY)).toEqual({});
  });

  it('M4-R23: a remote delete of a project with open member tabs here only un-keeps it; un-keep here removes its folder', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    b.port.addTab({ id: 1, windowId: 1, url: A, title: 'A', pinned: false, incognito: false, discarded: false, active: true, audible: false });
    const id = await b.svc.create(MANUAL, 'Taxes', [1]); // open on B
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(await a.get(id)).toMatchObject({ keep: true });
    await a.svc.setKeep(id, false); // un-kept on A: leaves the sync set
    await a.sync.syncNow();
    expect(folders(tree)).toEqual([]);
    expect(await a.get(id)).toMatchObject({ id });
    await b.sync.syncNow();
    const onB = await b.get(id);
    expect(onB).toBeDefined();
    expect(onB).not.toHaveProperty('keep');
  });

  it('never touches bookmarks outside the Tabchef folder, nor folders in it without project data (reported)', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await tree.create({ parentId: '1', title: 'News', url: 'https://news.example/' });
    const barFolder = await tree.create({ parentId: '1', title: ROOT_TITLE }); // a Tabchef folder on the bar: not ours
    await tree.create({ parentId: barFolder, title: 'x', url: 'https://x.example/' });
    await tree.create({ parentId: '2', title: 'Recipes', url: 'https://food.example/' });
    const root = await tree.create({ parentId: '2', title: ROOT_TITLE });
    const junk = await tree.create({ parentId: root, title: 'My notes' });
    await tree.create({ parentId: junk, title: 'n', url: 'https://n.example/' });
    await tree.create({ parentId: root, title: 'loose', url: 'https://loose.example/' });
    const outside = structuredClone(tree.root.children![0]);
    const otherOutside = structuredClone(tree.root.children![1]!.children!.filter((c) => c.id !== root));
    const junkBefore = structuredClone(rootOf(tree)!.children!.filter((c) => c.id !== undefined && c.title !== 'taxes'));
    const p = await d.keep('taxes');
    let r = await d.sync.syncNow();
    // M4-R35: a new project (no base) is written even while a folder there cannot be read.
    expect(r.ignored).toEqual([expect.stringContaining('My notes')]);
    expect(folders(tree).map((f) => f.id)).toEqual([p.id]);
    await d.edit(p.id, (x) => { x.name = 'Renamed'; });
    await d.sync.syncNow();
    await d.svc.remove(p.id);
    r = await d.sync.syncNow();
    expect(tree.root.children![0]).toEqual(outside);
    expect(tree.root.children![1]!.children!.filter((c) => c.id !== root)).toEqual(otherOutside);
    expect(rootOf(tree)?.children).toEqual(junkBefore);
  });

  it('rewrites a changed folder with a minimal diff: a rename touches the folder title and the metadata bookmark only', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.sync.syncNow();
    tree.log = [];
    await d.edit(p.id, (x) => { x.name = 'Taxes 2026'; });
    await d.sync.syncNow();
    expect(tree.log.map((l) => l.method)).toEqual(['update', 'update']);
    tree.log = [];
    await d.edit(p.id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); });
    await d.sync.syncNow();
    expect(tree.log.map((l) => l.method)).toEqual(['update', 'create']); // metadata (updatedAt), the new bookmark
    expect(folders(tree)[0]?.groups).toEqual([{ title: 'G', tabs: [{ url: B, title: 'B' }] }, { title: '', tabs: [{ url: A, title: 'A' }, { url: C, title: 'C' }] }]);
  });

  it('a metadata bookmark that decodes to the same data (other key order) is not rewritten', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.sync.syncNow();
    const meta = rootOf(tree)!.children![0]!.children![0]!;
    // The same JSON with its keys reversed, as another build might write it.
    const json = JSON.parse(atob(meta.url!.split('#')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    const reversed = Object.fromEntries(Object.entries(json).reverse());
    meta.url = `https://tabchef.invalid/project#${btoa(JSON.stringify(reversed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    // A tab added with updatedAt unchanged: the merged metadata decodes the same, so only the bookmark is added.
    const stored = (await d.get(p.id))!;
    stored.saved!.tabs.push({ url: C, title: 'C' });
    await d.store.put(stored);
    tree.log = [];
    await d.sync.syncNow();
    expect(tree.log.map((l) => l.method)).toEqual(['create']);
    expect(meta.url).toContain('tabchef.invalid');
  });

  it('a project whose metadata would exceed 8 KB is skipped and reported; the others sync', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('big', { syncExtra: { blob: 'x'.repeat(9000) } });
    const ok = await d.keep('ok');
    const r = await d.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining(`${MANUAL}:big`)]);
    expect(folders(tree).map((x) => x.id)).toEqual([ok.id]);
  });

  it('two Tabchef folders whose children all parse: merged into the first, the second removed', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    const q = await d.keep('trip');
    const r1 = await tree.create({ parentId: '2', title: ROOT_TITLE });
    const r2 = await tree.create({ parentId: '2', title: ROOT_TITLE });
    const put = async (parentId: string, f: FolderNode): Promise<void> => {
      const id = await tree.create({ parentId, title: f.title, ...(f.url !== undefined && { url: f.url }) });
      for (const c of f.children ?? []) await put(id, c);
    };
    // Device X wrote taxes into the first, device Y taxes (with C) and trip into the second, before syncing.
    await put(r1, toFolder(toSynced(p)));
    await put(r2, toFolder({ ...toSynced(p), groups: [...toSynced(p).groups, { title: '', tabs: [{ url: C, title: 'C' }] }] }));
    await put(r2, toFolder(toSynced(q)));
    const r = await d.sync.syncNow();
    expect(r.ignored).toEqual([]);
    expect(tree.root.children![1]!.children!.map((c) => c.id)).toEqual([r1]);
    expect(folders(tree).map((x) => x.id).sort()).toEqual([p.id, q.id].sort());
    expect(folders(tree).find((x) => x.id === p.id)?.groups.flatMap((g) => g.tabs.map((t) => t.url))).toContain(C);
    expect((await d.get(p.id))?.saved?.tabs.map((t) => t.url)).toContain(C);
  });

  it('I2: a project folder whose metadata bookmark was deleted by hand deletes the project on no device', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    const folder = rootOf(tree)!.children!.find((c) => c.title === 'taxes')!;
    await tree.remove(folder.children![0]!.id); // the metadata bookmark
    for (const d of [a, b, a]) {
      const r = await d.sync.syncNow();
      expect(r.ignored).toEqual(expect.arrayContaining([expect.stringContaining('taxes')]));
      expect(await d.get(p.id)).toMatchObject({ keep: true });
    }
    expect(content([await b.get(p.id)])).toEqual([toSynced(p)]);
  });

  it('I2: a metadata bookmark naming a wrong id, or a project folder in a second Tabchef folder that holds something else, deletes nothing', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    const q = await d.keep('trip');
    await d.sync.syncNow();
    const meta = rootOf(tree)!.children!.find((c) => c.title === 'taxes')!.children![0]!;
    const good = meta.url!;
    await tree.update(meta.id, { title: meta.title, url: toFolder({ ...toSynced(p), id: 'manual-project:other' }).children![0]!.url! });
    let r = await d.sync.syncNow();
    expect(await d.get(p.id)).toMatchObject({ keep: true });
    expect(r.ignored).toEqual(expect.arrayContaining([expect.stringContaining('wrong id')]));
    expect(rootOf(tree)!.children!.filter((c) => c.title === 'taxes')).toHaveLength(1); // held: no second copy written
    await tree.update(meta.id, { title: meta.title, url: good }); // fixed by hand
    expect((await d.sync.syncNow()).ignored).toEqual([]); // readable again
    expect(await d.get(p.id)).toMatchObject({ keep: true });
    // trip's folder moved into a second Tabchef folder that also holds a bookmark of the user's.
    const r2 = await tree.create({ parentId: '2', title: ROOT_TITLE });
    await tree.create({ parentId: r2, title: 'mine', url: 'https://mine.example/' });
    await tree.move(rootOf(tree)!.children!.find((c) => c.title === 'trip')!.id, { parentId: r2 });
    r = await d.sync.syncNow();
    expect(await d.get(q.id)).toMatchObject({ keep: true });
    expect(r.ignored).toEqual(expect.arrayContaining([expect.stringMatching(/second Tabchef folder/)]));
  });

  it('I2: a delete on another device survives while a Tabchef folder cannot be read here, and applies once it can be read', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    const q = await a.keep('trip');
    await a.sync.syncNow();
    await b.sync.syncNow();
    // trip's metadata hand-edited (names a wrong id): its folder cannot be read on either device.
    const meta = rootOf(tree)!.children!.find((c) => c.title === 'trip')!.children![0]!;
    const good = meta.url!;
    await tree.update(meta.id, { title: meta.title, url: toFolder({ ...toSynced(q), id: 'manual-project:other' }).children![0]!.url! });
    await b.svc.remove(p.id);
    await b.sync.syncNow();
    const titles = () => rootOf(tree)!.children!.map((c) => c.title).sort();
    expect(titles()).toEqual(['trip']);
    // A holds both: taxes is not written back, trip gets no second folder; the unreadable folder is named.
    const writes = tree.writes();
    const r = await a.sync.syncNow();
    expect(tree.writes()).toBe(writes);
    expect(r.conflicts).toEqual([]);
    expect(r.ignored).toEqual(expect.arrayContaining([expect.stringContaining('folder "trip"'), expect.stringContaining(p.id), expect.stringContaining(q.id)]));
    expect(await a.get(p.id)).toMatchObject({ keep: true });
    const rb = await b.sync.syncNow();
    expect(rb.conflicts).toEqual([]);
    expect(await b.get(p.id)).toBeUndefined();
    expect(titles()).toEqual(['trip']);
    // The folder fixed by hand: A applies the delete, nothing conflicts, and both settle.
    await tree.update(meta.id, { title: meta.title, url: good });
    const r2 = await a.sync.syncNow();
    expect(r2).toMatchObject({ conflicts: [], ignored: [] });
    expect(await a.get(p.id)).toBeUndefined();
    expect(await a.get(q.id)).toMatchObject({ keep: true });
    expect((await b.sync.syncNow())).toEqual({ merged: 0, conflicts: [], ignored: [] });
    expect(await b.get(p.id)).toBeUndefined();
    expect(folders(tree).map((f) => f.id)).toEqual([q.id]);
  });

  it('M4-R35: while a folder is unreadable, a new kept project (no base) still gets its folder written; a based project missing from the folders is held', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.sync.syncNow();
    const meta = rootOf(tree)!.children!.find((c) => c.title === 'taxes')!.children![0]!;
    await tree.update(meta.id, { title: meta.title, url: toFolder({ ...toSynced(p), id: 'manual-project:other' }).children![0]!.url! });
    const n = await d.keep('trip');
    const r = await d.sync.syncNow();
    expect(r.conflicts).toEqual([]);
    expect(r.ignored).toEqual(expect.arrayContaining([expect.stringContaining('folder "taxes"'), expect.stringContaining(p.id)]));
    expect(r.ignored).not.toEqual(expect.arrayContaining([expect.stringContaining(n.id)]));
    expect(rootOf(tree)!.children!.map((c) => c.title).sort()).toEqual(['taxes', 'trip']); // trip written, no second taxes
    expect(folders(tree).find((f) => f.id === n.id)).toEqual(toSynced(n));
    expect(await d.get(p.id)).toMatchObject({ keep: true });
    expect((d.local.data.get(SYNC_BASE_KEY) as Record<string, unknown>)[n.id]).toEqual(toSynced(n));
  });

  it('a project whose stored saved list was unreadable (dropped on read) stays out of sync until it has a saved list again', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    // A's stored saved list is corrupted; a new worker reads it (the store drops it).
    a.local.data.set(PROJECTS_KEY, [{ ...p, saved: { tabs: 'broken', at: 1 } }]);
    const a2 = device(tree);
    for (const [k, v] of a.local.data) a2.local.data.set(k, structuredClone(v));
    const writes = tree.writes();
    const r = await a2.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining(p.id)]);
    expect(tree.writes()).toBe(writes);
    expect(folders(tree)).toEqual([toSynced(p)]);
    await b.sync.syncNow();
    expect(content([await b.get(p.id)])).toEqual([toSynced(p)]);
    // A saved list stored again (a pass, close-and-save): it syncs again.
    await a2.edit(p.id, (x) => { x.saved = { tabs: [{ url: C, title: 'C' }], at: a2.clock.now }; });
    expect((await a2.sync.syncNow()).ignored).toEqual([]);
    expect(folders(tree)[0]?.groups.flatMap((g) => g.tabs.map((t) => t.url))).toEqual([C]);
  });

  it('a project whose stored saved list was unreadable stays out of sync after a write without a list and a worker restart', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    a.local.data.set(PROJECTS_KEY, [{ ...p, saved: { tabs: 'broken', at: 1 } }]);
    const restart = () => {
      const n = device(tree);
      for (const [k, v] of a.local.data) n.local.data.set(k, structuredClone(v));
      return n;
    };
    const a2 = restart();
    await a2.edit(p.id, (x) => { x.name = 'Renamed'; }); // stored without a saved list
    for (const [k, v] of a2.local.data) a.local.data.set(k, structuredClone(v));
    const a3 = restart();
    expect(await a3.store.unreadableSaved()).toEqual(new Set([p.id]));
    const writes = tree.writes();
    const r = await a3.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining(p.id)]);
    expect(tree.writes()).toBe(writes);
    expect(folders(tree)).toEqual([toSynced(p)]);
  });

  it('a second Tabchef folder holding something else is left as it is and reported', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await tree.create({ parentId: '2', title: ROOT_TITLE });
    const r2 = await tree.create({ parentId: '2', title: ROOT_TITLE });
    await tree.create({ parentId: r2, title: 'mine', url: 'https://mine.example/' });
    const before = structuredClone(tree.root.children![1]!.children![1]);
    const r = await d.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringMatching(/second Tabchef folder/)]); // M4-R35: taxes is new here (no base): written
    expect(tree.root.children![1]!.children![1]).toEqual(before);
    expect(folders(tree)).toHaveLength(1);
  });

  it('a folder write that fails part-way leaves no empty project folder, so a delete from another device is not held', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const old = await a.keep('old');
    await a.sync.syncNow();
    await b.sync.syncNow();
    const fresh = await a.keep('fresh');
    const create = tree.create.bind(tree);
    let fail = true;
    // The project folder is created; its first bookmark fails (permission revoked, API error, Chrome quitting).
    tree.create = async (q) => { if (fail && q.parentId !== rootOf(tree)?.id) throw new Error('quota'); return create(q); };
    const r = await a.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining('quota')]);
    expect(rootOf(tree)?.children?.map((c) => c.title)).toEqual(['old']); // the partial folder was removed
    fail = false;
    await b.svc.remove(old.id); // deleted on B
    await b.sync.syncNow();
    const r2 = await a.sync.syncNow(); // not held: no unreadable folder; the write is retried
    expect(r2.ignored).toEqual([]);
    expect(await a.get(old.id)).toBeUndefined();
    expect(folders(tree)).toEqual([toSynced((await a.get(fresh.id))!)]);
  });

  // M4-R39: a project in two folders that this sync skips (unreadable saved list, or metadata over 8 KB) must not be
  // rewritten from its old base: the copies hold newer edits from other devices.
  const copyFolder = async (tree: FakeBookmarkPort, id: string): Promise<void> => {
    const put = async (parentId: string, f: FolderNode): Promise<void> => {
      const n = await tree.create({ parentId, title: f.title, ...(f.url !== undefined && { url: f.url }) });
      for (const c of f.children ?? []) await put(n, c);
    };
    const home = rootOf(tree)!.children!.find((f) => { const p = fromFolder(f as FolderNode); return !('error' in p) && p.id === id; })!;
    await put(rootOf(tree)!.id, home as FolderNode);
  };
  const urls = (ps: SyncedProject[], id: string) => ps.filter((x) => x.id === id).map((x) => x.groups.flatMap((g) => g.tabs.map((t) => t.url)).sort());

  it('M4-R39: a project in two folders whose saved list is unreadable here keeps the newer edits of both copies', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.edit(p.id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); }); // added on B after A's last sync
    await b.sync.syncNow();
    await copyFolder(tree, p.id); // a second folder for it (a copy by hand, or a Tabchef folder restored by Chrome Sync)
    // A's stored saved list is corrupted; a new worker reads it (the store drops it): A skips the project.
    a.local.data.set(PROJECTS_KEY, [{ ...p, saved: { tabs: 'broken', at: 1 } }]);
    const a2 = device(tree);
    for (const [k, v] of a.local.data) a2.local.data.set(k, structuredClone(v));
    const r = await a2.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining(p.id)]);
    // B's tab C is still in every copy of the project, and still on B after its next sync.
    for (const u of urls(folders(tree), p.id)) expect(u).toContain(C);
    await b.sync.syncNow();
    expect((await b.get(p.id))?.saved?.tabs.map((t) => t.url)).toContain(C);
    expect(urls(folders(tree), p.id)).toEqual([[A, B, C]]); // B can merge it: one folder again
  });

  it('M4-R39: a project in two folders whose merged metadata would exceed 8 KB keeps the newer edits of both copies', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.edit(p.id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); });
    await b.sync.syncNow();
    await copyFolder(tree, p.id);
    await a.edit(p.id, (x) => { x.syncExtra = { blob: 'x'.repeat(9000) }; }); // A's copy can no longer be written
    const r = await a.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining(p.id)]);
    for (const u of urls(folders(tree), p.id)) expect(u).toContain(C);
    await b.sync.syncNow();
    expect((await b.get(p.id))?.saved?.tabs.map((t) => t.url)).toContain(C);
    expect(urls(folders(tree), p.id)).toEqual([[A, B, C]]); // B can merge it: one folder again
  });
});

describe('ProjectSync toggle, permission and status', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is off without the bookmarks permission: enabling refuses, nothing is stored or synced', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree, { granted: false });
    await expect(d.sync.setEnabled(true)).rejects.toThrow(/bookmarks/);
    expect(d.local.data.has(SYNC_TOGGLE_KEY)).toBe(false);
    expect(await d.sync.status()).toEqual({ enabled: false, wanted: false });
  });

  it('the toggle on but the bookmarks permission revoked: status says sync is wanted but not running (paused)', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    expect(await d.sync.setEnabled(true)).toEqual({ enabled: true, wanted: true });
    await d.sync.syncNow();
    d.perms.granted = false;
    await d.sync.refresh();
    expect(await d.sync.status()).toMatchObject({ enabled: false, wanted: true, lastSyncAt: d.clock.now });
    expect(d.local.data.get(SYNC_TOGGLE_KEY)).toBe(true);
    await d.sync.setEnabled(false);
    expect(await d.sync.status()).toMatchObject({ enabled: false, wanted: false });
  });

  it('on with the toggle and the permission: syncs after the debounce; status has lastSyncAt and lastResult', async () => {
    vi.useFakeTimers();
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    expect(await d.sync.setEnabled(true)).toEqual({ enabled: true, wanted: true });
    expect(d.local.data.get(SYNC_TOGGLE_KEY)).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(folders(tree)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(folders(tree)).toHaveLength(1);
    expect(await d.sync.status()).toEqual({ enabled: true, wanted: true, lastSyncAt: d.clock.now, lastResult: { merged: 1, conflicts: [], ignored: [] } });
    expect(d.local.data.get(SYNC_STATUS_KEY)).toMatchObject({ lastSyncAt: d.clock.now });
  });

  it('the permission removed (refresh) or the toggle off: bookmark and store changes no longer sync; the base stays', async () => {
    vi.useFakeTimers();
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.sync.setEnabled(true);
    await vi.advanceTimersByTimeAsync(5000);
    d.perms.granted = false;
    await d.sync.refresh();
    expect((await d.sync.status()).enabled).toBe(false);
    await d.edit(p.id, (x) => { x.name = 'Off'; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(folders(tree)[0]?.name).toBe('taxes');
    d.perms.granted = true;
    await d.sync.refresh();
    await d.sync.setEnabled(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(folders(tree)[0]?.name).toBe('taxes');
    expect(d.local.data.get(SYNC_BASE_KEY)).toHaveProperty(p.id);
    await d.sync.setEnabled(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(folders(tree)[0]?.name).toBe('Off');
  });

  it('a failed sync is reported in the status and the next change retries', async () => {
    vi.useFakeTimers();
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    const create = tree.create.bind(tree);
    let fail = true;
    tree.create = async (p) => { if (fail) throw new Error('quota'); return create(p); };
    await d.sync.setEnabled(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await d.sync.status()).lastResult).toMatchObject({ error: expect.stringContaining('quota') });
    fail = false;
    d.sync.schedule();
    await vi.advanceTimersByTimeAsync(5000);
    expect(folders(tree)).toHaveLength(1);
    expect((await d.sync.status()).lastResult).toEqual({ merged: expect.any(Number), conflicts: [], ignored: [] });
  });
});

// M4-R40: the base is tied to no particular Tabchef folder. With Chrome's account bookmarks a profile has a local
// "Other bookmarks" and, while signed in, an account one (`syncing: true`); otherId() follows whichever is there, so a
// Chrome sign-in or sign-out makes this device read a different Tabchef folder against the same base.
/** One device's view of the bookmarks: its local tree, or (signed in) the account tree that Chrome Sync shares. */
function switching(local: FakeBookmarkPort, account: FakeBookmarkPort) {
  let cur = local;
  const port = {
    use(t: FakeBookmarkPort) { cur = t; },
    otherId: () => cur.otherId(),
    children: (id: string) => cur.children(id),
    subtree: (id: string) => cur.subtree(id),
    create: (p: { parentId: string; index?: number; title: string; url?: string }) => cur.create(p),
    update: (id: string, p: { title?: string; url?: string }) => cur.update(id, p),
    move: (id: string, p: { parentId: string; index?: number }) => cur.move(id, p),
    remove: (id: string) => cur.remove(id),
    removeTree: (id: string) => cur.removeTree(id),
    onChanged: (cb: () => void) => { const a = local.onChanged(cb); const b = account.onChanged(cb); return () => { a(); b(); }; },
  };
  return port;
}
/** The account tree: its own "Other bookmarks" id and node ids (Chrome's ids are unique within a profile). */
function accountTree(): FakeBookmarkPort {
  const t = new FakeBookmarkPort();
  t.root = { id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: [] }, { id: '3', title: 'Other bookmarks', children: [] }] };
  t.otherId = async () => '3';
  (t as unknown as { nextId: number }).nextId = 5000;
  return t;
}

describe('M4-R40: a Chrome sign-in or sign-out switches the Tabchef folder under the base', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('a project synced only to the local folder survives signing in to an account that syncs other projects', async () => {
    const localA = new FakeBookmarkPort();
    const account = accountTree();
    const view = switching(localA, account);
    const a = device(view as unknown as FakeBookmarkPort);
    const b = device(account);
    const bee = await b.keep('bee');
    await b.sync.syncNow(); // B already syncs `bee` to the account
    const one = await a.keep('one');
    await a.sync.syncNow(); // A turned sync on before signing in to Chrome: its folder is in local Other bookmarks
    expect(folders(localA).map((p) => p.id)).toEqual([one.id]);
    view.use(account); // A signs in: otherId() now finds the account Other bookmarks
    const r = await a.sync.syncNow();
    // `one` was never in the account folder: nothing deleted it, so it must not be removed here.
    expect(await a.get(one.id)).toMatchObject({ keep: true, name: 'one' });
    expect(folders(account).map((p) => p.id).sort()).toEqual([bee.id, one.id].sort());
    expect(await a.get(bee.id)).toMatchObject({ keep: true, name: 'bee' });
    expect(r.ignored).toEqual([]);
    expect(await notes(a)).toEqual([expect.stringMatching(/different Tabchef bookmark folder/)]); // the switch is reported
  });

  it('after sign-out, sign-in, edits and sign-out, the stale local folder neither deletes a new project nor reverts a rename', async () => {
    const localA = new FakeBookmarkPort();
    const account = accountTree();
    const view = switching(localA, account);
    const a = device(view as unknown as FakeBookmarkPort);
    const one = await a.keep('one');
    await a.sync.syncNow(); // signed out: the folder is in local Other bookmarks
    view.use(account); // signs in to an account with no Tabchef folder: the rootMissing path writes `one` there
    await a.sync.syncNow();
    expect(folders(account).map((p) => p.id)).toEqual([one.id]);
    const two = await a.keep('two');
    await a.edit(one.id, (x) => { x.name = 'One renamed'; });
    await a.sync.syncNow(); // both reach the account folder
    expect(folders(account).find((p) => p.id === one.id)?.name).toBe('One renamed');
    view.use(localA); // signs out: the account bookmarks leave the device; the old local folder is found again
    const r = await a.sync.syncNow();
    expect(await a.get(two.id)).toMatchObject({ keep: true, name: 'two' });
    expect(await a.get(one.id)).toMatchObject({ keep: true, name: 'One renamed' });
    expect(r.ignored).toEqual([]);
    // the switch is reported, after the missing folder the sign-in found
    expect(await notes(a)).toEqual([expect.stringMatching(/was missing/), expect.stringMatching(/different Tabchef bookmark folder/)]);
  });
});

describe('M4-R40: the base is bound to the Tabchef folder it was made against', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const SWITCHED = /different Tabchef bookmark folder/;

  it('records the folder with the base; the same folder again is no switch, and a delete from another device still applies', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    expect(a.local.data.get(SYNC_ROOT_KEY)).toBe(rootOf(tree)!.id);
    await b.sync.syncNow();
    await b.svc.remove(p.id);
    await b.sync.syncNow();
    const r = await a.sync.syncNow();
    expect(r).toEqual({ merged: 1, conflicts: [], ignored: [] });
    expect(await a.get(p.id)).toBeUndefined();
  });

  it('rootMissing records the folder it creates, so the next sync is no switch', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    const r = await a.sync.syncNow();
    expect(r.ignored).toEqual([]);
    expect(await notes(a)).toEqual([expect.stringMatching(/was missing/)]);
    expect(a.local.data.get(SYNC_ROOT_KEY)).toBe(rootOf(tree)!.id);
    expect(await a.sync.syncNow()).toEqual({ merged: 0, conflicts: [], ignored: [] });
    expect(folders(tree).map((f) => f.id)).toEqual([p.id]);
  });

  it('a write that fails in a switched sync keeps no base, so the next sync writes the project instead of deleting it', async () => {
    const localA = new FakeBookmarkPort();
    const account = accountTree();
    const view = switching(localA, account);
    const a = device(view as unknown as FakeBookmarkPort);
    const b = device(account);
    await b.keep('bee');
    await b.sync.syncNow();
    const one = await a.keep('one');
    await a.sync.syncNow();
    const create = account.create.bind(account);
    let fail = true;
    account.create = async (q) => { if (fail && q.title === 'one') throw new Error('quota'); return create(q); };
    view.use(account);
    const r = await a.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining('quota')]);
    expect(await notes(a)).toEqual([expect.stringMatching(SWITCHED)]);
    expect(a.local.data.get(SYNC_BASE_KEY)).not.toHaveProperty(one.id);
    fail = false;
    expect((await a.sync.syncNow()).ignored).toEqual([]);
    expect(await a.get(one.id)).toMatchObject({ keep: true, name: 'one' });
    expect(folders(account).map((f) => f.id)).toContain(one.id);
  });

  it('no M4-R35 hold in a switched sync: a based project missing from the new folder is written there, not held', async () => {
    const localA = new FakeBookmarkPort();
    const account = accountTree();
    const view = switching(localA, account);
    const a = device(view as unknown as FakeBookmarkPort);
    const b = device(account);
    const trip = await b.keep('trip');
    await b.sync.syncNow();
    // trip's metadata hand-edited in the account folder: unreadable there.
    const meta = rootOf(account)!.children!.find((c) => c.title === 'trip')!.children![0]!;
    await account.update(meta.id, { title: meta.title, url: toFolder({ ...toSynced(trip), id: 'manual-project:other' }).children![0]!.url! });
    const one = await a.keep('one');
    await a.sync.syncNow();
    view.use(account);
    const r = await a.sync.syncNow();
    expect(r.ignored).toEqual(expect.arrayContaining([expect.stringContaining('folder "trip"')]));
    expect(await notes(a)).toEqual([expect.stringMatching(SWITCHED)]);
    expect(r.ignored).not.toEqual(expect.arrayContaining([expect.stringContaining(one.id)]));
    expect(folders(account).filter((f) => f.id === one.id)).toHaveLength(1);
    expect(await a.get(one.id)).toMatchObject({ keep: true });
    expect(a.local.data.get(SYNC_ROOT_KEY)).toBe(rootOf(account)!.id);
  });
});

describe('M4-R42: an empty project folder is not unreadable', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('an empty folder beside the real one (left by a worker or Chrome quitting mid-create) does not hold a remote delete', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    await tree.create({ parentId: rootOf(tree)!.id, title: 'trip' });
    await b.svc.remove(p.id);
    await b.sync.syncNow();
    const r = await a.sync.syncNow();
    expect(r).toEqual({ merged: 1, conflicts: [], ignored: [] });
    expect(await a.get(p.id)).toBeUndefined();
  });
});

describe('M4-R42: the metadata bookmark never becomes a saved tab', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('a tab opened from that bookmark that joins a kept project does not enter the synced saved list', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    const meta = rootOf(tree)!.children![0]!.children![0]!.url!;
    await a.edit(p.id, (x) => { x.saved!.tabs.push({ url: meta, title: "Tabchef project data (don't edit)" }); });
    expect((await a.sync.syncNow()).ignored).toEqual([]);
    const writes = tree.writes();
    expect(await a.sync.syncNow()).toEqual({ merged: 0, conflicts: [], ignored: [] }); // no flip-flop
    expect(tree.writes()).toBe(writes);
    expect(rootOf(tree)!.children![0]!.children!.filter((c) => c.url?.startsWith('https://tabchef.invalid/'))).toHaveLength(1);
    expect(folders(tree)[0]!.groups.flatMap((g) => g.tabs.map((t) => t.url))).toEqual([B, A]);
    expect((await a.get(p.id))!.saved!.tabs.map((t) => t.url)).toContain(meta); // the open tab stays in the local list
  });
});

// M4-R44: Close and save on one device must not remove, on every device, a saved URL added on another.
describe('M4-R44: Close and save keeps a URL added on another device', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const tab = (id: number, url: string) => ({ id, windowId: 1, url, title: url, pinned: false, incognito: false, discarded: false, active: false, audible: false });

  for (const action of ['closeAndSave', 'closeAndArchive'] as const) {
    it(`A's list is [A, B, C] with C added on B and open nowhere; ${action} on A keeps C on both devices`, async () => {
      const tree = new FakeBookmarkPort();
      const a = device(tree);
      const b = device(tree);
      a.port.addTab(tab(1, A));
      a.port.addTab(tab(2, B));
      a.port.addTab(tab(9, 'https://other.example/'));
      const id = await a.svc.create(MANUAL, 'Taxes', [1, 2]); // open on A
      await a.svc.targets(await a.port.snapshot());
      await a.sync.syncNow();
      await b.sync.syncNow();
      await b.edit(id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); }); // added on B
      await b.sync.syncNow();
      await a.sync.syncNow();
      a.clock.now += 1_000;
      await a.svc.targets(await a.port.snapshot());
      expect((await a.get(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
      a.clock.now += 1_000;
      expect((await a.svc[action](id)).closed).toBe(2);
      await a.sync.syncNow();
      await b.sync.syncNow();
      await a.sync.syncNow();
      for (const d of [a, b]) expect((await d.get(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
      expect(folders(tree)[0]?.groups.flatMap((g) => g.tabs.map((t) => t.url))).toContain(C);
    });
  }
});

// M4-R45: a base must only stand for a folder in the Tabchef folder recorded with it (M4-R40). When the Tabchef folder
// is missing, the sync writes into a new one; a project it does not write there (a failed write, an unreadable saved
// list, metadata over 8 KB) must keep no base, or the next sync reads "base, no folder, unchanged" as a remote delete.
describe('M4-R45: a rootMissing sync keeps no base for a project it did not write into the new folder', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const baseOf = (d: { local: { data: Map<string, unknown> } }) => (d.local.data.get(SYNC_BASE_KEY) ?? {}) as Record<string, unknown>;

  it('the folder create fails once; the next sync writes the project instead of deleting it', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    const create = tree.create.bind(tree);
    let fail = true;
    tree.create = async (q) => { if (fail && q.title === 'taxes') throw new Error('boom'); return create(q); };
    const r = await d.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringContaining('boom')]);
    expect(await notes(d)).toEqual([expect.stringMatching(/was missing/)]);
    expect(baseOf(d)).not.toHaveProperty(p.id);
    fail = false;
    expect(await d.sync.syncNow()).toEqual({ merged: 1, conflicts: [], ignored: [] });
    expect(content([await d.get(p.id)])).toEqual([toSynced(p)]);
    expect(folders(tree).map((f) => f.id)).toEqual([p.id]);
  });

  it('the bookmarks permission revoked mid-write (root made, every project fails): on re-grant nothing is removed', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    const q = await d.keep('trip');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    const create = tree.create.bind(tree);
    let revoked = false;
    tree.create = async (x) => {
      if (revoked) throw new Error("Cannot read properties of undefined (reading 'create')");
      const id = await create(x);
      if (x.title === ROOT_TITLE) revoked = true; // revoked right after the Tabchef folder was made
      return id;
    };
    const r = await d.sync.syncNow();
    expect(r.ignored).toHaveLength(2); // two failed projects
    expect(await notes(d)).toEqual([expect.stringMatching(/was missing/)]);
    // Never re-granted: nothing more runs. What is stored must not hold a delete for either project.
    expect(baseOf(d)).not.toHaveProperty(p.id);
    expect(baseOf(d)).not.toHaveProperty(q.id);
    revoked = false; // re-granted
    const r2 = await d.sync.syncNow();
    expect(r2.conflicts).toEqual([]);
    expect(r2.ignored).toEqual([]);
    expect(content([await d.get(p.id), await d.get(q.id)])).toEqual([toSynced(p), toSynced(q)]);
    expect(folders(tree).map((f) => f.id).sort()).toEqual([p.id, q.id].sort());
  });

  it('sibling (unsynced): a project whose saved list is unreadable during the rootMissing sync is not deleted once it can be read', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const p = await a.keep('taxes');
    await a.keep('trip');
    await a.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    // taxes' stored saved list is corrupted; a new worker reads it (the store drops it).
    a.local.data.set(PROJECTS_KEY, (a.local.data.get(PROJECTS_KEY) as Project[]).map((x) => (x.id === p.id ? { ...x, saved: { tabs: 'broken', at: 1 } } : x)));
    const a2 = device(tree);
    for (const [k, v] of a.local.data) a2.local.data.set(k, structuredClone(v));
    const r = await a2.sync.syncNow(); // rootMissing: trip is written into a new folder, taxes is skipped
    expect(r.ignored).toEqual([expect.stringContaining(p.id)]);
    expect(await notes(a2)).toEqual([expect.stringMatching(/was missing/)]);
    expect(baseOf(a2)).not.toHaveProperty(p.id);
    // The same saved list stored again (close and save, a pass): content equal to the old base.
    await a2.edit(p.id, (x) => { x.saved = structuredClone(p.saved); });
    const r2 = await a2.sync.syncNow();
    expect(r2.conflicts).toEqual([]);
    expect(await a2.get(p.id)).toMatchObject({ keep: true });
    expect(folders(tree).map((f) => f.id)).toContain(p.id);
  });

  it('sibling (8 KB): a project over the size limit during the rootMissing sync is not deleted once it fits again', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.keep('trip');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    await d.edit(p.id, (x) => { x.syncExtra = { blob: 'x'.repeat(9000) }; });
    const r = await d.sync.syncNow(); // rootMissing: trip is written, taxes is skipped (too large)
    expect(r.ignored).toEqual([expect.stringContaining(p.id)]);
    expect(await notes(d)).toEqual([expect.stringMatching(/was missing/)]);
    expect(baseOf(d)).not.toHaveProperty(p.id);
    await d.edit(p.id, (x) => { delete x.syncExtra; }); // back to its old content
    const r2 = await d.sync.syncNow();
    expect(r2.conflicts).toEqual([]);
    expect(await d.get(p.id)).toMatchObject({ keep: true });
    expect(folders(tree).map((f) => f.id)).toContain(p.id);
  });

  it('control (M4-R19 kept): with the folder present, a delete from another device while the saved list is unreadable here still applies', async () => {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    const p = await a.keep('taxes');
    await a.sync.syncNow();
    await b.sync.syncNow();
    a.local.data.set(PROJECTS_KEY, [{ ...p, saved: { tabs: 'broken', at: 1 } }]);
    const a2 = device(tree);
    for (const [k, v] of a.local.data) a2.local.data.set(k, structuredClone(v));
    await a2.sync.syncNow(); // skipped, base kept
    await b.svc.remove(p.id);
    await b.sync.syncNow(); // its folder goes
    expect(baseOf(a2)).toHaveProperty(p.id);
    await a2.sync.syncNow(); // still unreadable: base still kept (the delete marker)
    expect(baseOf(a2)).toHaveProperty(p.id);
    await a2.edit(p.id, (x) => { x.saved = structuredClone(p.saved); });
    await a2.sync.syncNow();
    expect(await a2.get(p.id)).toBeUndefined();
  });

  it('control: in a normal sync a failed write of a project whose folder exists keeps its base and retries; nothing is removed', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('taxes');
    await d.sync.syncNow();
    await d.edit(p.id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); });
    const create = tree.create.bind(tree);
    let fail = true;
    tree.create = async (q) => { if (fail && q.url === C) throw new Error('boom'); return create(q); };
    expect((await d.sync.syncNow()).ignored).toEqual([expect.stringContaining('boom')]);
    expect(baseOf(d)[p.id]).toEqual(toSynced(p));
    fail = false;
    expect((await d.sync.syncNow()).ignored).toEqual([]);
    expect(folders(tree)[0]!.groups.flatMap((g) => g.tabs.map((t) => t.url)).sort()).toEqual([A, B, C].sort());
  });
});

// M4-R46: one-time sync reports (a kept edit after a delete, the missing-folder line, the M4-R40 switch line)
// must still be listed after the echo sync that every changing sync triggers, and after a later sync that changes
// something else. Shape-agnostic: the text only has to be somewhere in the status the Projects page reads.
describe('M4-R46: one-time sync reports outlive the next sync', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  afterEach(() => { vi.useRealTimers(); });
  const shown = async (d: ReturnType<typeof device>) => JSON.stringify(await d.sync.status());
  const KEPT = /kept the edit/;

  it('event-driven: a kept edit is still listed after the echo sync', async () => {
    vi.useFakeTimers();
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const edited = await d.keep('edited');
    await d.sync.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10_000); // first sync and its echo settle
    await d.edit(edited.id, (x) => { x.name = 'Edited here'; });
    await tree.removeTree(rootOf(tree)!.children![0]!.id); // the user deletes the folder by hand meanwhile
    await vi.advanceTimersByTimeAsync(2_100); // the debounced sync: conflict, edit written back
    expect(await shown(d)).toMatch(KEPT);
    await vi.advanceTimersByTimeAsync(3_000); // its echo (own put + own bookmark writes) runs and changes nothing
    expect(await d.get(edited.id)).toMatchObject({ name: 'Edited here', keep: true });
    expect(await shown(d)).toMatch(KEPT); // fails at f1653cd: {"merged":0,"conflicts":[],"ignored":[]}
  });

  it('direct: the missing-folder line is still listed after the next sync', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    await d.sync.syncNow();
    expect(await shown(d)).toMatch(/was missing/);
    await d.sync.syncNow(); // the echo
    expect(await shown(d)).toMatch(/was missing/); // fails at f1653cd
  });

  it('direct: the M4-R40 switch line is still listed after the next sync', async () => {
    const localA = new FakeBookmarkPort();
    const account = accountTree();
    const view = switching(localA, account);
    const a = device(view as unknown as FakeBookmarkPort);
    const b = device(account);
    await b.keep('bee');
    await b.sync.syncNow();
    await a.keep('one');
    await a.sync.syncNow();
    view.use(account); // A signs in to Chrome
    await a.sync.syncNow();
    expect(await shown(a)).toMatch(/different Tabchef bookmark folder/);
    await a.sync.syncNow(); // the echo
    expect(await shown(a)).toMatch(/different Tabchef bookmark folder/); // fails at f1653cd
  });

  it('a later sync that does change something (an edit to another project) does not drop the kept edit either', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const edited = await d.keep('edited');
    const other = await d.keep('other');
    await d.sync.syncNow();
    await d.edit(edited.id, (x) => { x.name = 'Edited here'; });
    await tree.removeTree(rootOf(tree)!.children!.find((c) => c.title === 'edited')!.id);
    expect((await d.sync.syncNow()).conflicts).toEqual([expect.stringMatching(KEPT)]);
    await d.edit(other.id, (x) => { x.name = 'Other renamed'; }); // e.g. a tab pass refreshing a saved list
    expect((await d.sync.syncNow()).merged).toBe(1);
    expect(await shown(d)).toMatch(KEPT); // fails at f1653cd, and under "keep the last report when nothing changed"
  });

  it('a failed sync does not drop an earlier kept edit', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const edited = await d.keep('edited');
    const other = await d.keep('other');
    await d.sync.syncNow();
    await d.edit(edited.id, (x) => { x.name = 'Edited here'; });
    await tree.removeTree(rootOf(tree)!.children!.find((c) => c.title === 'edited')!.id);
    await d.sync.syncNow();
    await d.edit(other.id, (x) => { x.name = 'Other renamed'; });
    const children = tree.children.bind(tree);
    tree.children = async () => { throw new Error('bookmarks unavailable'); };
    await expect(d.sync.syncNow()).rejects.toThrow(/unavailable/);
    tree.children = children;
    const s = await shown(d);
    expect(s).toMatch(/unavailable/); // the failure is shown
    expect(s).toMatch(KEPT); // fails at f1653cd: the catch path writes the whole status object
  });

  it('m-1: the switch line is not listed under the skipped items (lastResult.ignored)', async () => {
    const localA = new FakeBookmarkPort();
    const account = accountTree();
    const view = switching(localA, account);
    const a = device(view as unknown as FakeBookmarkPort);
    const b = device(account);
    await b.keep('bee');
    await b.sync.syncNow();
    await a.keep('one');
    await a.sync.syncNow();
    view.use(account);
    await a.sync.syncNow();
    const s = await a.sync.status();
    const ignored = s.lastResult && 'ignored' in s.lastResult ? s.lastResult.ignored : [];
    expect(ignored.join('\n')).not.toMatch(/different Tabchef bookmark folder/); // fails at f1653cd
  });

  it('control: a repeating skip (a folder that cannot be read) is listed again by every sync, echo included', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await d.sync.syncNow();
    await tree.create({ parentId: rootOf(tree)!.id, title: 'odd' });
    await tree.create({ parentId: rootOf(tree)!.children!.find((c) => c.title === 'odd')!.id, title: 'x', url: 'https://x.example/' });
    await d.sync.syncNow();
    const first = await shown(d);
    await d.sync.syncNow();
    expect(await shown(d)).toBe(first.replace(/"lastSyncAt":\d+/, `"lastSyncAt":${d.clock.now}`)); // passes at f1653cd
    expect(first).toMatch(/odd|project data/);
  });
});

describe('M4-R46: dismissing the sync notes', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('dismiss clears the notes the page showed; a later sync with nothing new keeps them cleared', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    await d.sync.syncNow();
    const shown = (await d.sync.status()).notices!;
    expect(shown).toEqual([{ at: d.clock.now, text: expect.stringMatching(/was missing/) }]);
    expect((await d.sync.dismiss(shown[0]!.at)).notices ?? []).toEqual([]);
    await d.sync.syncNow();
    expect((await d.sync.status()).notices ?? []).toEqual([]);
  });

  it('a dismiss sent mid-sync waits for it and keeps the note that sync adds (the same text, reported again later)', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    await d.sync.syncNow();
    const upTo = (await d.sync.status()).notices![0]!.at; // what the page shows
    d.clock.now += 1_000;
    await tree.removeTree(rootOf(tree)!.id);
    const running = d.sync.syncNow();
    const dismissed = d.sync.dismiss(upTo); // queued behind the running sync, which reports the text again
    await running;
    expect((await dismissed).notices).toEqual([{ at: d.clock.now, text: expect.stringMatching(/was missing/) }]);
  });

  it('a note a sync adds between the page load and the Dismiss click stays', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const edited = await d.keep('edited');
    await d.sync.syncNow();
    await tree.removeTree(rootOf(tree)!.id);
    await d.sync.syncNow();
    const upTo = Math.max(...(await d.sync.status()).notices!.map((n) => n.at)); // the page loads
    d.clock.now += 1_000;
    await d.edit(edited.id, (x) => { x.name = 'Edited here'; });
    await tree.removeTree(rootOf(tree)!.children!.find((c) => c.title === 'edited')!.id);
    await d.sync.syncNow(); // a kept edit, after the page loaded
    expect((await d.sync.dismiss(upTo)).notices).toEqual([{ at: d.clock.now, text: expect.stringMatching(/kept the edit/) }]);
  });

  it('keeps the newest 20 notes', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await d.sync.syncNow();
    const old = Array.from({ length: 20 }, (_, i) => ({ at: i + 1, text: `note ${i + 1}` }));
    d.local.data.set(SYNC_STATUS_KEY, { lastSyncAt: 20, notices: old });
    await tree.removeTree(rootOf(tree)!.id);
    await d.sync.syncNow();
    const notices = (await d.sync.status()).notices!;
    expect(notices).toHaveLength(20);
    expect(notices.slice(0, 19)).toEqual(old.slice(1)); // the oldest one goes
    expect(notices[19]).toEqual({ at: d.clock.now, text: expect.stringMatching(/was missing/) });
  });

  it('the same text again is listed once, with its new time', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await d.sync.syncNow();
    for (let i = 0; i < 3; i++) {
      d.clock.now += 1_000;
      await tree.removeTree(rootOf(tree)!.id);
      await d.sync.syncNow();
    }
    expect((await d.sync.status()).notices).toEqual([{ at: d.clock.now, text: expect.stringMatching(/was missing/) }]);
  });
});

describe('M4-R49: readFolders tells unreadable folders apart', () => {
  it('two same-titled folders without project data give two different lines, each with its position', async () => {
    const tree = new FakeBookmarkPort();
    const root = await tree.create({ parentId: '2', title: ROOT_TITLE });
    for (let i = 0; i < 2; i++) {
      const f = await tree.create({ parentId: root, title: 'New folder' });
      await tree.create({ parentId: f, title: 'n', url: `https://n${i}.example/` });
    }
    const s = await readFolders(tree, {});
    expect(s.ignored).toEqual([
      'folder "New folder" (#1 in the Tabchef folder) has no project metadata bookmark',
      'folder "New folder" (#2 in the Tabchef folder) has no project metadata bookmark',
    ]);
    expect(s.unreadable).toBe(true);
  });
  it("a folder title with $ patterns ($&, $', $$) is named as it is", async () => {
    const tree = new FakeBookmarkPort();
    const root = await tree.create({ parentId: '2', title: ROOT_TITLE });
    const f = await tree.create({ parentId: root, title: "Q$&A $'x $$" });
    await tree.create({ parentId: f, title: 'n', url: 'https://n.example/' });
    const s = await readFolders(tree, {});
    expect(s.ignored).toEqual([`folder "Q$&A $'x $$" (#1 in the Tabchef folder) has no project metadata bookmark`]);
  });
  it('two extra Tabchef folders holding something else give two different lines', async () => {
    const tree = new FakeBookmarkPort();
    await tree.create({ parentId: '2', title: ROOT_TITLE });
    for (let i = 0; i < 2; i++) {
      const r = await tree.create({ parentId: '2', title: ROOT_TITLE });
      await tree.create({ parentId: r, title: 'x', url: `https://x${i}.example/` });
    }
    const s = await readFolders(tree, {});
    expect(s.ignored).toHaveLength(2);
    expect(new Set(s.ignored).size).toBe(2);
    expect(s.ignored[0]).toMatch(/Other bookmarks \(#2\)/);
    expect(s.ignored[1]).toMatch(/Other bookmarks \(#3\)/);
  });
});

// M4-R51: Keep off → on within the sync debounce must not read as a removal.
describe('M4-R51: Keep off then on never deletes a synced saved tab from every device', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const tab = (id: number, url: string) => ({ id, windowId: 1, url, title: url, pinned: false, incognito: false, discarded: false, active: false, audible: false });
  const urlsOf = async (d: ReturnType<typeof device>, id: string) => (await d.get(id))?.saved?.tabs.map((t) => t.url);

  /** B creates Taxes with A, B open; both sync; A adds C (never open on B); both sync: B's list is [A, B, C]. */
  async function setup() {
    const tree = new FakeBookmarkPort();
    const a = device(tree);
    const b = device(tree);
    b.port.addTab(tab(1, A));
    b.port.addTab(tab(2, B));
    b.port.addTab(tab(9, 'https://other.example/'));
    const id = await b.svc.create(MANUAL, 'Taxes', [1, 2]);
    await b.svc.targets(await b.port.snapshot());
    await b.sync.syncNow();
    await a.sync.syncNow();
    await a.edit(id, (x) => { x.saved!.tabs.push({ url: C, title: 'C' }); });
    await a.sync.syncNow();
    await b.sync.syncNow();
    b.clock.now += 1_000;
    await b.svc.targets(await b.port.snapshot());
    expect(await urlsOf(b, id)).toEqual([A, B, C]);
    return { tree, a, b, id };
  }

  it('Keep off then on before the next sync keeps C on both devices', async () => {
    const { tree, a, b, id } = await setup();
    await b.svc.setKeep(id, false);
    await b.svc.setKeep(id, true);
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) expect(await urlsOf(d, id)).toContain(C);
    expect(folders(tree)[0]?.groups.flatMap((g) => g.tabs.map((t) => t.url))).toContain(C);
  });

  it('Keep off, a pass, then Keep on before the next sync keeps C on both devices', async () => {
    const { a, b, id } = await setup();
    await b.svc.setKeep(id, false);
    b.clock.now += 1_000;
    await b.svc.targets(await b.port.snapshot());
    await b.svc.setKeep(id, true);
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) expect(await urlsOf(d, id)).toContain(C);
  });

  it('control: Keep off, a tab closed here, Keep on: the close syncs as a removal (this device saw it)', async () => {
    const { a, b, id } = await setup();
    await b.svc.setKeep(id, false);
    await b.port.closeTab(2);
    b.clock.now += 1_000;
    await b.svc.targets(await b.port.snapshot());
    await b.svc.setKeep(id, true);
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) expect(await urlsOf(d, id)).toEqual([A, C]);
  });

  it('control: a not-kept project whose list the pass refreshes stays out of sync (its folder goes, nothing is written back)', async () => {
    const { tree, b, id } = await setup();
    await b.svc.setKeep(id, false);
    await b.sync.syncNow();
    expect(folders(tree)).toEqual([]);
    await b.port.closeTab(2);
    b.clock.now += 1_000;
    await b.svc.targets(await b.port.snapshot());
    expect(await urlsOf(b, id)).toEqual([A, C]);
    const r = await b.sync.syncNow();
    expect(r.merged).toBe(0);
    expect(folders(tree)).toEqual([]);
  });

  it('sibling (M4-R44 3(a)): Keep off then Close and save before the next sync keeps C on both devices', async () => {
    const { a, b, id } = await setup();
    await b.svc.setKeep(id, false);
    await b.svc.closeAndSave(id);
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) expect(await urlsOf(d, id)).toContain(C);
  });
});

// A saved tab records its Chrome group's title, and a project's tabs sit in the project's own group: they are written
// loose in the project folder, never in a subfolder repeating its name (1.6.0 did: Media / Media / tabs).
describe("ProjectSync: a project's own group is its folder", () => {
  beforeEach(() => { fakeBrowser.reset(); });

  const tabsOf = (tree: FakeBookmarkPort, title: string) => rootOf(tree)!.children!.find((f) => f.title === title)!.children!.slice(1).map((c) => c.url ?? c.title);

  it('a Manual project: its tabs in its own group are written loose, and a 1.6.0 folder is flattened once', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('media', { name: 'Media', saved: { tabs: [{ url: A, title: 'A', group: 'Media' }, { url: B, title: 'B', group: 'Other' }], at: 1 } });
    await d.sync.syncNow();
    expect(tabsOf(tree, 'Media')).toEqual(['Other', A]);
    // As 1.6.0 wrote it: the project's own group as a subfolder.
    const folder = rootOf(tree)!.children!.find((f) => f.title === 'Media')!;
    const loose = folder.children!.find((c) => c.url === A)!;
    await tree.remove(loose.id);
    await tree.create({ parentId: folder.id, title: 'Media' });
    const sub = rootOf(tree)!.children!.find((f) => f.title === 'Media')!.children!.find((c) => c.title === 'Media' && !c.url)!;
    await tree.create({ parentId: sub.id, title: 'A', url: A });
    // ...and its base (1.6.0 made it with the same toSynced).
    const nested = fromFolder(rootOf(tree)!.children!.find((f) => f.title === 'Media')! as FolderNode) as SyncedProject;
    expect(nested.groups.map((g) => g.title)).toEqual(['Other', 'Media']);
    d.local.data.set(SYNC_BASE_KEY, { [p.id]: nested });
    expect(await d.sync.syncNow()).toMatchObject({ merged: 1 });
    expect(tabsOf(tree, 'Media')).toEqual(['Other', A]);
    expect(content([await d.get(p.id)])).toEqual([toSynced(p)]);
    expect(await d.sync.syncNow()).toMatchObject({ merged: 0 });
    expect(tabsOf(tree, 'Media')).toEqual(['Other', A]);
  });

  it('a 1.6.0 device writing the nested folder again: the two converge on the flat one', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    const p = await d.keep('media', { name: 'Media', saved: { tabs: [{ url: A, title: 'A', group: 'Media' }], at: 1 } });
    await d.sync.syncNow();
    const folder = rootOf(tree)!.children!.find((f) => f.title === 'Media')!;
    await tree.remove(folder.children!.find((c) => c.url === A)!.id);
    const sub = await tree.create({ parentId: folder.id, title: 'Media' });
    await tree.create({ parentId: sub, title: 'A', url: A });
    for (let i = 0; i < 3; i++) await d.sync.syncNow();
    expect(tabsOf(tree, 'Media')).toEqual([A]);
    expect(content([await d.get(p.id)])).toEqual([toSynced(p)]);
    expect(await d.sync.syncNow()).toMatchObject({ merged: 0 });
  });

  it("a rule project: its tabs in its own group (its recipe's title) are written loose", async () => {
    const tree = new FakeBookmarkPort();
    const config: Config = { ...defaultConfig(), recipes: builtinRecipeRefs({ 'jira-ticket-title': true }) };
    config.recipes = config.recipes.map((r) => (r.id === 'jira-ticket-title' ? { ...r, params: { titleFormat: '{key} · {summary}' } } : r));
    const d = device(tree, { config });
    const def = d.program.projects!.find((x) => x.recipeId === 'jira-ticket-title')!;
    const p: Project = {
      id: 'jira-ticket-title:ABC-1', recipeId: 'jira-ticket-title', key: 'ABC-1', summary: 'Login fails', keep: true, createdAt: 1, updatedAt: 1,
      manual: [], excluded: [], linked: [], saved: { tabs: [{ url: A, title: 'A', group: 'ABC-1 · Login fails' }, { url: B, title: 'B' }], at: 1 },
    };
    expect(projectGroupTitle(def, p)).toBe('ABC-1 · Login fails');
    await d.store.put(p);
    await d.sync.syncNow();
    expect(tabsOf(tree, 'ABC-1')).toEqual([A, B]);
    expect(await d.sync.syncNow()).toMatchObject({ merged: 0 });
  });
});
