// M4 T14: ProjectSync — kept projects ↔ the `Tabchef` bookmark folder. Two devices share one FakeBookmarkPort (the
// tree Chrome Sync keeps equal); each has its own storage.local, ProjectStore and ProjectService.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { fromFolder, toFolder, ROOT_TITLE, type FolderNode, type SyncedProject } from '../../src/core/projects/bookmark-format';
import { toSynced, sameContent } from '../../src/core/projects/sync-plan';
import type { Project } from '../../src/core/projects/types';
import { PROJECTS_KEY, ProjectService, ProjectStore } from '../../src/engine/projects';
import { ProjectSync, SYNC_BASE_KEY, SYNC_STATUS_KEY, SYNC_TOGGLE_KEY } from '../../src/engine/project-sync';
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
function device(tree: FakeBookmarkPort, o: { granted?: boolean; debounceMs?: number } = {}) {
  const program = compileProgram(defaultConfig(), builtinRecipes()).program;
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
    expect(r.ignored).toEqual([expect.stringMatching(/Tabchef bookmark folder was missing/)]);
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
    expect(r.ignored).toEqual([expect.stringContaining('My notes')]);
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

  it('a second Tabchef folder holding something else is left as it is and reported', async () => {
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    await tree.create({ parentId: '2', title: ROOT_TITLE });
    const r2 = await tree.create({ parentId: '2', title: ROOT_TITLE });
    await tree.create({ parentId: r2, title: 'mine', url: 'https://mine.example/' });
    const before = structuredClone(tree.root.children![1]!.children![1]);
    const r = await d.sync.syncNow();
    expect(r.ignored).toEqual([expect.stringMatching(/second Tabchef folder/)]);
    expect(tree.root.children![1]!.children![1]).toEqual(before);
    expect(folders(tree)).toHaveLength(1);
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
    expect(await d.sync.status()).toEqual({ enabled: false });
  });

  it('on with the toggle and the permission: syncs after the debounce; status has lastSyncAt and lastResult', async () => {
    vi.useFakeTimers();
    const tree = new FakeBookmarkPort();
    const d = device(tree);
    await d.keep('taxes');
    expect(await d.sync.setEnabled(true)).toEqual({ enabled: true });
    expect(d.local.data.get(SYNC_TOGGLE_KEY)).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(folders(tree)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(folders(tree)).toHaveLength(1);
    expect(await d.sync.status()).toEqual({ enabled: true, lastSyncAt: d.clock.now, lastResult: { merged: 1, conflicts: [], ignored: [] } });
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
