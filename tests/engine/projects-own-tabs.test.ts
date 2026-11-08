// #150: a project that comes back takes only its own tabs (M4-R53).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Program, Recipe } from '../../src/core/lang/types';
import type { Config, TabSnap } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const MANUAL = 'manual-project';
const RID = 'jira-ticket-title';
const PID = `${RID}:ABC-1`;
const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
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

function harness(o: { program?: Program; local?: ReturnType<typeof memoryArea>; port?: FakeBrowserPort } = {}) {
  const p = o.program ?? program();
  const f = o.port ?? (() => { const x = new FakeBrowserPort(); x.addWindow(1, { focused: true }); return x; })();
  const local = o.local ?? memoryArea();
  const clock = { now: NOW };
  const closed: { url: string; reason: string }[] = [];
  const menus: { id: string; title: string }[][] = [];
  const store = new ProjectStore(local);
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p,
    sources: { factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined, githubIssues: async () => new Map() },
    facts: { get: () => undefined }, log: { add: () => {} },
    recentlyClosed: { add: (e) => { closed.push(e); return `rc${closed.length}`; } },
    safety: { isProtected: (t) => t.pinned }, state: () => r.liveState(), schedule: vi.fn(), now: () => clock.now,
    onProjectsChanged: (ps) => menus.push(ps), recipeName: async (id) => builtinRecipes()[id]?.name ?? (id === RID ? recipe.name : undefined),
  });
  r = new Reconciler(f, async () => p, { projects: svc, now: () => clock.now, log: { add: () => {} } });
  const groupOf = (id: number) => f.state.groups.find((g) => g.id === f.state.tabs.find((t) => t.id === id)?.groupId)?.title;
  const stored = async (id: string) => (await store.list()).find((x) => x.id === id);
  return { f, local, clock, closed, menus, store, svc, r, groupOf, stored };
}
type H = ReturnType<typeof harness>;


// #150 (M4-R53): a manual entry outlives its tab. It used to take any open tab at its URL once its own tab was gone, and
// manual beats rules, so a project that came back (Reopen, Add to project, a rule revive) pulled a tab the user opened
// elsewhere out of the group its rules gave it. Now a manual entry claims its own tab, a tab at its URL inside the
// project's own titled group (Chrome restores tabs into it after a restart), and the tabs Tabchef opens for the project
// (Reopen, undo), bound by id.

/** The Jira project ABC-1 with its ticket tab (id 1) open and grouped. */
async function ticket(h: H, id = 1): Promise<void> {
  h.f.addTab(tab(id, TICKET));
  await h.r.flush();
}
/** Manual project "Taxes" holding the Jira ticket (tab 1) and A (tab 2), closed and saved: nothing open. */
async function taxesWithTicket(h: H): Promise<string> {
  h.f.addTab(tab(1, TICKET));
  h.f.addTab(tab(2, A));
  await h.r.flush(); // the ticket tab makes ABC-1 by rule…
  const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]); // …and the user moves it into Taxes by hand
  await h.r.flush();
  expect([1, 2].map(h.groupOf)).toEqual(['Taxes', 'Taxes']);
  await h.svc.closeAndSave(id);
  await h.r.flush();
  expect(h.f.state.tabs).toEqual([]);
  return id;
}
/** The user opens the ticket again from Jira (tab 10): its rule puts it in ABC-1. */
async function userOpensTicket(h: H): Promise<void> {
  h.f.addTab(tab(10, TICKET));
  await h.r.flush();
  expect(h.groupOf(10)).toBe('ABC-1');
}

