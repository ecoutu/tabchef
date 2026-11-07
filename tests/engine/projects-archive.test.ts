// M4 T9: archive, unarchive and delete (ProjectService.archive / closeAndArchive / unarchive / remove), the Saved and
// Archived lists of the Projects page (savedLists), and an archived project's Project home. Archived projects take no
// tabs (like tombstones) and are not in the popup, but unlike a tombstone a rule assigning the key does not revive one:
// its tabs are only counted (`held`, "Archived: reopen?").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { PROJECTS_KEY, PRUNE_AFTER_MS, ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Program, Recipe } from '../../src/core/lang/types';
import type { Project } from '../../src/core/projects/types';
import type { Config, TabSnap } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const MANUAL = 'manual-project';
const RID = 'jira-ticket-title';
const PID = `${RID}:ABC-1`;
const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const A = 'https://a.example/';
const B = 'https://b.example/';

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
function program(over: Partial<Config> = {}): Program {
  const base = defaultConfig();
  const c: Config = { ...base, recipes: [...base.recipes, { id: RID, enabled: true, params: {}, source: 'builtin' }], ...over };
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

function harness(o: { program?: Program; local?: ReturnType<typeof memoryArea> } = {}) {
  const p = o.program ?? program();
  const f = new FakeBrowserPort();
  f.addWindow(1, { focused: true });
  const local = o.local ?? memoryArea();
  const clock = { now: NOW };
  const closed: { url: string; reason: string }[] = [];
  const menus: { id: string; title: string }[][] = [];
  const store = new ProjectStore(local);
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p,
    sources: { factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined },
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

/** A kept Manual project "Taxes" of tabs A and B, closed and saved: nothing open, in the Saved list. */
async function savedTaxes(h: H): Promise<string> {
  h.f.addTab(tab(1, A));
  h.f.addTab(tab(2, B));
  const id = await h.svc.create(MANUAL, 'Taxes', [1, 2]);
  await h.r.flush();
  await h.svc.closeAndSave(id);
  await h.r.flush();
  return id;
}
/** The Jira project ABC-1 with its ticket tab (id 1) open and grouped. */
async function ticket(h: H, id = 1): Promise<void> {
  h.f.addTab(tab(id, TICKET));
  await h.r.flush();
}

describe('ProjectService.archive', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('archives a saved project: out of Saved, under Archived, not in the popup or the context menu; updatedAt bumped', async () => {
    const h = harness();
    const id = await savedTaxes(h);
    expect((await h.svc.savedLists()).saved.map((s) => s.id)).toEqual([id]);
    h.clock.now = NOW + 7;
    await h.svc.archive(id);
    expect(await h.stored(id)).toMatchObject({ archivedAt: NOW + 7, updatedAt: NOW + 7, keep: true });
    const lists = await h.svc.savedLists();
    expect(lists.saved).toEqual([]);
    expect(lists.archived).toEqual([expect.objectContaining({ id, title: 'Taxes', archivedAt: NOW + 7, savedCount: 2, held: 0 })]);
    expect(await h.svc.cards()).toEqual([]);
    expect(h.menus.at(-1)).toEqual([]);
  });

  it('refuses a project with open tabs (Close and archive closes them)', async () => {
    const h = harness();
    h.f.addTab(tab(1, A));
    const id = await h.svc.create(MANUAL, 'Taxes', [1]);
    await h.r.flush();
    await expect(h.svc.archive(id)).rejects.toThrow("Close the project's tabs first.");
    expect((await h.stored(id))?.archivedAt).toBeUndefined();
  });

  it('an archived Manual project takes no tabs: its page opened again stays out of any group', async () => {
    const h = harness();
    const id = await savedTaxes(h);
    await h.svc.archive(id);
    h.f.addTab(tab(5, A));
    await h.r.flush();
    expect(h.groupOf(5)).toBeUndefined();
    expect(await h.svc.cards()).toEqual([]);
    await expect(h.svc.addTab(5, id)).rejects.toThrow('this project is archived');
  });

  it('applies under global dry run (a user action, M4-R11)', async () => {
    const local = memoryArea();
    const h = harness({ local });
    const id = await savedTaxes(h);
    const dry = harness({ program: program({ dryRun: true }), local });
    await dry.svc.archive(id);
    expect((await dry.stored(id))?.archivedAt).toBe(NOW);
  });

  it('an archived project is never pruned, kept or not', async () => {
    const local = memoryArea();
    const old: Project = { id: PID, recipeId: RID, key: 'ABC-1', createdAt: NOW, updatedAt: NOW, manual: [], excluded: [], linked: [], archivedAt: NOW, closedFor: PRUNE_AFTER_MS * 2 };
    local.data.set(PROJECTS_KEY, [old]);
    const h = harness({ local });
    h.f.addTab(tab(9, 'https://other.example/'));
    await h.r.flush();
    expect((await h.stored(PID))?.archivedAt).toBe(NOW);
  });
});

describe('ProjectService.closeAndArchive and a rule assigning an archived key', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('closes and saves the tabs, then archives; a rule assigning ABC-1 again does not revive it but is counted (held)', async () => {
    const h = harness();
    await ticket(h);
    expect(h.groupOf(1)).toBe('ABC-1');
    h.clock.now = NOW + 3;
    expect(await h.svc.closeAndArchive(PID)).toEqual({ closed: 1, skipped: 0, ids: ['rc1'] });
    expect(await h.stored(PID)).toMatchObject({ keep: true, archivedAt: NOW + 3, saved: { tabs: [{ url: TICKET }] } });
    expect((await h.stored(PID))?.closedAt).toBeUndefined();
    await ticket(h, 2);
    expect(h.groupOf(2)).toBeUndefined(); // unlike a tombstone: not revived, takes no tab
    expect((await h.store.list()).map((p) => [p.id, p.archivedAt])).toEqual([[PID, NOW + 3]]);
    expect(await h.svc.cards()).toEqual([]);
    expect((await h.svc.savedLists()).archived).toEqual([expect.objectContaining({ id: PID, held: 1 })]);
    expect(await h.svc.home(PID)).toMatchObject({ id: PID, archivedAt: NOW + 3, held: 1, tabs: [], groups: [], keep: true });
  });

  it('Undo of a close-and-archive brings the project back, unarchived', async () => {
    const h = harness();
    await ticket(h);
    await h.svc.closeAndArchive(PID);
    await h.svc.onUndo('rc1');
    const p = await h.stored(PID);
    expect(p?.archivedAt).toBeUndefined();
    expect(p?.closedAt).toBeUndefined();
  });
});

