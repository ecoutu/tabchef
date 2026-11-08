// M4 T6: Manual projects (ProjectService.create) and starting an on-request project (ProjectService.start).
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

/** A rule-based project recipe; `start` as given. */
const repo = (start: 'auto' | 'on-request'): Recipe => ({
  recipe: 'repo', version: 1, name: 'Repo', description: 'x',
  project: { key: '{owner}/{repo}', title: '{key}', color: 'green', container: 'group', join: ['rules', 'manual'], start },
  rules: [{
    id: 'repo', name: 'Repo page', enabled: true, match: { url: 'github.com/:owner/:repo*' },
    actions: [{ assignProject: { key: '{owner}/{repo}' } }],
  }],
});

/** A Jira ticket project recipe (installed under the id `repo` by program()). */
const jira: Recipe = {
  recipe: 'repo', version: 1, name: 'Jira', description: 'x',
  project: { key: '{key}', title: '{key}', color: 'blue', container: 'group', join: ['rules', 'manual'] },
  rules: [{
    id: 'ticket', name: 'Jira ticket', enabled: true, match: { url: '*.atlassian.net/browse/*' },
    extract: { key: { from: 'url', jiraKey: {} } },
    actions: [{ assignProject: { key: '{key}', create: true } }],
  }],
};

/** The default config (the built-in manual-project recipe is on) plus `repo` when given. */
function program(o: { repo?: Recipe; over?: Partial<Config> } = {}): Program { // `repo`: installed as recipe id 'repo'
  const d = defaultConfig();
  const c: Config = { ...d, recipes: [...d.recipes, ...(o.repo ? [{ id: 'repo', enabled: true, params: {}, source: 'builtin' as const }] : [])], ...o.over };
  const { program: p, errors } = compileProgram(c, { ...builtinRecipes(), ...(o.repo && { repo: o.repo }) });
  expect(errors).toEqual([]);
  return p;
}
const tab = (id: number, url: string, o: Partial<TabSnap> = {}) => ({
  id, windowId: 1, url, title: url, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const memoryArea = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))]))),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); }),
  };
};

function harness(p: Program = program()) {
  const f = new FakeBrowserPort();
  f.addWindow(1, { focused: true });
  const logs: { tabId?: number; action: string; detail: string }[] = [];
  const store = new ProjectStore(memoryArea());
  const schedule = vi.fn();
  const sources = {
    factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined, githubIssues: async () => new Map(),
  };
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p, sources, facts: { get: () => undefined }, log: { add: (e) => logs.push(e) },
    recentlyClosed: { add: () => 'rc' }, safety: { isProtected: () => false }, state: () => r.liveState(), schedule, now: () => NOW,
    recipeName: async (id) => builtinRecipes()[id]?.name,
  });
  r = new Reconciler(f, async () => p, { projects: svc, now: () => NOW, log: { add: (e) => logs.push(e) } });
  const groupOf = (id: number) => f.state.groups.find((g) => g.id === f.state.tabs.find((t) => t.id === id)?.groupId);
  return { f, logs, store, schedule, svc, r, groupOf };
}

