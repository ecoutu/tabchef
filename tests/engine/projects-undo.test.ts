// #150 (M4-R53): Undo brings a tab back into its Manual project for every Tabchef close, not only a Close group that
// left nothing open, and never pulls in a tab that was not the entry's own. Goes through the real SafetyService.undo and
// RecentlyClosed, wired as background.ts wires them (beforeUndo → onUndo, onUndone → bindUndone by the closed tab's id),
// with a reconciler pass after the undo.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { groupUndoId, SafetyService } from '../../src/engine/safety';
import { RecentlyClosed, type RecentlyClosedInput } from '../../src/core/safety/recently-closed';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Program } from '../../src/core/lang/types';
import type { Config, TabSnap } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const MANUAL = 'manual-project';
const A = 'https://a.example/';
const B = 'https://b.example/';

function program(): Program {
  const base: Config = defaultConfig();
  const { program: p, errors } = compileProgram(base, builtinRecipes());
  expect(errors).toEqual([]);
  return p;
}
const tab = (id: number, url: string, o: Partial<TabSnap> = {}) => ({
  id, windowId: 1, url, title: `T ${url}`, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const memoryArea = () => {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))]))),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); }),
  };
};

/** The engine's storage.session seam (background.ts): get returns the value. */
const sessionArea = () => {
  const m = new Map<string, unknown>();
  return { get: async (k: string) => structuredClone(m.get(k)), set: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } };
};

/** `o` shares the browser, the project store and storage.session with an earlier harness: a worker restart. */
function harness(o: { f?: FakeBrowserPort; store?: ProjectStore; session?: ReturnType<typeof sessionArea> } = {}) {
  const p = program();
  const f = o.f ?? (() => { const x = new FakeBrowserPort(); x.addWindow(1, { focused: true }); return x; })();
  const store = o.store ?? new ProjectStore(memoryArea());
  const session = o.session ?? sessionArea();
  const rc = new RecentlyClosed();
  const locked = new Set<number>();
  const binds: Promise<unknown>[] = [];
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p,
    sources: { factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined, githubIssues: async () => new Map() },
    facts: { get: () => undefined }, log: { add: () => {} }, recentlyClosed: rc,
    safety: { isProtected: (t) => t.pinned || locked.has(t.id) }, state: () => r.liveState(), schedule: vi.fn(), now: () => NOW,
    session,
  });
  r = new Reconciler(f, async () => p, { projects: svc, now: () => NOW, log: { add: () => {} } });
  const safety = new SafetyService(f, {
    recentlyClosed: rc, log: { add: () => {} }, schedule: () => {}, exemptOnce: () => {}, armExemption: () => () => {},
    api: { executeScript: async () => {}, sendMessage: async () => ({ ok: true }), createNotification: async () => {} },
    bannerFile: 'b.js', now: () => NOW,
    // As background.ts wires them.
    beforeUndo: (entryId) => svc.onUndo(entryId),
    onUndone: (tabId, url, closedTabId) => { if (closedTabId !== undefined) binds.push(svc.bindUndone(closedTabId, tabId, url)); },
  });
  const groupOf = (id: number | undefined) => f.state.groups.find((g) => g.id === f.state.tabs.find((t) => t.id === id)?.groupId)?.title;
  const tabAt = (url: string) => f.state.tabs.filter((t) => t.url === url).map((t) => t.id);
  /** Undo `id` (one entry or a groupUndoId), as the toast or Recently closed does; then the reconciler's pass. */
  const undo = async (id: string): Promise<void> => {
    await safety.undo(id);
    await Promise.all(binds);
    await r.flush();
  };
  /** What CloseExecutor.close, DedupeHandler, the popup's Close duplicates and a popup view close do: add the entry, close. */
  const tabchefCloses = async (t: number, reason: string, extra: Partial<RecentlyClosedInput> = {}): Promise<string> => {
    const s = f.state.tabs.find((x) => x.id === t)!;
    const groupTitle = f.state.groups.find((g) => g.id === s.groupId)?.title;
    const id = rc.add({ url: s.url!, title: s.title, windowId: s.windowId, tabId: t, reason, at: NOW, ...(groupTitle && { groupTitle }), ...extra });
    await f.closeTab(t);
    await r.flush();
    return id;
  };
  return { f, store, session, svc, r, rc, locked, groupOf, tabAt, undo, tabchefCloses };
}