describe('#150: a project that comes back takes only its own tabs', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('Reopen: the ticket tab the user opened from Jira stays in ABC-1', async () => {
    const h = harness();
    const id = await taxesWithTicket(h);
    await userOpensTicket(h);
    await h.svc.reopen(id);
    await h.r.flush();
    expect(h.groupOf(10)).toBe('ABC-1');
    expect((await h.svc.cards()).map((c) => [c.key, c.tabs.map((t) => t.url)]).sort())
      .toEqual([['ABC-1', [TICKET]], ['taxes', [A]]]);
  });

  it('Add to project: adding another tab to the saved project leaves the ticket tab in ABC-1', async () => {
    const h = harness();
    const id = await taxesWithTicket(h);
    await userOpensTicket(h);
    h.f.addTab(tab(11, B));
    await h.svc.addTab(11, id); // revives the closed-and-saved Taxes
    await h.r.flush();
    expect(h.groupOf(11)).toBe('Taxes');
    expect(h.groupOf(10)).toBe('ABC-1');
  });

  it('rule revive: reopening a closed ticket leaves a page the user opened elsewhere in its own group', async () => {
    const h = harness();
    await ticket(h); // ABC-1, ticket tab 1
    h.f.addTab(tab(2, DOCS));
    await h.r.flush();
    expect(h.groupOf(2)).toBe('Docs');
    await h.svc.addTab(2, PID); // the user adds the doc to ABC-1 by hand
    await h.r.flush();
    expect(h.groupOf(2)).toBe('ABC-1');
    await h.svc.closeGroup(PID); // tombstone, manual entry for DOCS kept
    await h.r.flush();
    h.f.addTab(tab(10, DOCS)); // the user opens the doc again, later, for something else
    await h.r.flush();
    expect(h.groupOf(10)).toBe('Docs');
    h.f.addTab(tab(11, TICKET)); // …then the ticket: its rule revives ABC-1
    await h.r.flush();
    await h.r.flush(); // the revive schedules a pass for its manual entries
    expect(h.groupOf(11)).toBe('ABC-1');
    expect(h.groupOf(10)).toBe('Docs');
  });

  it('no revive: a kept project whose tab was closed by hand does not take a new tab at that URL', async () => {
    const h = harness();
    h.f.addTab(tab(1, TICKET));
    h.f.addTab(tab(2, A));
    await h.r.flush();
    await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    await h.r.flush();
    await h.f.closeTab(1); // closed by hand: Taxes stays open (tab 2), its ticket entry outlives tab 1
    await h.r.flush();
    h.f.addTab(tab(10, TICKET)); // the user opens the ticket again from Jira
    await h.r.flush();
    expect(h.groupOf(10)).toBe('ABC-1');
  });

  it('after a browser restart (new tab ids) a Manual project re-finds its own restored tabs and keeps their new ids', async () => {
    const local = memoryArea();
    const before = harness({ local });
    await before.svc.create(MANUAL, 'Taxes', []).catch(() => undefined);
    before.f.addTab(tab(1, A));
    before.f.addTab(tab(2, B));
    await before.svc.addTab(1, `${MANUAL}:taxes`);
    await before.svc.addTab(2, `${MANUAL}:taxes`);
    await before.r.flush();
    expect([1, 2].map(before.groupOf)).toEqual(['Taxes', 'Taxes']);
    // Restart: Chrome restores the window, the group and its tabs, under new ids.
    const port = new FakeBrowserPort();
    port.addWindow(7, { focused: true });
    port.addGroup({ id: 70, windowId: 7, title: 'Taxes', color: 'grey', collapsed: false });
    port.addTab(tab(101, A, { windowId: 7, groupId: 70 }));
    port.addTab(tab(102, B, { windowId: 7, groupId: 70 }));
    const h = harness({ local, port });
    await h.r.flush();
    expect((await h.svc.cards()).map((c) => [c.key, c.tabs.map((t) => t.tabId)])).toEqual([['taxes', [101, 102]]]);
    // The claim is written back (no user change: updatedAt stays), so a tab dragged out of the group stays a member.
    const before150 = (await before.stored(`${MANUAL}:taxes`))!;
    const after = (await h.stored(`${MANUAL}:taxes`))!;
    expect(after.manual.map((m) => m.tabId)).toEqual([101, 102]);
    expect(after.updatedAt).toBe(before150.updatedAt);
    await h.f.ungroup([101]);
    await h.r.flush();
    expect((await h.svc.cards()).map((c) => [c.key, c.tabs.map((t) => t.tabId)])).toEqual([['taxes', [101, 102]]]);
  });

  it('after a browser restart, tabs that come back outside the project\'s group are not taken', async () => {
    const local = memoryArea();
    const before = harness({ local });
    before.f.addTab(tab(1, A));
    before.f.addTab(tab(2, B));
    await before.svc.create(MANUAL, 'Taxes', [1, 2]);
    await before.r.flush();
    const port = new FakeBrowserPort();
    port.addWindow(7, { focused: true });
    port.addTab(tab(101, A, { windowId: 7 }));
    port.addTab(tab(102, B, { windowId: 7 }));
    const h = harness({ local, port });
    await h.r.flush();
    expect(await h.svc.cards()).toEqual([]);
    expect((await h.stored(`${MANUAL}:taxes`))!.manual.map((m) => m.tabId)).toEqual([1, 2]);
  });

  it('undo of Close group: the tab Tabchef reopens (new id) is bound to the project', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    const id = await h.svc.create(MANUAL, 'Taxes', [1]);
    await h.r.flush();
    const { ids } = await h.svc.closeGroup(id);
    await h.svc.onUndo(ids[0]!);
    h.f.addTab(tab(20, A)); // SafetyService.undo's createTab
    await h.svc.bindUndone(1, 20, A); // SafetyService.onUndone
    await h.r.flush();
    expect(h.groupOf(20)).toBe('Taxes');
  });

  it('undo binds only the entry it restores: an unrelated undo id binds nothing', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    const id = await h.svc.create(MANUAL, 'Taxes', [1]);
    await h.r.flush();
    const { ids } = await h.svc.closeGroup(id);
    await h.svc.onUndo(ids[0]!);
    h.f.addTab(tab(20, A));
    await h.svc.bindUndone(99, 20, A);
    await h.r.flush();
    expect(h.groupOf(20)).toBeUndefined();
    expect((await h.stored(id))!.manual.map((m) => m.tabId)).toEqual([1]);
  });

  it('Reopen leaves a saved tab open in another project where it is, opens no copy, and counts it', async () => {
    const h = harness();
    const id = await taxesWithTicket(h);
    await userOpensTicket(h);
    expect(await h.svc.reopen(id)).toEqual({ opened: 1, elsewhere: 1 });
    await h.r.flush();
    expect(h.f.state.tabs.filter((t) => t.url === TICKET).map((t) => t.id)).toEqual([10]);
    // The saved list stays frozen with the ticket in it (M4-R14): it is still Taxes's.
    const p = (await h.stored(id))!;
    expect(p.saved?.tabs.map((t) => t.url)).toEqual([TICKET, A]);
    expect(p.saved?.closed).toBe(true);
  });

  it('Reopen leaves a saved tab in a rule\'s group where it is, and counts it', async () => {
    const h = harness();
    h.f.addTab(tab(1, DOCS));
    h.f.addTab(tab(2, A));
    await h.r.flush();
    const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    await h.r.flush();
    await h.svc.closeAndSave(id);
    await h.r.flush();
    h.f.addTab(tab(10, DOCS));
    await h.r.flush();
    expect(h.groupOf(10)).toBe('Docs');
    expect(await h.svc.reopen(id)).toEqual({ opened: 1, elsewhere: 1 });
    await h.r.flush();
    expect(h.groupOf(10)).toBe('Docs');
    expect(h.f.state.tabs.filter((t) => t.url === DOCS)).toHaveLength(1);
  });

  it('Reopen takes an ungrouped tab no project holds at a saved URL instead of opening a copy', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, B));
    const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    await h.r.flush();
    await h.svc.closeAndSave(id);
    await h.r.flush();
    h.f.addTab(tab(10, A));
    await h.r.flush();
    expect(h.groupOf(10)).toBeUndefined();
    expect(await h.svc.reopen(id)).toEqual({ opened: 1 });
    await h.r.flush();
    expect(h.groupOf(10)).toBe('Taxes');
    expect(h.f.state.tabs.filter((t) => t.url === A)).toHaveLength(1);
  });

  it('start() of a closed project does not take a tab at its URL outside its group', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    const id = await h.svc.create(MANUAL, 'Taxes', [1]);
    await h.r.flush();
    await h.svc.closeGroup(id); // tombstone with its entry for A
    await h.r.flush();
    h.f.addTab(tab(10, A));
    await h.r.flush();
    expect(await h.svc.start(MANUAL, 'taxes')).toBe(id);
    await h.r.flush();
    await h.r.flush();
    expect(h.groupOf(10)).toBeUndefined();
  });

  it('a backup import (no tab ids) takes only the tabs in the project\'s titled group', async () => {
    const h = harness();
    h.f.addGroup({ id: 50, windowId: 1, title: 'Taxes', color: 'grey', collapsed: false });
    h.f.addTab(tab(1, A, { groupId: 50 }));
    h.f.addTab(tab(2, B));
    const raw = [{ id: `${MANUAL}:taxes`, recipeId: MANUAL, key: 'taxes', name: 'Taxes', createdAt: NOW, updatedAt: NOW,
      manual: [{ url: A, windowId: 1 }, { url: B, windowId: 1 }], excluded: [], linked: [], keep: true }];
    await h.svc.importProjects(raw, { overwrite: [] });
    await h.r.flush();
    expect((await h.svc.cards()).map((c) => [c.key, c.tabs.map((t) => t.tabId)])).toEqual([['taxes', [1]]]);
    expect(h.groupOf(2)).toBeUndefined();
  });
});

