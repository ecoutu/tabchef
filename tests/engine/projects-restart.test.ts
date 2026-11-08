// #150 (M4-R56, M4-R59): Chrome numbers tabs from a low counter again after a browser restart, so a manual entry's stored
// tab id may name an unrelated tab. After runtime.onStartup (ProjectService.browserStarted) an id is kept only if its tab
// is at the entry's URL. An extension update, a worker restart or a settings change never drops an id.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { IDS_STALE_KEY, ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Program, Recipe } from '../../src/core/lang/types';
import type { Config, TabSnap } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const MANUAL = 'manual-project';
const RID = 'jira-ticket-title';
const A = 'https://a.example/';
const B = 'https://b.example/';
const DOCS = 'https://docs.example/page';

const recipe: Recipe = {
  recipe: RID, version: 1, name: 'Jira ticket (title)', description: 'x',
  params: {},
  project: { key: '{key}', title: '{key}', color: 'blue', container: 'group', join: ['rules', 'manual'] },
  rules: [{
    id: 'ticket', name: 'Jira ticket (title)', enabled: true, match: { url: '*.atlassian.net/browse/*' },
    extract: { key: { from: 'url', jiraKey: {} } },
    actions: [{ assignProject: { key: '{key}', create: true } }],
  }],
};
const docsRule = { id: 'docs', name: 'docs', enabled: true, match: { url: 'docs.example/*' }, actions: [{ group: { title: 'Docs', color: 'green' as const } }] };
function program(over: Partial<Config> = {}): Program {
  const base = defaultConfig();
  const c: Config = { ...base, rules: [docsRule], recipes: [...base.recipes, { id: RID, enabled: true, params: {}, source: 'builtin' }], ...over };
  const { program: p, errors } = compileProgram(c, { ...builtinRecipes(), [RID]: recipe });
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

/** The engine's storage.session seam (background.ts): get returns the value. */
const sessionArea = () => {
  const data = new Map<string, unknown>();
  return { data, get: async (k: string) => structuredClone(data.get(k)), set: async (k: string, v: unknown) => { data.set(k, structuredClone(v)); } };
};
/** `get`: a Program that can change between passes (dry run, recipes); `started`: runtime.onStartup fired. */
function harness(o: {
  program?: Program; local?: ReturnType<typeof memoryArea>; port?: FakeBrowserPort; session?: ReturnType<typeof sessionArea>;
  get?: () => Promise<Program>; started?: boolean;
} = {}) {
  const p0 = o.program ?? program();
  const get = o.get ?? (async () => p0);
  const f = o.port ?? (() => { const x = new FakeBrowserPort(); x.addWindow(1, { focused: true }); return x; })();
  const local = o.local ?? memoryArea();
  const clock = { now: NOW };
  const closed: { url: string; reason: string }[] = [];
  const menus: { id: string; title: string }[][] = [];
  const store = new ProjectStore(local);
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: get, session: o.session ?? sessionArea(),
    sources: { factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined, githubIssues: async () => new Map() },
    facts: { get: () => undefined }, log: { add: () => {} },
    recentlyClosed: { add: (e) => { closed.push(e); return `rc${closed.length}`; } },
    safety: { isProtected: (t) => t.pinned }, state: () => r.liveState(), schedule: vi.fn(), now: () => clock.now,
    onProjectsChanged: (ps) => menus.push(ps), recipeName: async (id) => builtinRecipes()[id]?.name ?? (id === RID ? recipe.name : undefined),
  });
  if (o.started) void svc.browserStarted(); // runtime.onStartup
  r = new Reconciler(f, get, { projects: svc, now: () => clock.now, log: { add: () => {} } });
  const groupOf = (id: number) => f.state.groups.find((g) => g.id === f.state.tabs.find((t) => t.id === id)?.groupId)?.title;
  const stored = async (id: string) => (await store.list()).find((x) => x.id === id);
  return { f, local, clock, closed, menus, store, svc, r, groupOf, stored };
}

