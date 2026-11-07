// M4 T7: saved tab lists, close-and-save and reopen (ProjectService.closeAndSave / reopen / setKeep), kept projects
// never pruned (Review Focus 5) and `updatedAt`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { PROJECTS_KEY, PRUNE_AFTER_MS, ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Program } from '../../src/core/lang/types';
import type { Config, TabSnap } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const MANUAL = 'manual-project';
const A = 'https://a.example/';
const B = 'https://b.example/';
const C = 'https://c.example/';

function program(over: Partial<Config> = {}): Program {
  const { program: p, errors } = compileProgram({ ...defaultConfig(), ...over }, builtinRecipes());
  expect(errors).toEqual([]);
  return p;
}
const tab = (id: number, url: string, o: Partial<TabSnap> = {}) => ({
  id, windowId: 1, url, title: `T ${url}`, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const memoryArea = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))]))),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); }),
  };
};
const memorySession = () => {
  const data = new Map<string, unknown>();
  return { data, get: async (k: string) => structuredClone(data.get(k)), set: async (k: string, v: unknown) => { data.set(k, structuredClone(v)); } };
};

function harness(o: { program?: Program; port?: FakeBrowserPort; local?: ReturnType<typeof memoryArea>; session?: ReturnType<typeof memorySession>; clock?: { now: number } } = {}) {
  const p = o.program ?? program();
  const f = o.port ?? (() => { const x = new FakeBrowserPort(); x.addWindow(1, { focused: true }); return x; })();
  const local = o.local ?? memoryArea();
  const clock = o.clock ?? { now: NOW };
  const formEdited = new Set<number>();
  const closed: { url: string; title: string; windowId: number; reason: string }[] = [];
  const logs: { tabId?: number; action: string; detail: string }[] = [];
  const store = new ProjectStore(local);
  const schedule = vi.fn();
  const toast = vi.fn();
  const sources = {
    factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined,
  };
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p, sources, facts: { get: () => undefined }, log: { add: (e) => logs.push(e) },
    recentlyClosed: { add: (e) => { closed.push(e); return `rc${closed.length}`; } },
    safety: { isProtected: (t) => t.pinned || formEdited.has(t.id) },
    state: () => r.liveState(), schedule, toast, now: () => clock.now, ...(o.session && { session: o.session }),
    recipeName: async (id) => builtinRecipes()[id]?.name,
  });
  r = new Reconciler(f, async () => p, { projects: svc, now: () => clock.now, log: { add: (e) => logs.push(e) } });
  const groupOf = (id: number) => f.state.groups.find((g) => g.id === f.state.tabs.find((t) => t.id === id)?.groupId)?.title;
  const stored = async (id: string) => (await store.list()).find((x) => x.id === id);
  return { f, local, clock, formEdited, closed, logs, store, schedule, toast, svc, r, groupOf, stored };
}

/** A Manual project "Taxes" holding tabs 1 (A), 2 (B), 3 (C) of window 1, grouped. */
async function taxes(h: ReturnType<typeof harness>, urls = [A, B, C], windowId = 1): Promise<string> {
  urls.forEach((u, i) => h.f.addTab(tab(i + 1, u, { windowId })));
  const id = await h.svc.create(MANUAL, 'Taxes', urls.map((_, i) => i + 1));
  await h.r.flush();
  return id;
}