// #150 (M4-R58): a tab id names at most one manual entry across all projects. join and removeTab drop every entry
// holding a tab's id, so an entry whose own tab is gone never takes a tab another entry holds by id (it is on another
// page for now), even inside the project's group; the tab stays a member through the group.
const OTHER_URL = 'https://unrelated.example/';
const C = 'https://c.example/';
const D = 'https://d.example/';
const nav = (h: H, id: number, url: string): void => { h.f.state.tabs.find((t) => t.id === id)!.url = url; };
const groupIdOf = (h: H, title: string): number => h.f.state.groups.find((g) => g.title === title)!.id;
/** Every manual tab id across all stored projects, with duplicates. */
const allIds = async (h: H): Promise<number[]> => (await h.store.list()).flatMap((p) => p.manual.flatMap((m) => (m.tabId === undefined ? [] : [m.tabId])));
const dupes = (ids: number[]): number[] => ids.filter((x, i) => ids.indexOf(x) !== i);

/** Taxes = A (tab 1), B (tab 2); tab 1 closed by hand; tab 2 (B's own, in Taxes) shows A for a pass, then B again. */
async function x1(o: { back?: boolean; keep?: boolean } = {}): Promise<{ h: H; id: string }> {
  const h = harness();
  h.f.addTab(tab(1, A));
  h.f.addTab(tab(2, B));
  const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
  if (o.keep) await h.svc.setKeep(id, true);
  await h.r.flush();
  await h.f.closeTab(1);
  await h.r.flush();
  nav(h, 2, A);
  await h.r.flush();
  if (o.back !== false) { nav(h, 2, B); await h.r.flush(); }
  return { h, id };
}