const UNRELATED = 'https://unrelated.example/';
/** Session 1: manual project "Taxes" with A (tab 1) and B (tab 2), open in its group. */
async function session1(local: ReturnType<typeof memoryArea>): Promise<string> {
  const before = harness({ local });
  before.f.addTab(tab(1, A));
  before.f.addTab(tab(2, B));
  const id = await before.svc.create(MANUAL, 'Taxes', [1, 2]);
  await before.r.flush();
  expect([1, 2].map(before.groupOf)).toEqual(['Taxes', 'Taxes']);
  return id;
}
/** Browser restart: Chrome restores the Taxes group with A=5, B=6; an unrelated restored tab gets id 1 (the old id of A). */
function restarted(o: { tab1Url?: string; tab1Group?: number } = {}): FakeBrowserPort {
  const port = new FakeBrowserPort();
  port.addWindow(7, { focused: true });
  port.addGroup({ id: 70, windowId: 7, title: 'Taxes', color: 'grey', collapsed: false });
  port.addTab(tab(1, o.tab1Url ?? UNRELATED, { windowId: 7, ...(o.tab1Group !== undefined && { groupId: o.tab1Group }) }));
  port.addTab(tab(5, A, { windowId: 7, groupId: 70 }));
  port.addTab(tab(6, B, { windowId: 7, groupId: 70 }));
  return port;
}

