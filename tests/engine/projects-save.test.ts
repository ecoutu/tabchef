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
    factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined, githubIssues: async () => new Map(),
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

  it('a tab that fails to open partway (2nd of 3) never stops the others or shrinks the saved list on the next pass', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    const create = h.f.createTab.bind(h.f);
    let n = 0;
    vi.spyOn(h.f, 'createTab').mockImplementation(async (p) => {
      n++;
      if (p.url === B) throw new Error('No tab created'); // in its window and on the retry without one
      return create(p);
    });
    expect(await h.svc.reopen(id)).toEqual({ opened: 2, failed: 1 });
    expect(n).toBe(4);
    expect(h.f.state.tabs.map((t) => t.url).sort()).toEqual([A, C, 'https://other.example/']);
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

  it('a window closed meanwhile: each saved tab that cannot open there opens in another window and joins from there', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addWindow(2);
    h.f.addTab(tab(9, 'https://other.example/', { windowId: 2 }));
    await h.svc.closeAndSave(id);
    const create = h.f.createTab.bind(h.f);
    const calls: (number | undefined)[] = [];
    vi.spyOn(h.f, 'createTab').mockImplementation(async (o) => {
      calls.push(o.windowId);
      if (o.windowId === 1) {
        h.f.state.windows = h.f.state.windows.filter((w) => w.id !== 1);
        h.f.state.windows[0]!.focused = true;
        throw new Error('No window with id: 1.');
      }
      return create(o);
    });
    expect(await h.svc.reopen(id)).toEqual({ opened: 3 });
    expect(calls).toEqual([1, undefined, 1, undefined, 1, undefined]);
    expect(h.f.state.tabs.filter((t) => t.windowId === 2).map((t) => t.url)).toEqual(['https://other.example/', A, B, C]);
    const reopened = new Set(h.f.state.tabs.filter((t) => t.id !== 9).map((t) => t.id));
    expect((await h.stored(id))?.manual.filter((m) => reopened.has(m.tabId!)).map((m) => m.windowId)).toEqual([2, 2, 2]);
  });

  it('every saved tab refused: nothing opens and each one is counted once', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    const create = vi.spyOn(h.f, 'createTab').mockRejectedValue(new Error('No window with id: 1.'));
    expect(await h.svc.reopen(id)).toEqual({ opened: 0, failed: 3 });
    expect(create).toHaveBeenCalledTimes(6);
  });

  it('a saved tab Chrome refuses (a javascript: URL) is counted, and the tabs after it still open', async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    await h.svc.closeAndSave(id);
    const p = (await h.stored(id))!;
    p.saved = { tabs: [A, 'javascript:void(0)', B, C].map((url) => ({ url, title: url })), at: NOW };
    await h.store.put(p);
    const create = h.f.createTab.bind(h.f);
    vi.spyOn(h.f, 'createTab').mockImplementation(async (o) => {
      if (o.url.startsWith('javascript:')) throw new Error('JavaScript URLs are not allowed in API based extension navigations.');
      return create(o);
    });
    expect(await h.svc.reopen(id)).toEqual({ opened: 3, failed: 1 });
    expect(h.f.state.tabs.map((t) => t.url).sort()).toEqual([A, B, C]);
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

  it('keeping a project again: a tab closed while it was not kept stays out of the list', async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.setKeep(id, false);
    h.clock.now += MIN;
    await h.f.closeTab(3); // C closed while unkept: the pass sees it go
    await h.r.flush();
    await h.svc.setKeep(id, true);
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B]);
    h.clock.now += MIN;
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B]);
  });

  it('keeping a project again with none of its tabs open leaves its saved list', async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    await h.svc.closeAndSave(id);
    await h.svc.setKeep(id, false);
    await h.svc.setKeep(id, true);
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, B, C]);
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