describe('#150: a tab id names one manual entry', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('V0 an entry whose tab is gone does not take another entry\'s own tab at its URL; that tab stays a member', async () => {
    const { h, id } = await x1({ back: false });
    expect({ ids: (await h.stored(id))!.manual.map((m) => m.tabId), g: h.groupOf(2), dupes: dupes(await allIds(h)) })
      .toEqual({ ids: [1, 2], g: 'Taxes', dupes: [] });
  });

  it('V1 adding that tab to another project afterwards keeps the other Taxes entry', async () => {
    const { h, id } = await x1();
    h.f.addTab(tab(3, OTHER_URL));
    await h.svc.create(MANUAL, 'Other', [2, 3]);
    await h.r.flush();
    expect((await h.stored(id))?.manual.map((m) => m.url)).toEqual([A]);
  });

  it('V2 removing that tab from its project afterwards removes only its own entry', async () => {
    const { h, id } = await x1();
    await h.svc.removeTab(2);
    await h.r.flush();
    expect((await h.stored(id))?.manual.map((m) => m.url)).toEqual([A]);
  });

  it('V3 another project\'s own tab dragged into Taxes and shown at A stays that project\'s', async () => {
    const h = harness();
    h.f.addTab(tab(1, A)); h.f.addTab(tab(2, B)); h.f.addTab(tab(3, C)); h.f.addTab(tab(4, D));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    const other = await h.svc.create(MANUAL, 'Other', [3, 4]);
    await h.r.flush();
    await h.f.closeTab(1);
    await h.r.flush();
    await h.f.group([3], { groupId: groupIdOf(h, 'Taxes'), windowId: 1 });
    nav(h, 3, A);
    await h.r.flush();
    const dup = dupes(await allIds(h));
    nav(h, 3, C);
    await h.r.flush();
    h.f.addTab(tab(5, OTHER_URL));
    await h.svc.create(MANUAL, 'Third', [3, 5]);
    await h.r.flush();
    const t = (await h.stored(taxes))?.manual.map((m) => m.url);
    const o = (await h.stored(other))?.manual.map((m) => m.url);
    expect({ dup, t, o }).toEqual({ dup: [], t: [A, B], o: [D] });
  });

  it('V4 the entry later takes a copy of A dragged into Taxes, which stays a member once dragged out', async () => {
    const { h } = await x1();
    h.f.addTab(tab(7, A));
    await h.f.group([7], { groupId: groupIdOf(h, 'Taxes'), windowId: 1 });
    await h.r.flush();
    await h.f.ungroup([7]);
    await h.r.flush();
    expect(h.groupOf(7)).toBe('Taxes');
  });

  it('V6 the saved list (kept project) is as before while B\'s tab shows A', async () => {
    const { h, id } = await x1({ back: false, keep: true });
    // A was closed by hand (left the list), B's tab left B (left the list), tab 2 at A is a member (added).
    expect({ saved: (await h.stored(id))!.saved?.tabs.map((t) => t.url), dupes: dupes(await allIds(h)) }).toEqual({ saved: [A], dupes: [] });
  });

  it('an archived project\'s entry holding a tab keeps it from being rebound into another project', async () => {
    const h = harness();
    h.f.addTab(tab(1, A)); h.f.addTab(tab(2, B)); h.f.addTab(tab(3, C));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    const other = await h.svc.create(MANUAL, 'Other', [3]);
    await h.r.flush();
    await h.f.closeTab(1);
    await h.r.flush();
    // Other is archived while its tab 3 stays open; the user drags tab 3 into Taxes and opens A in it.
    const s = (await h.store.list()).find((p) => p.id === other)!;
    await h.store.put({ ...s, archivedAt: NOW });
    await h.f.group([3], { groupId: groupIdOf(h, 'Taxes'), windowId: 1 });
    nav(h, 3, A);
    await h.r.flush();
    expect({ taxes: (await h.stored(taxes))!.manual.map((m) => m.tabId), dupes: dupes(await allIds(h)) }).toEqual({ taxes: [1, 2], dupes: [] });
  });
});