describe('#150: tab ids Chrome reuses after a browser restart', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('S1 the entry whose old id is reused by an unrelated tab rebinds to its restored tab', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const h = harness({ local, port: restarted(), started: true }); // browser restart
    await h.r.flush();
    expect(h.groupOf(1)).toBeUndefined(); // the unrelated tab stays where it was
    expect((await h.stored(id))!.manual.map((m) => m.tabId)).toEqual([5, 6]);
  });

  it('S1b the restored tab of that entry stays a member once dragged out of the group', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const h = harness({ local, port: restarted(), started: true });
    await h.r.flush();
    await h.f.ungroup([5, 6]); // user drags both restored tabs out
    await h.r.flush();
    expect([5, 6].map(h.groupOf)).toEqual(['Taxes', 'Taxes']);
    expect((await h.stored(id))!.manual.map((m) => m.url)).toEqual([A, B]);
  });

  it('S2 adding the unrelated tab with the reused id to another project keeps Taxes entry A and its saved URL', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const h = harness({ local, port: restarted(), started: true });
    await h.r.flush();
    const savedBefore = (await h.stored(id))!.saved?.tabs.map((t) => t.url);
    const updatedBefore = (await h.stored(id))!.updatedAt;
    h.clock.now += 1000;
    await h.svc.create(MANUAL, 'Other', [1]);
    await h.r.flush();
    await h.r.flush();
    const p = (await h.stored(id))!;
    expect({ manual: p.manual.map((m) => m.url), updatedAt: p.updatedAt, saved: p.saved?.tabs.map((t) => t.url), group5: h.groupOf(5) })
      .toEqual({ manual: [A, B], updatedAt: updatedBefore, saved: savedBefore, group5: 'Taxes' });
  });

  it('S3 an unrelated tab at the entry URL that reuses its old id is not taken into the project', async () => {
    const local = memoryArea();
    await session1(local);
    // after the restart nothing of Taxes is restored; the user later opens A in a fresh tab that gets id 1
    const port = new FakeBrowserPort();
    port.addWindow(7, { focused: true });
    port.addTab(tab(3, UNRELATED, { windowId: 7 }));
    const h = harness({ local, port, started: true });
    await h.r.flush();
    h.f.addTab(tab(1, A, { windowId: 7 }));
    await h.r.flush();
    expect(h.groupOf(1)).toBeUndefined(); // ungrouped: no Taxes group pulled up around it
  });

  it('S3b a rule tab (Docs) at an entry URL that reuses the entry id goes to its rule group', async () => {
    const local = memoryArea();
    const before = harness({ local });
    before.f.addTab(tab(1, DOCS));
    before.f.addTab(tab(2, A));
    await before.r.flush();
    await before.svc.create(MANUAL, 'Taxes', [1, 2]);
    await before.r.flush();
    const port = new FakeBrowserPort();
    port.addWindow(7, { focused: true });
    port.addGroup({ id: 70, windowId: 7, title: 'Taxes', color: 'grey', collapsed: false });
    port.addTab(tab(5, A, { windowId: 7, groupId: 70 }));
    const h = harness({ local, port, started: true });
    await h.r.flush();
    h.f.addTab(tab(1, DOCS, { windowId: 7 }));
    await h.r.flush();
    expect(h.groupOf(1)).toBe('Docs');
  });

  it('C1 control: a worker restart (same session area, same ids) keeps a dragged-out own tab', async () => {
    const local = memoryArea();
    const session = sessionArea();
    const first = harness({ local, session });
    first.f.addTab(tab(1, A));
    first.f.addTab(tab(2, B));
    const id = await first.svc.create(MANUAL, 'Taxes', [1, 2]);
    await first.r.flush();
    await first.f.ungroup([1]);
    await first.r.flush();
    expect(first.groupOf(1)).toBe('Taxes');
    const h = harness({ local, session, port: first.f });
    await h.r.flush();
    expect(h.groupOf(1)).toBe('Taxes');
    expect((await h.stored(id))!.manual.map((m) => m.tabId)).toEqual([1, 2]);
  });

  it('C2 control: an extension update (storage.session cleared, same ids) keeps a dragged-out own tab', async () => {
    const local = memoryArea();
    const first = harness({ local });
    first.f.addTab(tab(1, A));
    first.f.addTab(tab(2, B));
    const id = await first.svc.create(MANUAL, 'Taxes', [1, 2]);
    await first.r.flush();
    await first.f.ungroup([1]);
    await first.r.flush();
    const before = (await first.stored(id))!.updatedAt;
    const h = harness({ local, port: first.f }); // fresh session area, same tabs
    await h.r.flush();
    expect(h.groupOf(1)).toBe('Taxes');
    const p = (await h.stored(id))!;
    expect({ ids: p.manual.map((m) => m.tabId), updatedAt: p.updatedAt }).toEqual({ ids: [1, 2], updatedAt: before });
  });

  it('the check writes nothing when every id is valid, and runs once per browser start', async () => {
    const local = memoryArea();
    const session = sessionArea();
    const first = harness({ local, session });
    first.f.addTab(tab(1, A));
    first.f.addTab(tab(2, B));
    const id = await first.svc.create(MANUAL, 'Taxes', [1, 2]);
    await first.r.flush();
    expect(session.data.get(IDS_STALE_KEY)).toBeUndefined(); // no browser start seen: nothing to check
    // A browser start (the tabs keep their ids here): every id is at its URL, so nothing is written.
    const h = harness({ local, session, port: first.f });
    const put = vi.spyOn(h.store, 'put');
    await h.svc.browserStarted();
    await h.r.flush();
    expect({ put: put.mock.calls.length, flag: session.data.get(IDS_STALE_KEY) }).toEqual({ put: 0, flag: false });
    // Later in the session tab 1 navigates away: a new worker (same storage.session) does not check again, so the entry
    // keeps the id of its own tab (it is a member again when the tab comes back to A).
    first.f.state.tabs.find((t) => t.id === 1)!.url = UNRELATED;
    const again = harness({ local, session, port: first.f });
    await again.r.flush();
    expect((await again.stored(id))!.manual.map((m) => m.tabId)).toEqual([1, 2]);
  });

  it('undo after a restart of a tab closed before it: its old id now names an unrelated tab, so nothing is bound (M4-R55 cost)', async () => {
    const local = memoryArea();
    const id = await session1(local); // Taxes {A: 1, B: 2}; then tab 1 is auto-closed (its recently-closed entry keeps id 1)
    const port = new FakeBrowserPort();
    port.addWindow(7, { focused: true });
    port.addGroup({ id: 70, windowId: 7, title: 'Taxes', color: 'grey', collapsed: false });
    port.addTab(tab(1, UNRELATED, { windowId: 7 }));
    port.addTab(tab(6, B, { windowId: 7, groupId: 70 }));
    const h = harness({ local, port, started: true });
    await h.r.flush();
    expect((await h.stored(id))!.manual.map((m) => m.tabId)).toEqual([undefined, 6]);
    h.f.addTab(tab(20, A, { windowId: 7 })); // SafetyService.undo's createTab
    await h.svc.bindUndone(1, 20, A);
    await h.r.flush();
    expect({ ids: (await h.stored(id))!.manual.map((m) => m.tabId), undone: h.groupOf(20), unrelated: h.groupOf(1) })
      .toEqual({ ids: [undefined, 6], undone: undefined, unrelated: undefined });
  });
});

const nav = (h: { f: FakeBrowserPort }, id: number, url: string): void => { h.f.state.tabs.find((t) => t.id === id)!.url = url; };
const noProjects = (): Config['recipes'] => defaultConfig().recipes.map((r) => (r.id === MANUAL ? { ...r, enabled: false } : r));
const ids = async (h: ReturnType<typeof harness>, id: string) => (await h.stored(id))!.manual.map((m) => m.tabId);

