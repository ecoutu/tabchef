// #195: the done projects the popup's Finished view lists (ProjectService.doneProjects) and Keep on a Done prompt
// (keepDone), which dismisses the prompt on the card and the Finished row alike.
import { describe, expect, it, vi } from 'vitest';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { ProjectService, ProjectStore } from '../../src/engine/projects';
import { DONE_PROJECTS_KEY } from '../../src/engine/done-projects';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { buildProjectCards } from '../../src/ui/projects-model';
import { builtinRecipes } from '../../src/recipes/load';
import type { TabSnap } from '../../src/core/types';
import type { JiraIssue, PrInfo, SourceEntry } from '../../src/core/sources/types';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const RID = 'jira-ticket-title';
const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const PR = 'https://github.com/acme/api/pull/5';
const ID = `${RID}:ABC-1`;

const tab = (tid: number, url: string, title: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id: tid, windowId: 1, index: tid, url, title, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const issue = (category: 'done' | 'indeterminate' = 'done', o: Partial<SourceEntry<JiraIssue>> = {}): SourceEntry<JiraIssue> => ({
  data: { key: 'ABC-1', summary: 'Login fails', status: category === 'done' ? 'Done' : 'In Progress', statusCategory: category, url: TICKET },
  via: 'api', fetchedAt: NOW, final: false, stale: false, ...o,
});

function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))])),
    set: async (items: Record<string, unknown>) => { for (const [k, x] of Object.entries(items)) data.set(k, structuredClone(x)); },
  };
}

function harness(o: { session?: Map<string, unknown> } = {}) {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  const cfg = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === RID ? { ...r, enabled: true } : r)) };
  const p = compileProgram(cfg, builtinRecipes()).program;
  const local = area();
  const sessionData = o.session ?? new Map<string, unknown>();
  const session = {
    get: async (k: string) => structuredClone(sessionData.get(k)),
    set: async (k: string, v: unknown) => { sessionData.set(k, structuredClone(v)); },
  };
  const sources = {
    factsFor: vi.fn(() => undefined),
    issues: vi.fn<(ks: string[]) => Promise<Map<string, SourceEntry<JiraIssue>>>>(async () => new Map()),
    linkedFor: vi.fn<(ks: string[], orgs: string[]) => Promise<Map<string, PrInfo[]>>>(async () => new Map()),
    jiraSite: vi.fn<() => Promise<string | undefined>>(async () => 'acme.atlassian.net'),
    githubIssues: vi.fn(async () => new Map()),
  };
  const store = new ProjectStore(local);
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port, getProgram: async () => p, sources, facts: { get: () => undefined }, log: { add: () => {} },
    recentlyClosed: { add: () => 'rc' }, safety: { isProtected: () => false }, state: () => r.liveState(), now: () => NOW, session,
  });
  r = new Reconciler(port, async () => p, { projects: svc, now: () => NOW, log: { add: () => {} } });
  return { port, svc, r, sources, store, sessionData };
}

async function openDone(h: ReturnType<typeof harness>) {
  h.port.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
  h.port.addTab(tab(2, PR, 'ABC-1 fix'));
  await h.r.flush();
  h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue()]]));
  return h.svc.cards();
}

describe('#195: ProjectService.doneProjects (the Finished view) and keepDone', () => {
  it('a listing records each project Done by fresh data: title, summary, status and tab count, in storage.session', async () => {
    const h = harness();
    await openDone(h);
    const done = await h.svc.doneProjects();
    expect(done).toEqual([{
      id: ID, key: 'ABC-1', title: expect.stringContaining('ABC-1'), summary: 'Login fails',
      status: { name: 'Done', category: 'done', via: 'api' }, tabCount: 2,
    }]);
    expect(h.sessionData.get(DONE_PROJECTS_KEY)).toMatchObject({ projects: done, kept: [] });
  });

  it('#157: a saved project (keep) is listed with keep, so its Finished row\'s Keep says what the card\'s does', async () => {
    const h = harness();
    await openDone(h);
    expect((await h.svc.doneProjects())[0]).not.toHaveProperty('keep');
    await h.svc.setKeep(ID, true);
    await h.svc.cards();
    expect(await h.svc.doneProjects()).toEqual([expect.objectContaining({ id: ID, keep: true })]);
  });

  it('a stale Done is not listed (M3-R90), and a project not done leaves the list at the next listing', async () => {
    const h = harness();
    h.port.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue('done', { stale: true, error: 'network' })]]));
    await h.svc.cards();
    expect(await h.svc.doneProjects()).toEqual([]);
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue()]]));
    await h.svc.cards();
    expect(await h.svc.doneProjects()).toHaveLength(1);
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue('indeterminate')]]));
    await h.svc.cards();
    expect(await h.svc.doneProjects()).toEqual([]);
  });

  it('keepDone keeps the project and dismisses its prompt everywhere: off the Finished list, and the card no longer prompts', async () => {
    const h = harness();
    await openDone(h);
    await h.svc.keepDone(ID);
    expect((await h.store.list()).find((p) => p.id === ID)?.keep).toBe(true);
    expect(await h.svc.doneProjects()).toEqual([]);
    const cards = await h.svc.cards();
    expect(cards[0]).toMatchObject({ done: true, doneKept: true });
    expect(buildProjectCards(cards)[0]!.showClose).toBe(false);
    expect(await h.svc.doneProjects()).toEqual([]); // a later listing does not bring it back
  });

  it('a kept Done prompt comes back once the ticket was reopened and is done again', async () => {
    const h = harness();
    await openDone(h);
    await h.svc.keepDone(ID);
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue('indeterminate')]]));
    expect((await h.svc.cards())[0]).not.toHaveProperty('doneKept');
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue()]]));
    expect((await h.svc.cards())[0]).not.toHaveProperty('doneKept');
    expect(await h.svc.doneProjects()).toHaveLength(1);
  });

  it('keepDone of an unknown project fails', async () => {
    const h = harness();
    await expect(h.svc.keepDone('nope')).rejects.toThrow('unknown project');
  });

  it('Close group and Close and archive take the project off the list at once', async () => {
    for (const close of ['closeGroup', 'closeAndArchive'] as const) {
      const h = harness();
      await openDone(h);
      await h.svc[close](ID);
      expect(await h.svc.doneProjects()).toEqual([]);
    }
  });

  it('a listing already running when Close group drops the project does not list it again (R5-M1)', async () => {
    const h = harness();
    await openDone(h);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    h.sources.issues.mockImplementation(async () => { await gate; return new Map([['ABC-1', issue()]]); });
    const before = h.sources.issues.mock.calls.length;
    const listing = h.svc.cards();
    await vi.waitFor(() => expect(h.sources.issues.mock.calls.length).toBeGreaterThan(before));
    await h.svc.closeGroup(ID);
    await h.r.flush();
    expect(await h.svc.doneProjects()).toEqual([]);
    release();
    await listing;
    expect(await h.svc.doneProjects()).toEqual([]);
  });

  it('a project whose tabs were closed by hand leaves the list at the next pass', async () => {
    const h = harness();
    await openDone(h);
    await h.port.closeTab(1);
    await h.port.closeTab(2);
    await h.r.flush();
    expect(await h.svc.doneProjects()).toEqual([]);
  });

  it('a new worker reads the list and the kept prompts from storage.session', async () => {
    const h = harness();
    await openDone(h);
    const session = h.sessionData;
    const fresh = harness({ session });
    expect(await fresh.svc.doneProjects()).toHaveLength(1);
    await h.svc.keepDone(ID);
    const after = harness({ session });
    expect(await after.svc.doneProjects()).toEqual([]);
  });
});