// #150 (M4-R60): Reopen never takes a tab another project's manual entry holds by id, even while that tab shows a saved
// page of the reopened project and sits ungrouped (its project open, closed or archived): join would delete that entry.
// Explicit joins (Add to project, create, Save group as project) still move a held tab in.
const XN = 'https://x.example/notes';
const manualOf = async (h: H, id: string) => (await h.stored(id))!.manual.map((m) => [m.url, m.tabId]);
/** Kept Manual "Taxes" saved with A (tab 3), closed and saved: nothing open. */
async function savedTaxes(h: H): Promise<string> {
  h.f.addTab(tab(3, A));
  const taxes = await h.svc.create(MANUAL, 'Taxes', [3]);
  await h.r.flush();
  await h.svc.closeAndSave(taxes);
  await h.r.flush();
  return taxes;
}
/** Manual "Notes" holding tab 7 at XN and tab 8 at B; the user follows a link in 7 to A, then drags 7 out of the group. */
async function notesTabAwayAtA(h: H): Promise<string> {
  h.f.addTab(tab(7, XN));
  h.f.addTab(tab(8, B));
  const notes = await h.svc.create(MANUAL, 'Notes', [7, 8]);
  await h.r.flush();
  nav(h, 7, A); // a Manual-only group is not strict: the tab stays in Notes' group
  await h.r.flush();
  await h.f.ungroup([7]);
  await h.r.flush();
  expect(h.groupOf(7)).toBeUndefined();
  return notes;
}