describe('ProjectService.closeAndSave', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('of 3 tabs, one form-edited: closes 2, saves all 3 in tab-bar order with their group, keeps the project', async () => {
    const h = harness();
    const id = await taxes(h);
    expect([1, 2, 3].map(h.groupOf)).toEqual(['Taxes', 'Taxes', 'Taxes']);
    h.formEdited.add(2);
    h.clock.now = NOW + 5;
    expect(await h.svc.closeAndSave(id)).toEqual({ closed: 2, skipped: 1, ids: ['rc1', 'rc2'] });
    expect(h.f.state.tabs.map((t) => t.id)).toEqual([2]); // the protected tab stays open…
    const p = await h.stored(id);
    expect(p?.saved).toEqual({
      at: NOW + 5, closed: true,
      tabs: [{ url: A, title: `T ${A}`, group: 'Taxes' }, { url: B, title: `T ${B}`, group: 'Taxes' }, { url: C, title: `T ${C}`, group: 'Taxes' }],
    }); // …and stays in `saved`
    expect(p).toMatchObject({ keep: true, updatedAt: NOW + 5 });
    expect(p).not.toHaveProperty('closedAt'); // a tab remains: still open
    expect(h.closed.map((c) => [c.url, c.reason])).toEqual([[A, 'project-closed'], [C, 'project-closed']]);
  });

  it('the protected tab it left open, later closed by hand, never shrinks the saved list (until reopen)', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(2);
    await h.svc.closeAndSave(id);
    await h.r.flush();
    h.formEdited.delete(2);
    await h.f.closeTab(2);
    await h.r.flush();
    expect((await h.stored(id))?.saved).toMatchObject({ closed: true, tabs: [{ url: A }, { url: B }, { url: C }] });
    expect(await h.svc.reopen(id)).toEqual({ opened: 3 });
    await h.r.flush();
    const p = await h.stored(id);
    expect(p?.saved?.closed).toBeUndefined(); // open again: the list follows its tabs
    expect(p?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
  });

  it('Close and save again, after a first one left a protected tab open, keeps the frozen list (M4-R14)', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(2);
    await h.svc.closeAndSave(id); // A and C close, B (form-edited) stays open: frozen [A, B, C]
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
    h.formEdited.delete(2); // the user submits the form…
    h.clock.now += MIN;
    expect(await h.svc.closeAndSave(id)).toMatchObject({ closed: 1, skipped: 0 }); // …and closes the rest
    expect((await h.stored(id))?.saved).toMatchObject({ closed: true, tabs: [{ url: A }, { url: B }, { url: C }] });
  });

  it('stores the saved list and keep before closing the first tab (a worker restart mid-close keeps the list)', async () => {
    const h = harness();
    const id = await taxes(h);
    await h.svc.setKeep(id, false);
    const close = h.f.closeTab.bind(h.f);
    const atFirstClose: unknown[] = [];
    vi.spyOn(h.f, 'closeTab').mockImplementation(async (tabId) => {
      if (atFirstClose.length === 0) atFirstClose.push(structuredClone(await h.stored(id)));
      return close(tabId);
    });
    await h.svc.closeAndSave(id);
    expect(atFirstClose[0]).toMatchObject({ keep: true, saved: { closed: true, tabs: [{ url: A }, { url: B }, { url: C }] } });
  });

  it("its undo toast names a Manual project by its name, not its key", async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    expect(h.toast.mock.calls.map((c) => c[1])).toEqual(['Closed 2 tabs with project Taxes.']);
  });

  it('keeps a project that was not kept (a rule-made one would be pruned otherwise)', async () => {
    const h = harness();
    const id = await taxes(h, [A]);
    await h.svc.setKeep(id, false);
    expect((await h.stored(id))?.keep).toBeUndefined();
    await h.svc.closeAndSave(id);
    expect(await h.stored(id)).toMatchObject({ keep: true, closedAt: NOW, closedIds: ['rc1'], saved: { tabs: [{ url: A }] } });
  });

  it('an unknown project throws and closes nothing', async () => {
    const h = harness();
    await taxes(h);
    await expect(h.svc.closeAndSave(`${MANUAL}:nope`)).rejects.toThrow('unknown project');
    expect(h.f.state.tabs).toHaveLength(3);
  });

  it('M3-R84: undo of a close-and-save still revives the project; the restored tabs rejoin it', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    expect(await h.svc.closeAndSave(id)).toEqual({ closed: 2, skipped: 0, ids: ['rc1', 'rc2'] });
    expect(await h.stored(id)).toMatchObject({ keep: true, closedAt: NOW, closedIds: ['rc1', 'rc2'], saved: { tabs: [{ url: A }, { url: B }] } });
    expect(await h.svc.cards()).toEqual([]);
    for (const rc of ['rc1', 'rc2']) await h.svc.onUndo(rc);
    expect(await h.stored(id)).not.toHaveProperty('closedAt');
    h.f.addTab(tab(11, A));
    h.f.addTab(tab(12, B));
    await h.r.flush();
    expect([11, 12].map(h.groupOf)).toEqual(['Taxes', 'Taxes']);
    expect((await h.svc.cards()).map((c) => [c.id, c.tabs.map((t) => t.tabId)])).toEqual([[id, [11, 12]]]);
  });

  it('fix 1: undoing 1 of N entries never shrinks the saved list; once the restored tabs cover it, it follows them again', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    const { ids } = await h.svc.closeAndSave(id);
    expect(ids).toHaveLength(3);
    await h.svc.onUndo(ids[0]!); // recent.undo restores one entry
    h.f.addTab(tab(11, A));
    await h.r.flush();
    expect(h.groupOf(11)).toBe('Taxes');
    expect((await h.stored(id))?.saved).toMatchObject({ closed: true, tabs: [{ url: A }, { url: B }, { url: C }] });
    for (const rc of ids.slice(1)) await h.svc.onUndo(rc);
    h.f.addTab(tab(12, B));
    h.f.addTab(tab(13, C));
    await h.r.flush();
    const p = await h.stored(id);
    expect(p?.saved?.closed).toBeUndefined();
    expect(p?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
  });

  it('M4-R14: close-and-save 5 with 1 protected, then a new tab: saved grows to 6 at its tab-bar place and keeps the closed 4', async () => {
    const h = harness();
    const [D, E, F] = ['https://d.example/', 'https://e.example/', 'https://f.example/'];
    const id = await taxes(h, [A, B, C, D, E]);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(3); // C stays open
    expect(await h.svc.closeAndSave(id)).toMatchObject({ closed: 4, skipped: 1 });
    h.f.addTab(tab(6, F));
    await h.svc.addTab(6, id);
    for (let i = 0; i < 3; i++) {
      h.clock.now += MIN;
      await h.r.flush();
    }
    let p = await h.stored(id);
    expect(p?.saved?.closed).toBe(true);
    expect(p?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C, F, D, E]); // F follows C, the open member before it
    // Reopen: every saved page once (C and F adopted, 4 opened), and the list follows the tabs again.
    expect(await h.svc.reopen(id)).toEqual({ opened: 4 });
    const urls = h.f.state.tabs.map((t) => t.url);
    expect(urls.filter((u) => u !== 'https://other.example/').sort()).toEqual([A, B, C, D, E, F].sort());
    await h.r.flush();
    p = await h.stored(id);
    expect(p?.saved?.closed).toBeUndefined();
    expect(p?.saved?.tabs.map((t) => t.url).sort()).toEqual([A, B, C, D, E, F].sort());
  });

  it('M4-R14: a new tab before every open member goes before them; with no open member of the list, at the end', async () => {
    const h = harness();
    const id = await taxes(h, [A, B, C]);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(2); // B stays open
    await h.svc.closeAndSave(id);
    const D = 'https://d.example/';
    h.f.addTab(tab(4, D, { index: 0 }));
    await h.svc.addTab(4, id);
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, D, B, C]);
    h.formEdited.delete(2);
    await h.f.closeTab(2);
    await h.f.closeTab(4);
    const G = 'https://g.example/';
    h.f.addTab(tab(5, G));
    await h.svc.addTab(5, id);
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, D, B, C, G]);
  });

  it('M4-R14: removeTab drops that URL from saved, frozen or not', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(2);
    await h.svc.closeAndSave(id);
    h.clock.now += MIN;
    await h.svc.removeTab(2);
    let p = await h.stored(id);
    expect(p?.saved).toMatchObject({ closed: true, tabs: [{ url: A }, { url: C }] });
    expect(p?.updatedAt).toBe(NOW + MIN);
    const other = harness();
    const id2 = await taxes(other, [A, B]);
    await other.svc.removeTab(1);
    p = await other.stored(id2);
    expect(p?.saved?.tabs.map((t) => t.url)).toEqual([B]);
  });

  it('fix 3: a title-only change across passes neither writes the store nor bumps updatedAt', async () => {
    const h = harness();
    const id = await taxes(h);
    const before = await h.stored(id);
    const writes = h.local.set.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      h.clock.now += MIN;
      h.f.state.tabs.find((t) => t.id === 1)!.title = `(${i}) inbox`;
      await h.r.flush();
    }
    expect(h.local.set.mock.calls.length).toBe(writes);
    expect(await h.stored(id)).toEqual(before);
  });
});