describe('M4-R21: the saved list of an open kept project', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const X = 'https://x.example/';
  /** Puts `urls` as the stored saved list of `id` (as a synced copy from another device would). */
  async function setSaved(h: ReturnType<typeof harness>, id: string, urls: string[]): Promise<void> {
    const p = (await h.stored(id))!;
    p.saved = { tabs: urls.map((url) => ({ url, title: `T ${url}`, group: 'Taxes' })), at: NOW };
    await h.store.put(p);
  }

  it('keeps a saved URL this worker never saw open; drops one whose tab was a member at the previous pass and is gone', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, X, B]);
    h.clock.now += MIN;
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, X, B]);
    await h.f.closeTab(2); // B: a member at the previous pass
    h.clock.now += MIN;
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, X]);
  });

  it("without storage.session, the first pass after a worker start only adds: a saved URL whose tab closed while the worker was down stays", async () => {
    const local = memoryArea();
    const h = harness({ local });
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, X, B]);
    await h.f.closeTab(2);
    const next = harness({ local, port: h.f });
    await next.r.flush();
    expect((await next.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, X, B]);
  });

  it('I3: the previous members are kept in storage.session: a tab closed while the worker was down leaves the saved list', async () => {
    const local = memoryArea();
    const session = memorySession();
    const h = harness({ local, session });
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, X, B]);
    h.clock.now += MIN;
    await h.r.flush(); // B is a member at this pass
    await h.f.closeTab(2); // the tab close wakes a new worker
    const next = harness({ local, session, port: h.f, clock: h.clock });
    next.clock.now += MIN;
    await next.r.flush();
    expect((await next.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, X]);
  });

  it('M4-R31: a pass that changes only the saved list leaves updatedAt unchanged; a user action still bumps it', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    const at = (await h.stored(id))!.updatedAt;
    h.clock.now += MIN;
    await h.f.closeTab(2);
    await h.r.flush();
    expect(await h.stored(id)).toMatchObject({ updatedAt: at, saved: { tabs: [{ url: A }], at: NOW + MIN } });
    h.f.addTab(tab(3, C));
    await h.svc.addTab(3, id); // a user action: bumps
    expect((await h.stored(id))?.updatedAt).toBe(NOW + MIN);
  });

  it('a new member is added at its tab-bar place among the kept saved URLs', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    await setSaved(h, id, [A, X, B]);
    h.f.addTab(tab(3, C));
    await h.svc.addTab(3, id); // joins the Taxes group: last in it
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, X, B, C]);
  });
});

// M4-R41: the M4-R21 refresh merges saved URLs into an open tab by the user's dedupe key, so a
// synced URL never open here is dropped when an open tab shares its key. Once sync keeps such URLs (the I-1 fix), this
// device's drop syncs back as a removal, and the device that has both open re-adds it: a sync loop.
describe('M4-R21 refresh with saved URLs that share a dedupe key (M4-R41)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const G1 = 'https://mail.google.com/mail/u/0/#inbox/AAA';
  const G2 = 'https://mail.google.com/mail/u/0/#inbox/BBB';
  async function setSaved(h: ReturnType<typeof harness>, id: string, urls: string[]): Promise<void> {
    const p = (await h.stored(id))!;
    p.saved = { tabs: urls.map((url) => ({ url, title: `T ${url}`, group: 'Taxes' })), at: NOW };
    await h.store.put(p);
  }

  it('keeps a synced thread never open here while another thread of the same page is open (default settings strip #)', async () => {
    const h = harness();
    const id = await taxes(h, [G1, A]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [G1, G2, A]);
    h.clock.now += MIN;
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([G1, G2, A]);
  });

  it('keeps a synced tracking-param variant never open here while the clean URL is open (default settings strip utm_*)', async () => {
    const h = harness();
    const U = `${A}?utm_source=mail`;
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, U, B]);
    h.clock.now += MIN;
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => t.url)).toEqual([A, U, B]);
  });
});