describe('ProjectService.create (Manual projects)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it("create('manual-project', 'Tax 2026', [5]) stores a kept project keyed by the name's slug, and tab 5 joins it", async () => {
    const h = harness();
    h.f.addTab(tab(5, 'https://irs.example/forms'));
    const id = await h.svc.create(MANUAL, 'Tax 2026', [5]);
    expect(id).toBe(`${MANUAL}:tax-2026`);
    expect(await h.store.list()).toEqual([{
      id, recipeId: MANUAL, key: 'tax-2026', name: 'Tax 2026', keep: true, createdAt: NOW, updatedAt: NOW,
      manual: [{ url: 'https://irs.example/forms', windowId: 1, tabId: 5 }], excluded: [], linked: [],
    }]);
    expect(h.logs.filter((l) => l.action === 'project-join').map((l) => [l.tabId, l.detail])).toEqual([[5, 'Joined tax-2026 manually']]);
    expect(h.schedule).toHaveBeenCalledWith('project');
    await h.r.flush();
    expect(h.groupOf(5)).toMatchObject({ title: 'Tax 2026', color: 'grey' });
    expect((await h.svc.cards()).map((c) => [c.id, c.title, c.tabs.map((t) => t.tabId)])).toEqual([[id, 'Tax 2026', [5]]]);
  });

  it('a name the Projects page already lists is refused, naming where it is (Open, Saved, Archived); no "Name (2)"', async () => {
    const h = harness();
    h.f.addTab(tab(1, 'https://a.example/'));
    await h.svc.create(MANUAL, 'Media', [1]);
    await h.svc.create(MANUAL, 'Taxes');
    const old = await h.svc.create(MANUAL, 'Old');
    await h.svc.archive(old);
    await h.r.flush();
    const before = await h.store.list();
    await expect(h.svc.create(MANUAL, 'Media')).rejects.toThrow('A project named “Media” already exists (Open). Open it, or pick another name.');
    await expect(h.svc.create(MANUAL, ' Taxes ')).rejects.toThrow('A project named “Taxes” already exists (Saved). Open it, or pick another name.');
    await expect(h.svc.create(MANUAL, 'Old')).rejects.toThrow('A project named “Old” already exists (Archived). Open it, or pick another name.');
    expect(await h.store.list()).toEqual(before);
  });

  it('a different name with a taken slug gets the next key', async () => {
    const h = harness();
    expect(await h.svc.create(MANUAL, 'Tax 2026')).toBe(`${MANUAL}:tax-2026`);
    expect(await h.svc.create(MANUAL, 'tax  2026!')).toBe(`${MANUAL}:tax-2026-2`);
    expect((await h.store.list()).map((p) => [p.key, p.name])).toEqual([['tax-2026', 'Tax 2026'], ['tax-2026-2', 'tax  2026!']]);
  });

  it("a name equal to an open project's title (a Jira key) is refused (Open)", async () => {
    const h = harness(program({ repo: jira }));
    h.f.addTab(tab(1, 'https://acme.atlassian.net/browse/ABC-1'));
    h.f.addTab(tab(2, 'https://b.example/'));
    await h.r.flush();
    expect(h.groupOf(1)?.title).toBe('ABC-1');
    await expect(h.svc.create(MANUAL, 'ABC-1', [2])).rejects.toThrow('A project named “ABC-1” already exists (Open).');
    expect((await h.store.list()).filter((p) => p.recipeId === MANUAL)).toEqual([]);
  });

  it("a name equal to an open rule group's title is refused: the project's group would merge with it", async () => {
    const rules = [{ id: 'gh', name: 'GitHub', enabled: true, match: { url: 'gh.example/*' }, actions: [{ group: { title: 'GitHub', color: 'green' } }] }];
    const h = harness(program({ over: { rules: (rules as unknown) as Config['rules'] } }));
    h.f.addTab(tab(7, 'https://gh.example/a'));
    h.f.addTab(tab(8, 'https://gh.example/b'));
    await h.r.flush();
    expect(h.groupOf(7)?.title).toBe('GitHub');
    await expect(h.svc.create(MANUAL, 'GitHub')).rejects.toThrow('A group named “GitHub” is already open. Pick another name.');
    expect(await h.store.list()).toEqual([]);
    expect(await h.svc.create(MANUAL, 'Code')).toBe(`${MANUAL}:code`); // other names are free
  });

  it('#157: an open project\'s card says whether it is kept, so the Done prompt does not offer to keep it again', async () => {
    const h = harness();
    h.f.addTab(tab(5, 'https://youtube.example/'));
    const id = await h.svc.create(MANUAL, 'Media', [5]);
    await h.r.flush();
    expect((await h.svc.cards()).map((c) => [c.id, c.keep])).toEqual([[id, true]]);
    await h.svc.setKeep(id, false);
    expect((await h.svc.cards())[0]).not.toHaveProperty('keep');
  });

  it('a hidden project of the same name (not kept, nothing open, not archived) is replaced, key and all', async () => {
    const h = harness();
    h.f.addTab(tab(5, 'https://youtube.example/'));
    const id = await h.svc.create(MANUAL, 'Media', [5]);
    await h.r.flush();
    await h.svc.setKeep(id, false);
    await h.f.closeTab(5);
    await h.r.flush();
    expect((await h.svc.savedLists()).saved).toEqual([]);
    expect((await h.store.list()).map((p) => p.name)).toEqual(['Media']); // stored, listed nowhere
    h.f.addTab(tab(6, 'https://spotify.example/'));
    expect(await h.svc.create(MANUAL, 'Media', [6])).toBe(`${MANUAL}:media`);
    expect((await h.store.list()).map((p) => [p.name, p.keep, p.manual.map((m) => m.url)])).toEqual([['Media', true, ['https://spotify.example/']]]);
    await h.r.flush();
    expect((await h.svc.cards()).map((c) => c.title)).toEqual(['Media']);
  });

  it('a hidden tombstone of the same name (Close group, not kept) is replaced too; its undo then revives nothing', async () => {
    const h = harness();
    await h.store.put({ id: `${MANUAL}:old`, recipeId: MANUAL, key: 'old', name: 'Old', createdAt: 1, updatedAt: 1, manual: [{ url: 'https://old.example/', windowId: 1, tabId: 9 }], excluded: [], linked: [], closedAt: 2, closedIds: ['rc'] });
    expect(await h.svc.create(MANUAL, 'Old')).toBe(`${MANUAL}:old`);
    await h.svc.onUndo('rc');
    expect((await h.store.list()).map((p) => [p.id, p.name, p.keep, p.manual, p.closedAt])).toEqual([[`${MANUAL}:old`, 'Old', true, [], undefined]]);
  });

  it('keys match the rule id pattern (R38): accents dropped, other characters folded to -, at most 64 characters', async () => {
    const h = harness();
    const keyOf = async (name: string) => (await h.svc.create(MANUAL, name)).slice(MANUAL.length + 1);
    const R38 = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    expect(await keyOf('  Café Déjà-vu / Q3 ')).toBe('cafe-deja-vu-q3');
    expect(await keyOf('税金')).toBe('project');
    expect(await keyOf('税金!')).toBe('project-2');
    const long = await keyOf('a'.repeat(80));
    expect(long).toBe('a'.repeat(64));
    const long2 = await keyOf(`${'a'.repeat(80)}b`);
    expect(long2).toBe(`${'a'.repeat(62)}-2`);
    for (const p of await h.store.list()) expect(p.key).toMatch(R38);
  });

  it('a stored project of the same key, closed or not, takes its key', async () => {
    const h = harness();
    await h.store.put({ id: `${MANUAL}:taxes`, recipeId: MANUAL, key: 'taxes', createdAt: 1, updatedAt: 1, manual: [], excluded: [], linked: [], closedAt: 2, closedIds: ['rc'] });
    expect(await h.svc.create(MANUAL, 'Taxes')).toBe(`${MANUAL}:taxes-2`);
  });

  it('without tabs it stores the project only; an unknown tab or a blank name stores nothing', async () => {
    const h = harness();
    await h.svc.create(MANUAL, 'Empty');
    expect((await h.store.list()).map((p) => [p.key, p.manual])).toEqual([['empty', []]]);
    await expect(h.svc.create(MANUAL, 'Gone', [99])).rejects.toThrow('tab not found');
    await expect(h.svc.create(MANUAL, '   ')).rejects.toThrow('a project needs a name');
    expect((await h.store.list()).map((p) => p.key)).toEqual(['empty']);
  });

  it('several tabs join, each out of its previous project', async () => {
    const h = harness();
    h.f.addTab(tab(1, 'https://a.example/'));
    h.f.addTab(tab(2, 'https://b.example/'));
    const first = await h.svc.create(MANUAL, 'First', [1, 2]);
    const second = await h.svc.create(MANUAL, 'Second', [2]);
    const byId = new Map((await h.store.list()).map((p) => [p.id, p.manual.map((m) => m.tabId)]));
    expect(byId.get(first)).toEqual([1]);
    expect(byId.get(second)).toEqual([2]);
  });

  it('a recipe that starts by itself, or one that is off, creates nothing', async () => {
    const h = harness(program({ repo: repo('auto') }));
    await expect(h.svc.create('repo', 'Mine')).rejects.toThrow('this project starts by itself');
    const off = harness(program({ over: { recipes: defaultConfig().recipes.map((r) => (r.id === MANUAL ? { ...r, enabled: false } : r)) } }));
    await expect(off.svc.create(MANUAL, 'Mine')).rejects.toThrow('turn on the recipe Manual projects first');
    expect(await h.store.list()).toEqual([]);
    expect(await off.store.list()).toEqual([]);
  });

  it('global dry run: a user-initiated create still stores the project (R50), but no tab is grouped', async () => {
    const h = harness(program({ over: { dryRun: true } }));
    h.f.addTab(tab(5, 'https://irs.example/forms'));
    const id = await h.svc.create(MANUAL, 'Tax 2026', [5]);
    expect((await h.store.list()).map((p) => p.id)).toEqual([id]);
    await h.r.flush();
    expect(h.f.state.groups).toEqual([]);
  });
});