describe('ProjectService.reopen', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('opens the 2 closed tabs and adopts the one still open (no duplicate); all three are in the project again', async () => {
    const h = harness();
    const id = await taxes(h);
    h.formEdited.add(2);
    await h.svc.closeAndSave(id);
    h.clock.now = NOW + 9;
    const create = vi.spyOn(h.f, 'createTab');
    expect(await h.svc.reopen(id)).toEqual({ opened: 2 });
    expect(create.mock.calls.map(([c]) => c)).toEqual([{ url: A, windowId: 1, active: false }, { url: C, windowId: 1, active: false }]);
    expect(h.f.state.tabs.map((t) => t.url)).toEqual([B, A, C]);
    await h.r.flush();
    expect(h.f.state.tabs.map((t) => h.groupOf(t.id))).toEqual(['Taxes', 'Taxes', 'Taxes']);
    expect((await h.svc.cards()).map((c) => c.tabs.length)).toEqual([3]);
    expect((await h.stored(id))?.updatedAt).toBe(NOW + 9);
  });

  it('a closed (tombstoned) project reopens in the last window that held it; a saved URL open elsewhere joins instead', async () => {
    const h = harness();
    h.f.addWindow(2);
    const id = await taxes(h, [A, B], 2);
    h.f.addTab(tab(8, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    h.f.addTab(tab(9, `${A}#section`)); // the same page by dedupe's normalization, in the focused window 1
    expect(await h.svc.reopen(id)).toEqual({ opened: 1 });
    expect(h.f.state.tabs.filter((t) => t.windowId === 2).map((t) => t.url)).toEqual([B]);
    expect(h.f.state.tabs.filter((t) => t.url === A || t.url === `${A}#section`).map((t) => t.id)).toEqual([9]);
    const p = await h.stored(id);
    expect(p).not.toHaveProperty('closedAt');
    expect(p?.manual.find((m) => m.tabId === 9)).toEqual({ url: `${A}#section`, windowId: 1, tabId: 9 });
    await h.r.flush();
    expect((await h.svc.cards()).map((c) => c.tabs.map((t) => t.url).sort())).toEqual([[`${A}#section`, B]]);
  });

  it('when the last window that held it is gone, it reopens in the focused window', async () => {
    const h = harness();
    h.f.addWindow(2);
    const id = await taxes(h, [A], 2);
    h.f.addTab(tab(8, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    h.f.state.windows = h.f.state.windows.filter((w) => w.id !== 2);
    expect(await h.svc.reopen(id)).toEqual({ opened: 1 });
    expect(h.f.state.tabs.find((t) => t.url === A)?.windowId).toBe(1);
  });

  it('a tab that fails to open partway (2nd of 3) never shrinks the saved list on the next pass', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    const create = h.f.createTab.bind(h.f);
    let n = 0;
    vi.spyOn(h.f, 'createTab').mockImplementation(async (p) => {
      if (++n === 2) throw new Error('No tab created');
      return create(p);
    });
    await expect(h.svc.reopen(id)).rejects.toThrow('No tab created');
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
  });

  it('a reopened tab whose URL changes (a sign-in redirect) before the next pass never shrinks the saved list', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    expect(await h.svc.reopen(id)).toEqual({ opened: 3 });
    const t = h.f.state.tabs.find((x) => x.url === B)!;
    t.url = 'https://sso.example/login';
    await h.r.flush();
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((x) => x.url)).toEqual([A, B, C]);
  });

  it('a project with nothing saved opens nothing; an unknown one throws', async () => {
    const h = harness();
    const id = await h.svc.create(MANUAL, 'Empty');
    expect(await h.svc.reopen(id)).toEqual({ opened: 0 });
    await expect(h.svc.reopen(`${MANUAL}:nope`)).rejects.toThrow('unknown project');
  });
});