// M4-R43: the M4-R21 dedupe-key claim takes the first unclaimed saved entry with the tab's dedupe key,
// not one whose own URL was a member at the previous pass, so a synced URL never open here is replaced and lost.
describe('M4-R43: the M4-R21 dedupe-key claim takes only an entry that was a member at the previous pass', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const G1 = 'https://mail.google.com/mail/u/0/#inbox/AAA';
  const G2 = 'https://mail.google.com/mail/u/0/#inbox/BBB';
  const G3 = 'https://mail.google.com/mail/u/0/#inbox/CCC';
  const urls = async (h: ReturnType<typeof harness>, id: string) => (await h.stored(id))?.saved?.tabs.map((t) => t.url);
  async function setSaved(h: ReturnType<typeof harness>, id: string, list: string[], closed = false): Promise<void> {
    const p = (await h.stored(id))!;
    p.saved = { tabs: list.map((url) => ({ url, title: `T ${url}`, group: 'Taxes' })), at: NOW, ...(closed && { closed: true }) };
    await h.store.put(p);
  }
  const navigate = (h: ReturnType<typeof harness>, tabId: number, url: string) => { h.f.state.tabs.find((t) => t.id === tabId)!.url = url; };

  it("a navigation in a tab replaces that tab's own saved URL, never a synced thread of the same page not open here", async () => {
    const h = harness();
    const id = await taxes(h, [G2, A]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [G1, G2, A]); // G1: synced from another device, never open here
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([G1, G2, A]);
    navigate(h, 1, G3); // in-page navigation: same dedupe key, still the manual member
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([G1, G3, A]);
  });

  it('the navigated entry keeps its place and its saved group (the claim still places it)', async () => {
    const h = harness();
    const id = await taxes(h, [A, G2]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, G2, G1]);
    h.clock.now += MIN;
    await h.r.flush();
    navigate(h, 2, G3);
    h.clock.now += MIN;
    await h.r.flush();
    expect((await h.stored(id))?.saved?.tabs.map((t) => [t.url, t.group])).toEqual([[A, 'Taxes'], [G3, 'Taxes'], [G1, 'Taxes']]);
  });

  it('two open tabs at the same exact URL never replace a synced thread of the same page (no navigation at all)', async () => {
    const h = harness();
    const id = await taxes(h, [G2, G2, A]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [G1, G2, A]);
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([G1, G2, G2, A]); // the second G2 tab is a new member, as without G1
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([G1, G2, G2, A]);
  });

  it('M4-R14: a frozen list unfrozen by another thread of the same page (the dedupe-key cover check) loses no saved URL', async () => {
    const h = harness();
    const id = await taxes(h, [A, G1, G2]);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(1); // A stays open: the project stays open, the list frozen
    await h.svc.closeAndSave(id);
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, G1, G2]);
    h.f.addTab(tab(5, G3));
    await h.svc.addTab(5, id); // G3 covers G1 and G2 by the dedupe key: the list unfreezes
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, G1, G2, G3]); // G3 is no previous member's URL: a new member, at its tab-bar place
  });

  it('control: a thread that was a member and navigated away still leaves (M4-R21), and a redirect loop never grows the list', async () => {
    const h = harness();
    const id = await taxes(h, [G1, A]);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.clock.now += MIN;
    await h.r.flush();
    for (const u of [G2, G3, G1, G2, G3]) {
      navigate(h, 1, u);
      h.clock.now += MIN;
      await h.r.flush();
      expect(await urls(h, id)).toEqual([u, A]);
    }
  });

  it('control: two devices with different dedupe settings keep both threads (a device that keeps # claims nothing by key)', async () => {
    const keepHash = program({ dedupe: { ...defaultConfig().dedupe, stripFragment: false } });
    const h = harness({ program: keepHash });
    const id = await taxes(h, [G2, A]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [G1, G2, A]);
    h.clock.now += MIN;
    await h.r.flush();
    navigate(h, 1, G3); // under this device's key G3 is its own page: the manual entry no longer holds the tab
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toContain(G1);
  });

  it('removeTab (out of scope, slice 4.4): removing one thread drops a synced thread of the same page from the saved list', async () => {
    const h = harness();
    const id = await taxes(h, [G1, A]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [G1, G2, A]);
    await h.r.flush();
    await h.svc.removeTab(1);
    await h.r.flush();
    // Documents current behaviour (dedupe-key removal, consistent with `excluded`); see the ruling.
    expect(await urls(h, id)).toEqual([A]);
  });
});

