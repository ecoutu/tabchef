// Backups (Options → Backups): the stored projects go into the exported file (ProjectService.exportProjects) and come
// back by merge (importProjects): new ids are added, a stored id is overwritten only when the user named it, nothing
// stored is deleted, malformed projects are dropped and reported, and every imported project is kept (so a project
// with no open tab shows under Saved, or Archived).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { PROJECTS_KEY, ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Program } from '../../src/core/lang/types';
import type { Project } from '../../src/core/projects/types';

const NOW = 1_800_000_000_000;
const MANUAL = 'manual-project';

function program(): Program {
  const { program: p, errors } = compileProgram(defaultConfig(), builtinRecipes());
  expect(errors).toEqual([]);
  return p;
}
const memoryArea = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))]))),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); }),
  };
};

function harness(stored: Project[] = []) {
  const p = program();
  const f = new FakeBrowserPort();
  f.addWindow(1, { focused: true });
  const local = memoryArea();
  local.data.set(PROJECTS_KEY, structuredClone(stored));
  const store = new ProjectStore(local);
  const schedule = vi.fn();
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p,
    sources: { factsFor: () => undefined, issues: async () => new Map(), linkedFor: async () => new Map(), jiraSite: async () => undefined },
    facts: { get: () => undefined }, log: { add: () => {} }, recentlyClosed: { add: () => 'rc' },
    safety: { isProtected: (t) => t.pinned }, state: () => r.liveState(), schedule, now: () => NOW,
  });
  r = new Reconciler(f, async () => p, { projects: svc, now: () => NOW, log: { add: () => {} } });
  const raw = () => local.data.get(PROJECTS_KEY) as Project[];
  return { svc, store, local, schedule, raw };
}

const proj = (key: string, o: Partial<Project> = {}): Project => ({
  id: `${MANUAL}:${key}`, recipeId: MANUAL, key, name: key, createdAt: 100, updatedAt: 200, manual: [], excluded: [], linked: [], ...o,
});

describe('ProjectService.exportProjects', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('exports every stored project with what restoring it needs: saved tab list, name, color, archive, links', async () => {
    const taxes = proj('taxes', {
      keep: true, color: 'green', saved: { tabs: [{ url: 'https://a.example/', title: 'A', group: 'G', pinned: true }], at: 150, closed: true },
      excluded: ['b.example/'], linked: [{ url: 'https://github.com/a/b/pull/1', title: 'PR', state: 'open' }],
      manual: [{ url: 'https://a.example/', windowId: 4, tabId: 9 }], syncExtra: { future: 1 },
    });
    const old = proj('old', { keep: true, archivedAt: 300 });
    const h = harness([taxes, old]);
    const out = await h.svc.exportProjects();
    expect(out.map((p) => p.id)).toEqual([taxes.id, old.id]);
    expect(out[0]).toEqual({ ...taxes, manual: [{ url: 'https://a.example/', windowId: 4 }] });
    expect(out[1]).toEqual(old);
  });

  it('leaves out device-local state: live tab ids, the closed-time clock, the Close group tombstone and its undo entries', async () => {
    const kept = proj('kept', { keep: true, closedAt: 5, closedIds: ['rc1'], closedFor: 1000 });
    const open = proj('open', { keep: undefined, closedFor: 50 });
    const h = harness([kept, open]);
    const out = await h.svc.exportProjects();
    for (const p of out) {
      expect(p).not.toHaveProperty('closedAt');
      expect(p).not.toHaveProperty('closedIds');
      expect(p).not.toHaveProperty('closedFor');
    }
    expect(out.map((p) => p.id)).toEqual([kept.id, open.id]);
  });

  it('leaves out a project closed by Close group that was never kept (a tombstone waiting for undo or pruning)', async () => {
    const h = harness([proj('gone', { closedAt: 5, closedIds: ['rc1'] }), proj('kept', { keep: true })]);
    expect((await h.svc.exportProjects()).map((p) => p.key)).toEqual(['kept']);
  });
});