describe('kept projects (Review Focus 5)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it("a Manual project's tabs closed one by one by the user: never pruned, listed as saved with its last tab list", async () => {
    const local = memoryArea();
    const session = memorySession();
    const clock = { now: NOW };
    const h = harness({ local, session, clock });
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/')); // the browser keeps running with other tabs
    for (const t of [3, 2, 1]) {
      await h.f.closeTab(t);
      clock.now += MIN;
      await h.r.flush();
    }
    const p = await h.stored(id);
    expect(p).toMatchObject({ keep: true, saved: { tabs: [{ url: A, title: `T ${A}`, group: 'Taxes' }] } }); // the last pass that saw tabs
    expect(p).not.toHaveProperty('closedAt');
    // The Project home still has it: no open tabs, its saved list.
    expect(await h.svc.home(id)).toMatchObject({ id, title: 'Taxes', tabs: [], groups: [], keep: true, saved: { tabs: [{ url: A }] } });
    // More than PRUNE_AFTER_MS of browser running time, then a new worker's first pass (the prune).
    for (let t = 0; t <= PRUNE_AFTER_MS / (15 * MIN) + 8; t++) {
      clock.now += 15 * MIN;
      await h.svc.targets(await h.f.snapshot());
    }
    const next = harness({ local, session, clock, port: h.f });
    await next.r.flush();
    expect((await next.store.list()).map((x) => x.id)).toEqual([id]);
  });

  it('a stored kept project closed for longer than PRUNE_AFTER_MS survives the startup prune; an unkept one does not', async () => {
    const local = memoryArea();
    const base = { recipeId: MANUAL, createdAt: NOW, updatedAt: NOW, manual: [], excluded: [], linked: [], closedFor: PRUNE_AFTER_MS + MIN };
    local.data.set(PROJECTS_KEY, [{ ...base, id: `${MANUAL}:kept`, key: 'kept', name: 'Kept', keep: true }, { ...base, id: `${MANUAL}:old`, key: 'old', name: 'Old' }]);
    const h = harness({ local });
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.r.flush();
    expect((await h.store.list()).map((x) => x.id)).toEqual([`${MANUAL}:kept`]);
  });

  it('closeGroup on a kept project with no open tab keeps it (and its Project home)', async () => {
    const h = harness();
    const id = await h.svc.create(MANUAL, 'Empty');
    expect(await h.svc.closeGroup(id)).toEqual({ closed: 0, skipped: 0, ids: [] });
    expect((await h.store.list()).map((x) => x.id)).toEqual([id]);
    expect(await h.svc.home(id)).toMatchObject({ id, title: 'Empty', tabs: [], groups: [], keep: true });
  });

  it('the Project home of an open kept project carries keep and its saved list', async () => {
    const h = harness();
    const id = await taxes(h, [A]);
    expect(await h.svc.home(id)).toMatchObject({ keep: true, saved: { at: NOW, tabs: [{ url: A, title: `T ${A}`, group: 'Taxes' }] } });
  });

  it('setKeep sets and clears keep and bumps updatedAt; an unknown project throws', async () => {
    const h = harness();
    const id = await h.svc.create(MANUAL, 'Empty');
    h.clock.now = NOW + 1;
    await h.svc.setKeep(id, false);
    expect(await h.stored(id)).toMatchObject({ updatedAt: NOW + 1 });
    expect((await h.stored(id))?.keep).toBeUndefined();
    h.clock.now = NOW + 2;
    await h.svc.setKeep(id, true);
    expect(await h.stored(id)).toMatchObject({ keep: true, updatedAt: NOW + 2 });
    await expect(h.svc.setKeep(`${MANUAL}:nope`, true)).rejects.toThrow('unknown project');
  });
});