// M4-R44: Close and save (and Close and archive) replaced the saved list with the tabs open on this
// device, so a saved URL never open here (synced from another device, M4-R21; a fragment variant reopen skips,
// M4-R43) left the list, and sync then removed it on every device.
describe('M4-R44: Close and save keeps the saved URLs this device never had open', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const X = 'https://x.example/';
  const G1 = 'https://mail.google.com/mail/u/0/#inbox/AAA';
  const G2 = 'https://mail.google.com/mail/u/0/#inbox/BBB';
  const urls = async (h: ReturnType<typeof harness>, id: string) => (await h.stored(id))?.saved?.tabs.map((t) => t.url);
  async function setSaved(h: ReturnType<typeof harness>, id: string, list: string[], closed = false): Promise<void> {
    const p = (await h.stored(id))!;
    p.saved = { tabs: list.map((url) => ({ url, title: `T ${url}`, group: 'Taxes' })), at: NOW, ...(closed && { closed: true }) };
    await h.store.put(p);
  }

  it('a saved URL from another device, never open here, stays in the list Close and save records', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, X, B]); // X: synced from another device
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, X, B]); // the pass keeps it (M4-R21)
    h.clock.now += MIN;
    expect(await h.svc.closeAndSave(id)).toMatchObject({ closed: 2, skipped: 0 });
    expect((await h.stored(id))?.saved).toMatchObject({ closed: true, tabs: [{ url: A }, { url: X }, { url: B }] });
  });

  it('Close and archive keeps it too', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, X, B]);
    h.clock.now += MIN;
    await h.r.flush();
    await h.svc.closeAndArchive(id);
    expect(await h.stored(id)).toMatchObject({ archivedAt: expect.any(Number) });
    expect(await urls(h, id)).toEqual([A, X, B]);
  });

  it('sync off: a fragment variant that reopen skips (M4-R43) survives the next Close and save', async () => {
    const h = harness();
    const id = await taxes(h, [G1, G2, A]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([G1, G2, A]);
    expect(await h.svc.reopen(id)).toEqual({ opened: 2 }); // one tab per dedupe key: G2 is not opened
    h.clock.now += MIN;
    await h.r.flush();
    expect((await h.stored(id))?.saved?.closed).toBeUndefined(); // the dedupe-key cover check thawed it
    expect(await urls(h, id)).toEqual([G1, G2, A]); // the pass keeps G2 (never a member here)
    h.clock.now += MIN;
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([G1, G2, A]);
  });

  it('a tab this device saw open and the user closed before Close and save leaves the list (M4-R21/R33); a never-open one stays', async () => {
    const h = harness();
    const id = await taxes(h, [A, B, C]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, B, X, C]);
    h.clock.now += MIN;
    await h.r.flush(); // B is a member at this pass
    await h.f.closeTab(2); // closed by hand; Close and save comes before any other pass
    h.clock.now += MIN;
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([A, X, C]);
  });

  it('control: a list with no saved URL beyond the open tabs is recorded as before (tab-bar order, groups)', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.f.addTab(tab(3, C));
    await h.svc.addTab(3, id);
    await h.r.flush(); // C joins the Taxes group
    h.clock.now += MIN;
    await h.svc.closeAndSave(id);
    expect((await h.stored(id))?.saved).toEqual({
      at: NOW + MIN, closed: true,
      tabs: [{ url: A, title: `T ${A}`, group: 'Taxes' }, { url: B, title: `T ${B}`, group: 'Taxes' }, { url: C, title: `T ${C}`, group: 'Taxes' }],
    });
  });

  it('an unkept project keeps a saved URL never open here too: the pass maintains its list, and Close and save keeps it (M4-R51)', async () => {
    const h = harness();
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.setKeep(id, false);
    await setSaved(h, id, [A, X, B]); // X from a synced copy, never open here
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, X, B]);
    h.clock.now += MIN;
    await h.svc.closeAndSave(id);
    expect((await h.stored(id))?.saved).toMatchObject({ closed: true, tabs: [{ url: A }, { url: X }, { url: B }] });
    expect(await h.stored(id)).toMatchObject({ keep: true });
  });

  it('global dry run: Close and save keeps a saved URL never open here too', async () => {
    const h = harness({ program: program({ dryRun: true }) });
    const id = await taxes(h, [A, B]);
    h.f.addTab(tab(9, 'https://other.example/'));
    await setSaved(h, id, [A, X, B]);
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([A, X, B]);
  });

  it('frozen list: a URL that joins the list while it is frozen survives Close and save', async () => {
    const h = harness();
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(2);
    await h.svc.closeAndSave(id);
    await setSaved(h, id, [A, B, C, X], true); // X arrives by sync; `closed` is local and kept (sync-plan.ts:50)
    await h.r.flush();
    h.formEdited.delete(2);
    h.clock.now += MIN;
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([A, B, C, X]);
  });
});

describe('M4-R21 with sync off: a kept project across a browser restart', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const urls = async (h: ReturnType<typeof harness>, id: string) => (await h.stored(id))?.saved?.tabs.map((t) => t.url);

  /** Taxes [A, B, C] kept and open; Chrome quits (no pass sees the tabs go) and the next session is not restored. */
  async function restart() {
    const local = memoryArea();
    const h1 = harness({ local, session: memorySession() });
    const id = await taxes(h1);
    const port = new FakeBrowserPort();
    port.addWindow(1, { focused: true });
    return { h: harness({ local, port, session: memorySession(), clock: { now: NOW + 60 * MIN } }), id };
  }

  it('one tab back keeps the whole saved list, and Reopen still opens the others', async () => {
    const { h, id } = await restart();
    h.f.addTab(tab(10, A));
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, B, C]);
    expect(await h.svc.reopen(id)).toEqual({ opened: 2 });
  });

  it('a tab back and then closed again leaves; the ones never back stay', async () => {
    const { h, id } = await restart();
    h.f.addTab(tab(10, A));
    h.f.addTab(tab(11, B));
    await h.r.flush();
    await h.f.closeTab(11);
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, C]);
  });

  it('Close and save with one tab back keeps the whole saved list', async () => {
    const { h, id } = await restart();
    h.f.addTab(tab(10, A));
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.r.flush();
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([A, B, C]);
  });
});