describe('ProjectService.unarchive / reopen / remove', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('unarchive: back to Saved; a held ticket tab joins on the next pass', async () => {
    const h = harness();
    await ticket(h);
    await h.svc.closeAndArchive(PID);
    await ticket(h, 2);
    h.clock.now = NOW + 9;
    await h.svc.unarchive(PID);
    expect(await h.stored(PID)).toMatchObject({ updatedAt: NOW + 9 });
    expect((await h.stored(PID))?.archivedAt).toBeUndefined();
    await h.r.flush();
    expect(h.groupOf(2)).toBe('ABC-1');
  });

  it('reopen of an archived project unarchives it and opens its saved tabs', async () => {
    const h = harness();
    const id = await savedTaxes(h);
    await h.svc.archive(id);
    expect(await h.svc.reopen(id)).toEqual({ opened: 2 });
    expect((await h.stored(id))?.archivedAt).toBeUndefined();
    await h.r.flush();
    expect(h.f.state.tabs.map((t) => h.groupOf(t.id))).toEqual(['Taxes', 'Taxes']);
  });

  it('remove deletes a saved or archived project for good; refused while its tabs are open', async () => {
    const h = harness();
    const id = await savedTaxes(h);
    await h.svc.archive(id);
    await h.svc.remove(id);
    expect(await h.stored(id)).toBeUndefined();
    expect(await h.svc.savedLists()).toEqual({ saved: [], archived: [] });
    await ticket(h, 3);
    await expect(h.svc.remove(PID)).rejects.toThrow("Close the project's tabs first.");
    expect(await h.stored(PID)).toBeDefined();
  });

  it('closeGroup of an archived project is refused (it would otherwise forget it)', async () => {
    const h = harness();
    await ticket(h);
    await h.svc.closeAndArchive(PID);
    await expect(h.svc.closeGroup(PID)).rejects.toThrow('this project is archived');
    expect(await h.stored(PID)).toBeDefined();
  });
});

describe('ProjectService.savedLists', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('Saved: kept projects with nothing open, a project created without tabs too; open and unkept ones are not', async () => {
    const h = harness();
    const empty = await h.svc.create(MANUAL, 'Empty');
    const taxes = await savedTaxes(h);
    await ticket(h, 7); // open: not saved
    const lists = await h.svc.savedLists();
    expect(lists.saved.map((s) => s.id).sort()).toEqual([empty, taxes].sort());
    expect(lists.saved.find((s) => s.id === empty)).toMatchObject({ title: 'Empty', savedCount: 0 });
    expect(lists.archived).toEqual([]);
  });
});

describe('a saved or archived project whose recipe is off (fix round 1)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const manualOff = () => program({ recipes: defaultConfig().recipes.map((r) => (r.id === MANUAL ? { ...r, enabled: false } : r)) });

  it('home falls back to its stored data: name, saved list, no settings, recipeOff; delete still works', async () => {
    const local = memoryArea();
    const id = await savedTaxes(harness({ local }));
    const off = harness({ program: manualOff(), local });
    const home = await off.svc.home(id);
    expect(home).toMatchObject({ id, title: 'Taxes', recipeOff: true, keep: true, tabs: [], groups: [], saved: { tabs: [{ url: A }, { url: B }] } });
    expect(home).not.toHaveProperty('settings');
    expect(home?.recipeName).toBe(builtinRecipes()[MANUAL]!.name);
    await off.svc.remove(id);
    expect(await off.stored(id)).toBeUndefined();
  });

  it('an archived one: home says archived, and unarchive works', async () => {
    const local = memoryArea();
    const on = harness({ local });
    const id = await savedTaxes(on);
    await on.svc.archive(id);
    const off = harness({ program: manualOff(), local });
    expect(await off.svc.home(id)).toMatchObject({ recipeOff: true, archivedAt: NOW, held: 0 });
    await off.svc.unarchive(id);
    expect((await off.stored(id))?.archivedAt).toBeUndefined();
  });

  it('an unknown id is still undefined', async () => {
    const off = harness({ program: manualOff() });
    expect(await off.svc.home(`${MANUAL}:nope`)).toBeUndefined();
  });
});