describe('updatedAt', () => {
  it('a stored project without updatedAt reads as its createdAt, with no write', async () => {
    const local = memoryArea();
    local.data.set(PROJECTS_KEY, [{ id: `${MANUAL}:x`, recipeId: MANUAL, key: 'x', createdAt: 42, manual: [], excluded: [], linked: [] }]);
    const store = new ProjectStore(local);
    expect((await store.list())[0]?.updatedAt).toBe(42);
    expect(local.set).not.toHaveBeenCalled();
  });

  it('create sets it; addTab bumps it', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    const id = await h.svc.create(MANUAL, 'Taxes');
    expect((await h.stored(id))?.updatedAt).toBe(NOW);
    h.clock.now = NOW + 3;
    await h.svc.addTab(1, id);
    expect((await h.stored(id))?.updatedAt).toBe(NOW + 3);
  });
});

describe('global dry run (R48/R50): close-and-save and reopen are user actions, like closeGroup', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('they still save, close and reopen', async () => {
    const h = harness({ program: program({ dryRun: true }) });
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    expect(await h.svc.closeAndSave(id)).toEqual({ closed: 2, skipped: 0, ids: ['rc1', 'rc2'] });
    expect(await h.stored(id)).toMatchObject({ keep: true, saved: { tabs: [{ url: A, title: `T ${A}` }, { url: B, title: `T ${B}` }] } });
    expect(await h.svc.reopen(id)).toEqual({ opened: 2 });
    expect(h.f.state.tabs.map((t) => t.url)).toEqual(['https://other.example/', A, B]);
    expect(h.f.state.groups).toEqual([]); // the dry-run reconciler groups nothing
  });
});