describe('#150: Reopen leaves a tab another project holds by id where it is', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('an ungrouped tab no project holds at a saved URL joins', async () => {
    const h = harness();
    const taxes = await savedTaxes(h);
    h.f.addTab(tab(9, A));
    await h.r.flush();
    const r = await h.svc.reopen(taxes);
    await h.r.flush();
    expect({ r, g: h.groupOf(9), m: await manualOf(h, taxes) }).toEqual({ r: { opened: 0 }, g: 'Taxes', m: [[A, 3], [A, 9]] });
  });

  it('a Jira project\'s hand-added tab showing a saved page keeps its entry, unchanged, and rejoins on Back', async () => {
    const h = harness();
    await ticket(h, 1);
    const abc = (await h.store.list()).find((p) => p.key === 'ABC-1')!.id;
    h.f.addTab(tab(7, XN));
    await h.svc.addTab(7, abc);
    await h.r.flush();
    const taxes = await savedTaxes(h);
    nav(h, 7, A); // the strict Jira group: the planner ungroups the tab
    await h.r.flush();
    const before = (await h.stored(abc))!.updatedAt;
    h.clock.now += 60_000;
    const r = await h.svc.reopen(taxes);
    await h.r.flush();
    const mid = { r, g7: h.groupOf(7), abc: await manualOf(h, abc), bumped: (await h.stored(abc))!.updatedAt !== before };
    nav(h, 7, XN);
    await h.r.flush();
    expect({ ...mid, back: h.groupOf(7) })
      .toEqual({ r: { opened: 0, elsewhere: 1 }, g7: undefined, abc: [[XN, 7]], bumped: false, back: 'ABC-1' });
  });

  it('a Manual project\'s own tab, dragged out and showing a saved page, keeps its entry', async () => {
    const h = harness();
    const taxes = await savedTaxes(h);
    const notes = await notesTabAwayAtA(h);
    const r = await h.svc.reopen(taxes);
    await h.r.flush();
    expect({ r, g7: h.groupOf(7), notes: await manualOf(h, notes) })
      .toEqual({ r: { opened: 0, elsewhere: 1 }, g7: undefined, notes: [[XN, 7], [B, 8]] });
  });

  it('an archived project\'s entry keeps its tab', async () => {
    const h = harness();
    const taxes = await savedTaxes(h);
    const notes = await notesTabAwayAtA(h);
    await h.f.closeTab(8);
    await h.r.flush();
    await h.svc.archive(notes);
    await h.r.flush();
    const r = await h.svc.reopen(taxes);
    await h.r.flush();
    expect({ r, notes: await manualOf(h, notes), archived: (await h.stored(notes))!.archivedAt !== undefined })
      .toEqual({ r: { opened: 0, elsewhere: 1 }, notes: [[XN, 7], [B, 8]], archived: true });
  });

  it('a project closed by Close group (its away tab left open) keeps its entry for undo', async () => {
    const h = harness();
    const taxes = await savedTaxes(h);
    const notes = await notesTabAwayAtA(h);
    await h.svc.closeGroup(notes); // closes tab 8 only
    await h.r.flush();
    expect((await h.stored(notes))!.closedAt).toBeDefined();
    const r = await h.svc.reopen(taxes);
    await h.r.flush();
    expect({ r, notes: await manualOf(h, notes) }).toEqual({ r: { opened: 0, elsewhere: 1 }, notes: [[XN, 7], [B, 8]] });
  });

  it('Save group as project still moves a tab another project holds into the new project', async () => {
    const h = harness();
    const notes = await notesTabAwayAtA(h);
    const gid = await h.f.group([7], { windowId: 1 });
    h.f.state.groups.find((x) => x.id === gid)!.title = 'Mine';
    await h.r.flush();
    await h.svc.saveGroup(gid);
    expect(await manualOf(h, notes)).toEqual([[B, 8]]);
  });
});