// M4-R51: Keep off → on must not cut a saved list to the open tabs.
describe('M4-R51: keeping a project again keeps the saved tabs this device did not see close', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const urls = async (h: ReturnType<typeof harness>, id: string) => (await h.stored(id))?.saved?.tabs.map((t) => t.url);
  /** Taxes [A, B, C] kept and open; Chrome quits (no pass sees the tabs go), the next session is not restored, A comes back. */
  async function restartOneBack() {
    const local = memoryArea();
    const id = await taxes(harness({ local, session: memorySession() }));
    const port = new FakeBrowserPort();
    port.addWindow(1, { focused: true });
    const h = harness({ local, port, session: memorySession(), clock: { now: NOW + 60 * MIN } });
    h.f.addTab(tab(10, A));
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, B, C]); // the restart fix holds
    return { h, id };
  }

  it('Keep off then on with one tab back keeps the saved tabs not reopened yet', async () => {
    const { h, id } = await restartOneBack();
    await h.svc.setKeep(id, false);
    await h.svc.setKeep(id, true);
    expect(await urls(h, id)).toEqual([A, B, C]);
  });

  it('Keep off, a pass, then Keep on keeps them too (and the pass meanwhile drops nothing)', async () => {
    const { h, id } = await restartOneBack();
    await h.svc.setKeep(id, false);
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, B, C]);
    await h.svc.setKeep(id, true);
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, B, C]);
  });

  it('frozen list: Close and save with a protected tab, Keep off then on, keeps the frozen list', async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.formEdited.add(1);
    await h.svc.closeAndSave(id); // A stays open (protected), list [A, B, C] frozen
    await h.svc.setKeep(id, false);
    await h.svc.setKeep(id, true);
    expect(await h.stored(id)).toMatchObject({ keep: true, saved: { closed: true } });
    expect(await urls(h, id)).toEqual([A, B, C]);
  });

  it('control: a tab closed while the project was not kept stays out of the list once kept again', async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.setKeep(id, false);
    h.clock.now += MIN;
    await h.f.closeTab(3);
    await h.r.flush();
    await h.svc.setKeep(id, true);
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, B]);
  });

  it('control (no pass between the close and Keep on): the close is seen at the next pass', async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.setKeep(id, false);
    h.clock.now += MIN;
    await h.f.closeTab(3); // no flush: setKeep's own resolve is the first pass to see it
    await h.svc.setKeep(id, true);
    h.clock.now += MIN;
    await h.r.flush();
    expect(await urls(h, id)).toEqual([A, B]);
  });

  it('sibling (M4-R44 3(a), released): Keep off, then Close and save with one tab back keeps the saved tabs not reopened yet', async () => {
    const { h, id } = await restartOneBack();
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.r.flush();
    await h.svc.setKeep(id, false);
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([A, B, C]);
  });

  it('sibling control: Keep off, a tab closed here, then Close and save leaves the closed tab out', async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.svc.setKeep(id, false);
    h.clock.now += MIN;
    await h.f.closeTab(3);
    await h.r.flush();
    await h.svc.closeAndSave(id);
    expect(await urls(h, id)).toEqual([A, B]);
  });

  it("control: a not-kept project's refresh bumps no updatedAt (M4-R31) and keeps it not kept", async () => {
    const h = harness({ session: memorySession() });
    const id = await taxes(h);
    h.f.addTab(tab(9, 'https://other.example/'));
    h.clock.now += MIN;
    await h.svc.setKeep(id, false);
    const at = (await h.stored(id))!.updatedAt;
    h.clock.now += MIN;
    await h.f.closeTab(3);
    await h.r.flush();
    expect((await h.stored(id))?.keep).toBeUndefined();
    expect((await h.stored(id))?.updatedAt).toBe(at);
  });
});