/**
 * Manual "Taxes" with A (tab 1) and B (tab 2). The user drags tab 1 out of the group (#150 keeps it a member), then
 * follows a link in it: tab 1 is at UNRELATED, ungrouped, not a member, and its entry keeps id 1.
 */
async function draggedAndAway(h: ReturnType<typeof harness>): Promise<string> {
  h.f.addTab(tab(1, A));
  h.f.addTab(tab(2, B));
  const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
  await h.r.flush();
  await h.f.ungroup([1]);
  await h.r.flush();
  expect(h.groupOf(1)).toBe('Taxes');
  await h.f.ungroup([1]);
  nav(h, 1, UNRELATED);
  await h.r.flush();
  expect({ g: h.groupOf(1), ids: await ids(h, id) }).toEqual({ g: undefined, ids: [1, 2] });
  return id;
}

describe('#150 (M4-R59): only a browser start drops tab ids; an own tab on another page keeps its id', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('control: back at A the tab is a member again', async () => {
    const h = harness();
    const id = await draggedAndAway(h);
    nav(h, 1, A);
    await h.r.flush();
    expect({ ids: await ids(h, id), g: h.groupOf(1) }).toEqual({ ids: [1, 2], g: 'Taxes' });
  });

  it('T-a after an extension update (storage.session cleared, same tab ids) the tab is a member again back at A', async () => {
    const local = memoryArea();
    const first = harness({ local });
    const id = await draggedAndAway(first);
    const h = harness({ local, port: first.f }); // update: new worker, new storage.session, same tabs
    await h.r.flush();
    nav(h, 1, A);
    await h.r.flush();
    expect({ ids: await ids(h, id), g: h.groupOf(1) }).toEqual({ ids: [1, 2], g: 'Taxes' });
  });

  it('T-a2 after an extension update a tab added by hand to a Jira project (strict group) and navigated away rejoins at A', async () => {
    const local = memoryArea();
    const first = harness({ local });
    first.f.addTab(tab(9, 'https://x.atlassian.net/browse/ABC-1'));
    first.f.addTab(tab(1, A));
    await first.r.flush();
    const pid = (await first.store.list())[0]!.id;
    await first.svc.addTab(1, pid);
    await first.r.flush();
    nav(first, 1, UNRELATED);
    await first.r.flush();
    expect(first.groupOf(1)).toBeUndefined();
    const h = harness({ local, port: first.f });
    await h.r.flush();
    nav(h, 1, A);
    await h.r.flush();
    expect(h.groupOf(1)).toBe('ABC-1');
  });

  it('T-b global dry run turned off mid-session (the session started in dry run): back at A the tab is a member again', async () => {
    let dry = true;
    const dryP = program({ dryRun: true });
    const liveP = program();
    const h = harness({ get: async () => (dry ? dryP : liveP) });
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, B));
    const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]); // the Projects page works under dry run
    await h.r.flush();
    nav(h, 1, UNRELATED);
    await h.r.flush();
    dry = false;
    await h.r.flush();
    expect(h.groupOf(2)).toBe('Taxes');
    nav(h, 1, A);
    await h.r.flush();
    expect({ ids: await ids(h, id), g: h.groupOf(1) }).toEqual({ ids: [1, 2], g: 'Taxes' });
  });

  it('T-c Manual projects turned back on mid-session (off since an extension update): back at A the tab is a member again', async () => {
    const local = memoryArea();
    const first = harness({ local });
    const id = await draggedAndAway(first);
    let on = false;
    const offP = program({ recipes: noProjects() });
    const onP = program();
    const h = harness({ local, port: first.f, get: async () => (on ? onP : offP) });
    await h.r.flush();
    on = true;
    await h.r.flush();
    nav(h, 1, A);
    await h.r.flush();
    expect({ ids: await ids(h, id), g: h.groupOf(1) }).toEqual({ ids: [1, 2], g: 'Taxes' });
  });

  it('T-c0 a browser start with no projects recipe on still drops the previous session\'s ids', async () => {
    const local = memoryArea();
    const first = harness({ local });
    const id = await draggedAndAway(first);
    const port = new FakeBrowserPort();
    port.addWindow(7, { focused: true });
    port.addTab(tab(2, UNRELATED, { windowId: 7 })); // a restored tab reuses id 2
    let on = false;
    const offP = program({ recipes: noProjects() });
    const onP = program();
    const h = harness({ local, port, get: async () => (on ? onP : offP), started: true });
    await h.r.flush();
    on = true;
    await h.r.flush();
    expect(await ids(h, id)).toEqual([undefined, undefined]);
  });

  it('P1 onStartup after the first pass: the next pass rebinds, and the restored tabs stay members once dragged out', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const h = harness({ local, port: restarted() });
    await h.r.flush(); // the stale ids are still in place
    await h.svc.browserStarted();
    await h.r.flush();
    await h.f.ungroup([5, 6]);
    await h.r.flush();
    expect({ ids: await ids(h, id), g: [1, 5, 6].map(h.groupOf) }).toEqual({ ids: [5, 6], g: [undefined, 'Taxes', 'Taxes'] });
  });

  it('P2 onStartup before Chrome restored the tabs: every old id is dropped, and the restored tabs rebind in their group', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const port = new FakeBrowserPort();
    port.addWindow(7, { focused: true });
    const h = harness({ local, port, started: true });
    await h.r.flush();
    expect(await ids(h, id)).toEqual([undefined, undefined]);
    port.addGroup({ id: 70, windowId: 7, title: 'Taxes', color: 'grey', collapsed: false });
    port.addTab(tab(1, UNRELATED, { windowId: 7 }));
    port.addTab(tab(5, A, { windowId: 7, groupId: 70 }));
    port.addTab(tab(6, B, { windowId: 7, groupId: 70 }));
    await h.r.flush();
    expect({ ids: await ids(h, id), g: h.groupOf(1) }).toEqual({ ids: [5, 6], g: undefined });
  });

  it('P3 the worker stops between onStartup and the first pass: the flag in storage.session still drops the ids', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const port = restarted();
    const session = sessionArea();
    const first = harness({ local, port, session });
    await first.svc.browserStarted();
    const h = harness({ local, port, session });
    await h.r.flush();
    expect(await ids(h, id)).toEqual([5, 6]);
  });

  it('P4 a browser start under global dry run drops the ids too, so turning dry run off later keeps this session\'s ids', async () => {
    const local = memoryArea();
    const id = await session1(local);
    let dry = true;
    const dryP = program({ dryRun: true });
    const liveP = program();
    const h = harness({ local, port: restarted(), get: async () => (dry ? dryP : liveP), started: true });
    await h.r.flush();
    expect(await ids(h, id)).toEqual([undefined, undefined]); // 1 is stale; 5 and 6 are not bound under dry run
    h.f.addTab(tab(8, DOCS, { windowId: 7 }));
    await h.svc.addTab(8, id);
    nav(h, 8, UNRELATED);
    await h.r.flush();
    dry = false;
    await h.r.flush();
    nav(h, 8, DOCS);
    await h.r.flush();
    expect({ ids: await ids(h, id), g8: h.groupOf(8) }).toEqual({ ids: [5, 6, 8], g8: 'Taxes' });
  });

  it('P5 an extension update drops no id (not even one off its URL) and writes nothing', async () => {
    const local = memoryArea();
    const first = harness({ local });
    const id = await draggedAndAway(first);
    const h = harness({ local, port: first.f });
    const put = vi.spyOn(h.store, 'put');
    await h.r.flush();
    expect({ ids: await ids(h, id), put: put.mock.calls.length }).toEqual({ ids: [1, 2], put: 0 });
  });

  it('undo after an extension update of a tab closed before it rejoins its entry', async () => {
    const local = memoryArea();
    const first = harness({ local });
    first.f.addTab(tab(1, A));
    first.f.addTab(tab(2, B));
    const id = await first.svc.create(MANUAL, 'Taxes', [1, 2]);
    await first.r.flush();
    await first.f.closeTab(1); // auto-closed: its recently-closed entry keeps id 1
    await first.r.flush();
    const h = harness({ local, port: first.f }); // extension update
    await h.r.flush();
    h.f.addTab(tab(20, A)); // SafetyService.undo's createTab
    await h.svc.bindUndone(1, 20, A);
    await h.r.flush();
    expect({ ids: await ids(h, id), g: h.groupOf(20) }).toEqual({ ids: [20, 2], g: 'Taxes' });
  });

  it('a failed check is warned about and retried at the next pass', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const session = sessionArea();
    await session.set(IDS_STALE_KEY, true); // onStartup ran in a worker that stopped
    const get = vi.spyOn(session, 'get').mockRejectedValueOnce(new Error('session gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ local, session, port: restarted() });
    await h.r.flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale tab id check failed'), expect.any(Error));
    h.r.schedule('test');
    await h.r.flush();
    expect({ ids: await ids(h, id), flag: session.data.get(IDS_STALE_KEY), g1: h.groupOf(1) }).toEqual({ ids: [5, 6], flag: false, g1: undefined });
    get.mockRestore();
    warn.mockRestore();
  });

  it('a failed clear of the flag is written again at the next pass, without a second sweep (R5 m-3)', async () => {
    const local = memoryArea();
    const id = await session1(local);
    const session = sessionArea();
    await session.set(IDS_STALE_KEY, true); // onStartup ran in a worker that stopped
    const realSet = session.set;
    let fail = true;
    session.set = async (k: string, v: unknown) => {
      if (k === IDS_STALE_KEY && v === false && fail) { fail = false; throw new Error('session gone'); }
      return realSet(k, v);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ local, session, port: restarted() });
    await h.r.flush();
    const mid = { ids: await ids(h, id), flag: session.data.get(IDS_STALE_KEY) };
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clearing the stale tab id flag failed'), expect.any(Error));
    // Tab 5 (A's restored tab) goes to another page: a second sweep would drop its id.
    h.f.state.tabs.find((t) => t.id === 5)!.url = UNRELATED;
    h.r.schedule('test');
    await h.r.flush();
    // A new worker in the same browser session reads the cleared flag and does not sweep either.
    const again = harness({ local, session, port: h.f });
    await again.r.flush();
    expect({ mid, ids: await ids(again, id), flag: session.data.get(IDS_STALE_KEY) })
      .toEqual({ mid: { ids: [5, 6], flag: true }, ids: [5, 6], flag: false });
    warn.mockRestore();
  });
});