// R4 I-1: an entry is a saved page. A project's own tab that moved to another of its pages joins as that page (Reopen,
// Add to project) and its old entry keeps its URL, without the id: join never deletes the project's own entries.
describe('#150: a project\'s own tab on another of its pages keeps its old entry when it joins', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  /** Manual "Taxes": tab 1 at A, tab 2 at B; tab 1 goes to B, is dragged out, tab 2 is closed: Taxes is Saved with [B]. */
  async function ownTabAtB(h: H): Promise<string> {
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, B));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    await h.r.flush();
    nav(h, 1, B);
    await h.r.flush();
    await h.f.ungroup([1]);
    await h.r.flush();
    await h.f.closeTab(2);
    await h.r.flush();
    expect({ g1: h.groupOf(1), saved: (await h.stored(taxes))!.saved?.tabs.map((t) => t.url), m: await manualOf(h, taxes) })
      .toEqual({ g1: undefined, saved: [B], m: [[A, 1], [B, 2]] });
    return taxes;
  }

  it('Reopen takes the own tab showing a saved page and keeps the entry it came from', async () => {
    const h = harness();
    const taxes = await ownTabAtB(h);
    const r = await h.svc.reopen(taxes);
    await h.r.flush();
    expect({ r, g1: h.groupOf(1), m: await manualOf(h, taxes) })
      .toEqual({ r: { opened: 0 }, g1: 'Taxes', m: [[A, undefined], [B, 2], [B, 1]] });
    // Back to A inside the group: still a Taxes tab (entry A takes it in the project's group).
    nav(h, 1, A);
    await h.r.flush();
    expect(h.groupOf(1)).toBe('Taxes');
  });

  it('Reopen of a closed project whose pinned own tab now shows a saved page keeps entry A', async () => {
    const h = harness();
    h.f.addTab(tab(1, A, { pinned: true }));
    h.f.addTab(tab(2, B));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    await h.r.flush();
    nav(h, 1, B);
    await h.r.flush();
    await h.svc.closeGroup(taxes);
    await h.r.flush();
    await h.svc.reopen(taxes);
    await h.r.flush();
    // Close group closed tab 2, whose entry keeps its id for undo; the pinned tab joins as B and A keeps no id.
    expect(await manualOf(h, taxes)).toEqual([[A, undefined], [B, 2], [B, 1]]);
  });

  it('Add to project of the own tab on another page keeps its old entry', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, B));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    await h.r.flush();
    nav(h, 1, DOCS);
    await h.r.flush();
    await h.svc.addTab(1, taxes);
    await h.r.flush();
    expect({ g1: h.groupOf(1), m: await manualOf(h, taxes) }).toEqual({ g1: 'Taxes', m: [[A, undefined], [B, 2], [DOCS, 1]] });
  });

  it('the kept old-page entry does not take a tab the user opens at that page outside the group', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1]);
    await h.r.flush();
    nav(h, 1, DOCS);
    await h.f.ungroup([1]);
    await h.r.flush();
    await h.svc.addTab(1, taxes);
    await h.r.flush();
    h.f.addTab(tab(5, A));
    await h.r.flush();
    expect({ g5: h.groupOf(5), m: await manualOf(h, taxes) }).toEqual({ g5: undefined, m: [[A, undefined], [DOCS, 1]] });
  });

  it('removing the tab after such a join removes its current-page entry and keeps the old-page one', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    h.f.addTab(tab(2, B));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
    await h.r.flush();
    nav(h, 1, DOCS);
    await h.r.flush();
    await h.svc.addTab(1, taxes);
    await h.r.flush();
    await h.svc.removeTab(1);
    await h.r.flush();
    // Current behaviour: remove takes the tab's own entry (and any at its current URL), not the page it came from.
    // Whether Remove should also drop the kept old-page entry is #168 (page-scoped remove).
    expect({ g1: h.groupOf(1), m: await manualOf(h, taxes) }).toEqual({ g1: 'Docs', m: [[A, undefined], [B, 2]] });
  });

  it('Add to project of the own tab at its own page leaves one entry', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    const taxes = await h.svc.create(MANUAL, 'Taxes', [1]);
    await h.r.flush();
    await h.svc.addTab(1, taxes);
    expect(await manualOf(h, taxes)).toEqual([[A, 1]]);
  });
});