/** Manual project "Taxes" with A (tab 1) and B (tab 2), grouped. */
async function taxes(h: ReturnType<typeof harness>): Promise<string> {
  h.f.addTab(tab(1, A));
  h.f.addTab(tab(2, B));
  await h.r.flush();
  const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
  await h.r.flush();
  expect([1, 2].map(h.groupOf)).toEqual(['Taxes', 'Taxes']);
  return id;
}

describe('#150: undo rejoins a Manual project for every Tabchef close', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('control: undo of a Close group that closed every tab rejoins', async () => {
    const h = harness();
    const id = await taxes(h);
    const { ids } = await h.svc.closeGroup(id);
    expect(ids).toHaveLength(2);
    await h.undo(groupUndoId(ids));
    expect([...h.tabAt(A), ...h.tabAt(B)].map(h.groupOf)).toEqual(['Taxes', 'Taxes']);
  });

  it('R1 partial Close group (a locked tab stays open): the toast Undo brings A back into Taxes', async () => {
    const h = harness();
    const id = await taxes(h);
    h.locked.add(2);
    const r = await h.svc.closeGroup(id);
    expect(r).toMatchObject({ closed: 1, skipped: 1 });
    await h.undo(groupUndoId(r.ids));
    expect(h.tabAt(A).map(h.groupOf)).toEqual(['Taxes']);
  });

  it.each([
    ['R2 auto-close (CloseExecutor)', 'Idle for 2 hours', { ruleId: 'idle' }],
    ['R3 popup view close', 'Stale', {}],
    ['R4 popup Close duplicates', 'duplicate', {}],
    ['R5 dedupe (DedupeHandler)', 'duplicate', {}],
  ] as const)('%s of a Taxes member, then Undo: it comes back into Taxes', async (_n, reason, extra) => {
    const h = harness();
    await taxes(h);
    const rcId = await h.tabchefCloses(1, reason, extra);
    expect(h.groupOf(2)).toBe('Taxes'); // the project is still open (B)
    await h.undo(rcId);
    expect(h.tabAt(A).map(h.groupOf)).toEqual(['Taxes']);
  });

  it('R6 control (M4-R53): undo of a non-member at a Taxes URL does not pull it into Taxes', async () => {
    const h = harness();
    await taxes(h);
    await h.f.closeTab(1); // the user closes A by hand: Taxes keeps its entry (dead id)
    await h.r.flush();
    h.f.addGroup({ id: 50, windowId: 1, title: 'Work', color: 'red', collapsed: false });
    h.f.addTab(tab(3, A, { groupId: 50 })); // the user opens A in their own group
    await h.r.flush();
    const rcId = await h.tabchefCloses(3, 'Idle for 2 hours', { ruleId: 'idle' });
    await h.undo(rcId);
    expect(h.tabAt(A).map(h.groupOf)).not.toEqual(['Taxes']);
  });

  it('a partial Close group of 2 of 3 tabs (one locked): the group Undo brings both back into Taxes, no saved URL lost', async () => {
    const h = harness();
    const C = 'https://c.example/';
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, B));
    h.f.addTab(tab(3, C));
    await h.r.flush();
    const id = await h.svc.create(MANUAL, 'Taxes', [1, 2, 3]);
    await h.r.flush();
    // In tab-bar order: the restored tabs come back after C.
    const saved = async () => (await h.store.list()).find((x) => x.id === id)?.saved?.tabs.map((t) => t.url).sort();
    const before = await saved();
    expect(before).toEqual([A, B, C]);
    h.locked.add(3);
    const r = await h.svc.closeGroup(id);
    expect(r).toMatchObject({ closed: 2, skipped: 1 });
    await h.undo(groupUndoId(r.ids));
    expect([...h.tabAt(A), ...h.tabAt(B), 3].map(h.groupOf)).toEqual(['Taxes', 'Taxes', 'Taxes']);
    expect(await saved()).toEqual(before);
  });

  it('after a worker restart (same storage.session, nothing kept in memory), Undo still brings the tab back', async () => {
    const first = harness();
    const id = await taxes(first);
    const rcId = await first.tabchefCloses(1, 'Idle for 2 hours', { ruleId: 'idle' });
    const h = harness({ f: first.f, store: first.store, session: first.session });
    await h.r.flush();
    await h.undo(rcId);
    expect(h.tabAt(A).map(h.groupOf)).toEqual(['Taxes']);
    expect((await h.store.list()).find((x) => x.id === id)!.manual.map((m) => m.tabId)).toEqual([...h.tabAt(A), 2]);
  });

  it('undo of a tab that joined Taxes at another of its pages binds that page\'s entry; the old-page entry keeps no id', async () => {
    const h = harness();
    const id = await taxes(h);
    const DOCS = 'https://docs.example/page';
    h.f.state.tabs.find((t) => t.id === 1)!.url = DOCS; // the user follows a link in A's tab…
    await h.f.ungroup([1]); // …drags it out…
    await h.r.flush();
    await h.svc.addTab(1, id); // …and adds it again: it joins as DOCS, entry A keeps its URL without the id
    await h.r.flush();
    const { ids } = await h.svc.closeGroup(id);
    await h.undo(groupUndoId(ids));
    const [docs, b] = [h.tabAt(DOCS)[0], h.tabAt(B)[0]];
    const manual = (await h.store.list()).find((x) => x.id === id)!.manual.map((m) => [m.url, m.tabId]);
    expect({ g: [docs, b].map(h.groupOf), manual }).toEqual({ g: ['Taxes', 'Taxes'], manual: [[A, undefined], [B, b], [DOCS, docs]] });
  });
});