// M4 T8: save an existing Chrome group as a kept Manual project, without regrouping, retitling or recoloring it.
describe('ProjectService.saveGroup / unmanagedGroups (M4 T8)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  /** Window 1: group 5 "Taxes" (blue) with tabs 1-2, one ungrouped tab 3. */
  function grouped(h: ReturnType<typeof harness>, title = 'Taxes', color: 'blue' | 'red' = 'blue') {
    h.f.addGroup({ id: 5, windowId: 1, title, color, collapsed: false });
    h.f.addTab(tab(1, A, { groupId: 5 }));
    h.f.addTab(tab(2, B, { groupId: 5 }));
    h.f.addTab(tab(3, C));
  }
  const groupsOf = (h: ReturnType<typeof harness>) => h.f.state.groups.map((g) => [g.id, g.title, g.color]);
  const mutations = (h: ReturnType<typeof harness>) => h.f.calls.filter((c) => !['snapshot'].includes(c.method)).map((c) => c.method);

  it('makes a kept Manual project of the group: its name, color and tabs; the group is left exactly as it was', async () => {
    const h = harness();
    grouped(h);
    const before = structuredClone(h.f.state.tabs);
    h.f.calls.length = 0;
    const id = await h.svc.saveGroup(5);
    await h.r.flush();
    expect(await h.stored(id)).toMatchObject({ recipeId: MANUAL, name: 'Taxes', color: 'blue', keep: true });
    expect((await h.stored(id))?.manual.map((m) => m.url).sort()).toEqual([A, B]);
    expect(groupsOf(h)).toEqual([[5, 'Taxes', 'blue']]); // same group, title and color
    expect(h.f.state.tabs).toEqual(before); // no tab moved or regrouped
    expect(mutations(h).filter((m) => /group|move|update/i.test(m))).toEqual([]);
    expect((await h.svc.cards()).map((c) => c.id)).toContain(id);
  });

  it('M4-R15: an untitled group is refused and left exactly as it is (saving it would retitle it)', async () => {
    const h = harness();
    grouped(h, '');
    const before = structuredClone(h.f.state);
    await expect(h.svc.saveGroup(5)).rejects.toThrow('Name the group first, then save it.');
    await h.r.flush();
    expect(await h.store.list()).toEqual([]);
    expect(h.f.state).toEqual(before);
  });

  it('M4-R12 name clash: refuses rather than renaming the project to "Taxes (2)" (which would retitle the group)', async () => {
    const h = harness();
    await taxes(h); // an open project "Taxes" in window 1, group "Taxes"
    h.f.addGroup({ id: 77, windowId: 1, title: 'Taxes', color: 'red', collapsed: false });
    h.f.addTab(tab(10, 'https://d.example/', { groupId: 77 }));
    await expect(h.svc.saveGroup(77)).rejects.toThrow(/already (exists|used)/);
    expect((await h.store.list()).map((p) => p.name)).toEqual(['Taxes']);
    // a closed/stored project's name clashes too
    const h2 = harness();
    grouped(h2, 'Old');
    const old = await h2.svc.saveGroup(5);
    await h2.svc.closeAndSave(old);
    h2.f.addGroup({ id: 6, windowId: 1, title: 'Old', color: 'red', collapsed: false });
    h2.f.addTab(tab(20, 'https://e.example/', { groupId: 6 }));
    await expect(h2.svc.saveGroup(6)).rejects.toThrow(/already/);
  });

  it('refuses a group already in a project, an unknown group and a group with no tabs', async () => {
    const h = harness();
    grouped(h);
    await h.svc.saveGroup(5);
    await expect(h.svc.saveGroup(5)).rejects.toThrow(/already/);
    await expect(h.svc.saveGroup(999)).rejects.toThrow(/group not found/);
  });

  it('the stored color wins over the recipe grey, so later passes keep the group blue', async () => {
    const h = harness();
    grouped(h);
    const id = await h.svc.saveGroup(5);
    h.f.addTab(tab(4, 'https://d.example/'));
    await h.svc.addTab(4, id);
    await h.r.flush();
    await h.r.flush();
    expect(groupsOf(h)).toEqual([[5, 'Taxes', 'blue']]);
    expect(h.f.state.tabs.filter((t) => t.groupId === 5).map((t) => t.id).sort()).toEqual([1, 2, 4]);
  });

  it('a new tab Chrome puts into the saved group (a link opened from it, a tab dragged in) stays grouped across passes', async () => {
    const h = harness();
    grouped(h);
    const id = await h.svc.saveGroup(5);
    await h.r.flush();
    h.f.addTab(tab(4, 'https://d.example/', { groupId: 5, index: 2 }));
    await h.r.flush();
    await h.r.flush();
    expect(h.f.state.tabs.filter((t) => t.groupId === 5).map((t) => t.id).sort()).toEqual([1, 2, 4]);
    expect(groupsOf(h)).toEqual([[5, 'Taxes', 'blue']]);
    expect((await h.stored(id))?.manual.map((m) => m.url).sort()).toEqual([A, B]); // not joined (that is slice 4.4)
  });

  it('a tab the user removes from the saved project is still ungrouped (the group is not strict)', async () => {
    const h = harness();
    grouped(h);
    await h.svc.saveGroup(5);
    await h.r.flush();
    await h.svc.removeTab(2);
    await h.r.flush();
    await h.r.flush();
    expect(h.f.state.tabs.filter((t) => t.groupId === 5).map((t) => t.id)).toEqual([1]);
  });

  it("a rule's group is Tabchef's: not offered by unmanagedGroups, and saveGroup refuses it in plain words", async () => {
    const rules = [{ id: 'gh', name: 'GitHub', enabled: true, match: { url: 'gh.example/*' }, actions: [{ group: { title: 'GitHub', color: 'green' } }] }];
    const h = harness({ program: program({ rules: (rules as unknown) as Config['rules'] }) });
    grouped(h);
    h.f.addTab(tab(7, 'https://gh.example/a'));
    h.f.addTab(tab(8, 'https://gh.example/b'));
    await h.r.flush();
    const gh = h.f.state.groups.find((g) => g.title === 'GitHub')!;
    expect(gh).toBeTruthy();
    expect((await h.svc.unmanagedGroups()).map((g) => g.title)).toEqual(['Taxes']);
    await expect(h.svc.saveGroup(gh.id)).rejects.toThrow('This group is managed by a rule. Save one of your own groups.');
    expect(await h.store.list()).toEqual([]);
  });

  it('refuses when the Manual recipe is off (M4-R10)', async () => {
    const base = defaultConfig();
    const h = harness({ program: program({ recipes: base.recipes.map((r) => (r.id === MANUAL ? { ...r, enabled: false } : r)) }) });
    grouped(h);
    await expect(h.svc.saveGroup(5)).rejects.toThrow(/turn on the recipe/);
    expect(await h.svc.unmanagedGroups()).toEqual([]);
  });

  it('unmanagedGroups lists open groups no project holds: title, color, tab count; saved ones drop out', async () => {
    const h = harness();
    grouped(h);
    h.f.addGroup({ id: 6, windowId: 1, title: '', color: 'red', collapsed: false });
    h.f.addTab(tab(30, 'https://f.example/', { groupId: 6 }));
    expect(await h.svc.unmanagedGroups()).toEqual([
      { id: 5, title: 'Taxes', color: 'blue', tabCount: 2 },
      { id: 6, title: '', color: 'red', tabCount: 1 },
    ]);
    await h.svc.saveGroup(5);
    expect((await h.svc.unmanagedGroups()).map((g) => g.id)).toEqual([6]);
  });

  it('global dry run (M4-R11): it stores the project; nothing is grouped or moved', async () => {
    const h = harness({ program: program({ dryRun: true }) });
    grouped(h);
    const before = structuredClone(h.f.state);
    const id = await h.svc.saveGroup(5);
    await h.r.flush();
    expect(await h.stored(id)).toMatchObject({ name: 'Taxes', keep: true, color: 'blue' });
    expect(h.f.state).toEqual(before);
  });
});