describe('ProjectService.importProjects', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('adds projects whose id is not stored, kept and with updatedAt now; never deletes a stored project', async () => {
    const mine = proj('mine', { keep: true });
    const h = harness([mine]);
    const r = await h.svc.importProjects([proj('new', { keep: undefined })], { overwrite: [] });
    expect(r).toEqual({ added: [{ id: `${MANUAL}:new`, title: 'new' }], overwritten: [], skipped: [], dropped: [] });
    const stored = await h.store.list();
    expect(stored.map((p) => p.id).sort()).toEqual([`${MANUAL}:mine`, `${MANUAL}:new`]);
    expect(stored.find((p) => p.key === 'new')).toMatchObject({ keep: true, updatedAt: NOW, createdAt: 100 });
    expect(h.schedule).toHaveBeenCalledWith('project');
  });

  it('skips a stored id unless the user named it to overwrite, and reports it by name', async () => {
    const mine = proj('taxes', { name: 'My taxes', keep: true, saved: { tabs: [{ url: 'https://mine.example/', title: 'M' }], at: 1 } });
    const theirs = proj('taxes', { name: 'Their taxes', saved: { tabs: [{ url: 'https://theirs.example/', title: 'T' }], at: 2 } });
    const h = harness([mine]);
    const skip = await h.svc.importProjects([theirs], { overwrite: [] });
    expect(skip).toEqual({ added: [], overwritten: [], skipped: [{ id: mine.id, title: 'My taxes' }], dropped: [] });
    expect(await h.store.list()).toEqual([mine]);
    const over = await h.svc.importProjects([theirs], { overwrite: [mine.id] });
    expect(over).toEqual({ added: [], overwritten: [{ id: mine.id, title: 'My taxes' }], skipped: [], dropped: [] });
    expect(await h.store.list()).toEqual([{ ...theirs, keep: true, updatedAt: NOW }]);
  });

  it('dryRun reports the same outcome and writes nothing', async () => {
    const h = harness([proj('a', { keep: true })]);
    const r = await h.svc.importProjects([proj('a'), proj('b'), { id: 'bad' }], { overwrite: [], dryRun: true });
    expect(r).toEqual({ added: [{ id: `${MANUAL}:b`, title: 'b' }], overwritten: [], skipped: [{ id: `${MANUAL}:a`, title: 'a' }], dropped: ['bad'] });
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('drops and reports malformed projects (by name, else id, else position); the rest import', async () => {
    const h = harness();
    const r = await h.svc.importProjects([
      { id: 'x:1' },
      proj('ok'),
      'nope',
      { ...proj('badManual'), name: 'Bad manual', manual: [{ url: 3 }] },
      { ...proj('badExcluded'), excluded: [1] },
      { ...proj('badLinked'), linked: [{ url: 'u' }] },
      { ...proj('noCreated'), createdAt: 'x' },
      { ...proj('badName'), name: 5 },
    ], { overwrite: [] });
    expect(r.added.map((p) => p.title)).toEqual(['ok']);
    expect(r.dropped).toEqual(['x:1', '#3', 'Bad manual', 'badExcluded', 'badLinked', 'noCreated', `${MANUAL}:badName`]);
    expect((await h.store.list()).map((p) => p.key)).toEqual(['ok']);
  });

  it('drops a malformed optional field but keeps the project (as the store reads one)', async () => {
    const h = harness();
    await h.svc.importProjects([{ ...proj('a'), saved: { tabs: 'x', at: 1 }, archivedAt: 'soon' }], { overwrite: [] });
    const [p] = await h.store.list();
    expect(p).not.toHaveProperty('saved');
    expect(p).not.toHaveProperty('archivedAt');
  });

  it('a second copy of the same id in the file is dropped', async () => {
    const h = harness();
    const r = await h.svc.importProjects([proj('a', { name: 'First' }), proj('a', { name: 'Second' })], { overwrite: [] });
    expect(r.added).toEqual([{ id: `${MANUAL}:a`, title: 'First' }]);
    expect(r.dropped).toEqual(['Second']);
  });

  it('strips device-local state from imported projects (a hand-edited or older file)', async () => {
    const h = harness();
    await h.svc.importProjects([proj('a', { closedAt: 5, closedIds: ['rc1'], closedFor: 9, manual: [{ url: 'https://a.example/', windowId: 1, tabId: 7 }] })], { overwrite: [] });
    expect(await h.store.list()).toEqual([proj('a', { keep: true, updatedAt: NOW, manual: [{ url: 'https://a.example/', windowId: 1 }] })]);
  });

  it('an imported project that was not kept shows under Saved; an archived one under Archived', async () => {
    const h = harness();
    await h.svc.importProjects([
      proj('open', { saved: { tabs: [{ url: 'https://a.example/', title: 'A' }], at: 1 } }),
      proj('old', { archivedAt: 50 }),
    ], { overwrite: [] });
    const lists = await h.svc.savedLists();
    expect(lists.saved.map((s) => [s.title, s.savedCount])).toEqual([['open', 1]]);
    expect(lists.archived.map((s) => s.title)).toEqual(['old']);
  });

  it('an export imports back unchanged except kept and updatedAt', async () => {
    const a = proj('a', { keep: true, saved: { tabs: [{ url: 'https://a.example/', title: 'A' }], at: 1 } });
    const src = harness([a]);
    const file = JSON.parse(JSON.stringify(await src.svc.exportProjects())) as unknown[];
    const dst = harness();
    await dst.svc.importProjects(file, { overwrite: [] });
    expect(await dst.store.list()).toEqual([{ ...a, updatedAt: NOW }]);
  });
});