describe('#150: ProjectService.bindUndone', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('binds only the entry that held the closed tab, at that URL, without bumping updatedAt', async () => {
    const h = harness();
    const id = await taxes(h);
    await h.f.closeTab(1);
    await h.r.flush();
    const updatedAt = (await h.store.list())[0]!.updatedAt;
    h.f.addTab(tab(20, A));
    await h.svc.bindUndone(2, 20, A); // B's id: the URL does not match
    await h.svc.bindUndone(9, 20, A); // no entry held tab 9
    expect((await h.store.list())[0]!.manual.map((m) => m.tabId)).toEqual([1, 2]);
    await h.svc.bindUndone(1, 20, A);
    await h.r.flush();
    const p = (await h.store.list()).find((x) => x.id === id)!;
    expect({ ids: p.manual.map((m) => m.tabId), updatedAt: p.updatedAt, group: h.groupOf(20) }).toEqual({ ids: [20, 2], updatedAt, group: 'Taxes' });
  });

  it('binds nothing while the closed tab id is open again', async () => {
    const h = harness();
    await taxes(h);
    h.f.addTab(tab(20, A));
    await h.svc.bindUndone(1, 20, A); // tab 1 is still open: the entry has its own tab
    await h.r.flush();
    expect((await h.store.list())[0]!.manual.map((m) => m.tabId)).toEqual([1, 2]);
    expect(h.groupOf(20)).toBeUndefined();
  });

  it('V5 binds nothing when a pass already gave the undone tab to another entry: a tab id names one entry (M4-R58)', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, A, { title: 'second' }));
    h.f.addTab(tab(3, B));
    await h.r.flush();
    const id = await h.svc.create(MANUAL, 'Taxes', [1, 2, 3]);
    await h.r.flush();
    const gid = h.f.state.groups.find((g) => g.title === 'Taxes')!.id;
    await h.f.closeTab(1);
    await h.f.closeTab(2);
    await h.r.flush();
    h.f.addTab(tab(10, A, { groupId: gid })); // the undone tab lands in the group before the bind: a pass rebinds it to the first A
    await h.r.flush();
    await h.svc.bindUndone(2, 10, A);
    const ids = (await h.store.list()).find((x) => x.id === id)!.manual.map((m) => m.tabId);
    expect({ ids, group: h.groupOf(10) }).toEqual({ ids: [10, 2, 3], group: 'Taxes' });
  });

  it('with entries at the same URL in two projects, binds only the one that held the closed tab', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, A));
    await h.r.flush();
    const taxesId = await h.svc.create(MANUAL, 'Taxes', [1]);
    const otherId = await h.svc.create(MANUAL, 'Other', [2]);
    await h.r.flush();
    await h.f.closeTab(1);
    await h.f.closeTab(2);
    await h.r.flush();
    h.f.addTab(tab(20, A));
    await h.svc.bindUndone(2, 20, A);
    await h.r.flush();
    const ids = async (pid: string) => (await h.store.list()).find((x) => x.id === pid)!.manual.map((m) => m.tabId);
    expect({ taxes: await ids(taxesId), other: await ids(otherId), group: h.groupOf(20) }).toEqual({ taxes: [1], other: [20], group: 'Other' });
  });
});