// #150 with two GitHub issue projects of the same number: a `#12` group may be either repo's. Reopen of acme/web#12
// names its group as the next pass will (web#12, other/api#12 being open), so a copy of a saved page sitting in
// other/api#12's "#12 · B" group is not its own group's tab: it stays there and counts as elsewhere.
describe('#150: Reopen of an issue project leaves a copy in another repo\'s #N group', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const GH = 'github-issue';
  const ISSUE_A = 'https://github.com/acme/web/issues/12';
  const ISSUE_B = 'https://github.com/other/api/issues/12';
  const NOTES = 'https://notes.example/design';
  const ghProgram = (): Program => {
    const base = defaultConfig();
    return program({ recipes: base.recipes.map((r) => (r.id === GH ? { ...r, enabled: true, params: { titleFormat: '#{num} · {summary}' } } : r)) });
  };

  it('Reopen of acme/web#12 leaves the copy in other/api#12\'s "#12 · B" group where it is and counts it', async () => {
    const h = harness({ program: ghProgram() });
    const a = `${GH}:acme/web#12`;
    const b = `${GH}:other/api#12`;
    h.f.addTab(tab(1, ISSUE_A));
    h.f.addTab(tab(2, NOTES));
    await h.r.flush();
    await h.svc.addTab(2, a);
    await h.r.flush();
    expect([1, 2].map(h.groupOf)).toEqual(['#12', '#12']);
    await h.svc.closeAndSave(a);
    await h.r.flush();
    expect(h.f.state.tabs).toEqual([]);
    // other/api#12 is the only #12 open now; a copy of the saved page sits in its group, no project's own tab.
    h.f.addTab(tab(3, ISSUE_B, { title: 'B · Issue #12 · other/api' }));
    await h.r.flush();
    expect(h.groupOf(3)).toBe('#12 · B');
    h.f.addTab(tab(4, NOTES, { groupId: groupIdOf(h, '#12 · B') }));
    expect((await h.store.list()).find((p) => p.id === b)?.manual).toEqual([]);
    expect(await h.svc.reopen(a)).toEqual({ opened: 1, elsewhere: 1 });
    expect(h.groupOf(4)).toBe('#12 · B');
    expect((await h.stored(a))!.manual.map((m) => m.tabId)).not.toContain(4);
  });
});