describe('ProjectService.start (on-request projects)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('stores the project of an on-request recipe under its key, once; its rule tabs then join it', async () => {
    const h = harness(program({ repo: repo('on-request') }));
    h.f.addTab(tab(1, 'https://github.com/acme/web/pull/3'));
    await h.r.flush();
    expect(await h.store.list()).toEqual([]); // assignProject does not create: nothing starts by itself
    expect(await h.svc.start('repo', 'acme/web')).toBe('repo:acme/web');
    expect(await h.svc.start('repo', 'acme/web')).toBe('repo:acme/web');
    expect(await h.store.list()).toEqual([{ id: 'repo:acme/web', recipeId: 'repo', key: 'acme/web', createdAt: NOW, updatedAt: NOW, manual: [], excluded: [], linked: [] }]);
    await h.r.flush();
    expect(h.groupOf(1)?.title).toBe('acme/web');
  });

  it('a closed (tombstoned) project is revived rather than replaced', async () => {
    const h = harness(program({ repo: repo('on-request') }));
    await h.store.put({ id: 'repo:acme/web', recipeId: 'repo', key: 'acme/web', createdAt: 1, updatedAt: 1, manual: [], excluded: ['x'], linked: [], closedAt: 2, closedIds: ['rc'] });
    expect(await h.svc.start('repo', 'acme/web')).toBe('repo:acme/web');
    expect(await h.store.list()).toEqual([{ id: 'repo:acme/web', recipeId: 'repo', key: 'acme/web', createdAt: 1, updatedAt: NOW, manual: [], excluded: ['x'], linked: [] }]);
  });

  it("start on a recipe with start: 'auto' throws this project starts by itself; a blank key or an unknown recipe throws too", async () => {
    const h = harness(program({ repo: repo('auto') }));
    await expect(h.svc.start('repo', 'acme/web')).rejects.toThrow('this project starts by itself');
    await expect(h.svc.start(MANUAL, ' ')).rejects.toThrow('a project needs a key');
    await expect(h.svc.start('nope', 'x')).rejects.toThrow('turn on the recipe nope first');
    expect(await h.store.list()).toEqual([]);
  });
});