// M4-R16: a Manual project's group has no position in the order pass; it stays where the user put it.
describe('saved group order (M4-R16)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const rule = (id: string, title: string, host: string) => ({
    id, name: title, enabled: true, match: { url: `${host}.example/*` }, actions: [{ group: { title, color: 'green' as const } }],
  });
  const cfg = () => program({ rules: ([rule('a', 'Alpha', 'alpha'), rule('b', 'Beta', 'beta')] as unknown) as Config['rules'] });
  const ids = (h: ReturnType<typeof harness>) => h.f.state.tabs.sort((x, y) => x.index - y.index).map((t) => t.id);
  const savedUntouched = (h: ReturnType<typeof harness>, gid = 5) => {
    expect(h.f.calls.filter((c) => c.method === 'moveGroup' && c.args[0] === gid)).toEqual([]);
    expect(h.f.calls.filter((c) => c.method === 'moveTabs' && (c.args[0] as number[]).some((t) => t === 1 || t === 2))).toEqual([]);
    expect(h.f.state.groups.find((g) => g.id === gid)).toMatchObject({ title: 'Taxes', color: 'blue' });
  };

  it('after an ungrouped tab: later passes leave it there', async () => {
    const h = harness({ program: cfg() });
    h.f.addTab(tab(9, 'https://plain.example/'));
    h.f.addGroup({ id: 5, windowId: 1, title: 'Taxes', color: 'blue', collapsed: false });
    h.f.addTab(tab(1, A, { groupId: 5 }));
    h.f.addTab(tab(2, B, { groupId: 5 }));
    await h.svc.saveGroup(5);
    h.f.calls.length = 0;
    await h.r.flush(); await h.r.flush();
    savedUntouched(h);
    expect(ids(h)).toEqual([9, 1, 2]);
  });

  it('between two rule groups in config order: nothing moves', async () => {
    const h = harness({ program: cfg() });
    h.f.addGroup({ id: 3, windowId: 1, title: 'Alpha', color: 'green', collapsed: false });
    h.f.addTab(tab(7, 'https://alpha.example/x', { groupId: 3 }));
    h.f.addGroup({ id: 5, windowId: 1, title: 'Taxes', color: 'blue', collapsed: false });
    h.f.addTab(tab(1, A, { groupId: 5 }));
    h.f.addTab(tab(2, B, { groupId: 5 }));
    h.f.addGroup({ id: 4, windowId: 1, title: 'Beta', color: 'green', collapsed: false });
    h.f.addTab(tab(8, 'https://beta.example/x', { groupId: 4 }));
    await h.svc.saveGroup(5);
    h.f.calls.length = 0;
    await h.r.flush(); await h.r.flush();
    savedUntouched(h);
    expect(ids(h)).toEqual([7, 1, 2, 8]);
    expect(h.f.calls.filter((c) => c.method === 'moveGroup')).toEqual([]);
  });

  it('rule groups out of config order are still reordered, without moving the saved group', async () => {
    const h = harness({ program: cfg() });
    h.f.addGroup({ id: 4, windowId: 1, title: 'Beta', color: 'green', collapsed: false });
    h.f.addTab(tab(8, 'https://beta.example/x', { groupId: 4 }));
    h.f.addGroup({ id: 5, windowId: 1, title: 'Taxes', color: 'blue', collapsed: false });
    h.f.addTab(tab(1, A, { groupId: 5 }));
    h.f.addTab(tab(2, B, { groupId: 5 }));
    h.f.addGroup({ id: 3, windowId: 1, title: 'Alpha', color: 'green', collapsed: false });
    h.f.addTab(tab(7, 'https://alpha.example/x', { groupId: 3 }));
    await h.svc.saveGroup(5);
    h.f.calls.length = 0;
    await h.r.flush(); await h.r.flush();
    savedUntouched(h);
    // Alpha has to pass the saved group to get ahead of Beta; the saved group is never named by an op.
    expect(ids(h)).toEqual([7, 8, 1, 2]);
  });

  it('saved group first: Beta, Alpha reorder behind it and it stays first', async () => {
    const h = harness({ program: cfg() });
    h.f.addGroup({ id: 5, windowId: 1, title: 'Taxes', color: 'blue', collapsed: false });
    h.f.addTab(tab(1, A, { groupId: 5 }));
    h.f.addTab(tab(2, B, { groupId: 5 }));
    h.f.addGroup({ id: 4, windowId: 1, title: 'Beta', color: 'green', collapsed: false });
    h.f.addTab(tab(8, 'https://beta.example/x', { groupId: 4 }));
    h.f.addGroup({ id: 3, windowId: 1, title: 'Alpha', color: 'green', collapsed: false });
    h.f.addTab(tab(7, 'https://alpha.example/x', { groupId: 3 }));
    await h.svc.saveGroup(5);
    h.f.calls.length = 0;
    await h.r.flush(); await h.r.flush();
    savedUntouched(h);
    expect(ids(h)).toEqual([1, 2, 7, 8]);
  });

  it('an ungrouped tab between rule groups still ends right of them, with a saved group in the window', async () => {
    const h = harness({ program: cfg() });
    h.f.addGroup({ id: 3, windowId: 1, title: 'Alpha', color: 'green', collapsed: false });
    h.f.addTab(tab(7, 'https://alpha.example/x', { groupId: 3 }));
    h.f.addTab(tab(9, 'https://plain.example/'));
    h.f.addGroup({ id: 4, windowId: 1, title: 'Beta', color: 'green', collapsed: false });
    h.f.addTab(tab(8, 'https://beta.example/x', { groupId: 4 }));
    h.f.addGroup({ id: 5, windowId: 1, title: 'Taxes', color: 'blue', collapsed: false });
    h.f.addTab(tab(1, A, { groupId: 5 }));
    h.f.addTab(tab(2, B, { groupId: 5 }));
    await h.svc.saveGroup(5);
    h.f.calls.length = 0;
    await h.r.flush(); await h.r.flush();
    savedUntouched(h);
    expect(ids(h)).toEqual([7, 8, 9, 1, 2]);
  });
});