describe('#150: a tab replaced by an id a stale entry still holds', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('the replace wins: the new id moves to the replaced tab\'s entry, the stale entry keeps its URL, and nothing is bumped', async () => {
    const h = harness();
    h.f.addTab(tab(1, A)); h.f.addTab(tab(2, B)); h.f.addTab(tab(3, B));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    const zed = await h.svc.create(MANUAL, 'Zed', [3]);
    await h.r.flush();
    // Zed is archived and holds id 30 from a previous session (not swept: an upgrade session or a missed onStartup).
    const z = (await h.store.list()).find((p) => p.id === zed)!;
    await h.store.put({ ...z, archivedAt: NOW, manual: [{ url: 'https://z.example/', windowId: 1, tabId: 30 }] });
    await h.f.ungroup([1]); // dragged out: still a member by id
    await h.r.flush();
    const before = (await h.store.list()).map((p) => [p.id, p.updatedAt]);
    h.clock.now += 60_000;
    Object.assign(h.f.state.tabs.find((x) => x.id === 1)!, { id: 30 }); // Chrome swaps tab 1 for 30 (discard, prerender)
    await h.svc.onReplaced(30, 1);
    await h.r.flush();
    await h.f.ungroup([30]); // dragged out again: a member only if Taxes holds id 30
    await h.r.flush();
    expect({
      taxes: (await h.stored(taxes))!.manual.map((m) => m.tabId),
      zed: (await h.stored(zed))!.manual.map((m) => [m.url, m.tabId]),
      g: h.groupOf(30),
      updatedAt: (await h.store.list()).map((p) => [p.id, p.updatedAt]),
    }).toEqual({ taxes: [30, 2], zed: [['https://z.example/', undefined]], g: 'Taxes', updatedAt: before });
  });
});

describe('#150: a browser start while the first pass reads the stale-ids flag', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('still drops the old session\'s ids (R4 m-1: the read does not overwrite browserStarted\'s flag)', async () => {
    const local = memoryArea();
    const taxes = await session1(local);
    const session = sessionArea();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const realGet = session.get;
    let reading = false;
    session.get = async (k: string) => {
      if (k !== IDS_STALE_KEY || reading) return realGet(k);
      reading = true;
      const v = await realGet(k); // false: onStartup has not set the flag yet
      await gate;
      return v;
    };
    const h = harness({ local, port: restarted(), session });
    const pass = h.r.flush();
    for (let i = 0; i < 200 && !reading; i++) await new Promise((r) => setTimeout(r, 0));
    expect(reading).toBe(true);
    const started = h.svc.browserStarted();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await pass;
    await started;
    await h.r.flush();
    expect({ ids: (await h.stored(taxes))!.manual.map((m) => m.tabId), flag: session.data.get(IDS_STALE_KEY), g1: h.groupOf(1) })
      .toEqual({ ids: [5, 6], flag: false, g1: undefined });
  });
});
