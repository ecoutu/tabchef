import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { CLOSED_CLOCK_KEY, LINKED_REFRESH_MS, PROJECTS_KEY, PRUNE_AFTER_MS, ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { toLive, toRuntime } from '../../src/engine/state';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Program, Recipe } from '../../src/core/lang/types';
import type { Project } from '../../src/core/projects/types';
import type { GithubIssueInfo, JiraIssue, PrInfo, SourceEntry } from '../../src/core/sources/types';
import type { Config, TabSnap } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;
const RID = 'jira-ticket-title';
const PID = `${RID}:ABC-1`;
const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const PR = 'https://github.com/acme/api/pull/5';
const PR2 = 'https://github.com/acme/web/pull/9';

const recipe: Recipe = {
  recipe: RID, version: 1, name: 'Jira ticket (title)', description: 'x',
  params: {
    githubOrgs: { type: 'string[]', default: [], label: 'orgs' },
    projectPrefixes: { type: 'string[]', default: [], label: 'prefixes' },
  },
  project: { key: '{key}', title: '{key}', color: 'blue', container: 'group', join: ['rules', 'manual'] },
  rules: [
    {
      id: 'ticket', name: 'Jira ticket (title)', enabled: true, match: { url: '*.atlassian.net/browse/*' },
      extract: { key: { from: 'url', jiraKey: {} } },
      actions: [{ assignProject: { key: '{key}', create: true } }],
    },
    {
      id: 'pr', name: 'PR title', enabled: true, match: { url: 'github.com/:owner/:repo/pull/*' },
      extract: { key: { from: 'title', jiraKey: {} } },
      actions: [{ assignProject: { key: '{key}' } }],
    },
  ],
};
function program(params: Record<string, unknown> = {}): Program {
  const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params, source: 'builtin' }] };
  const { program: p, errors } = compileProgram(c, { [RID]: recipe });
  expect(errors).toEqual([]);
  return p;
}
const tab = (id: number, url: string, title: string, o: Partial<TabSnap> = {}) => ({
  id, windowId: 1, url, title, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const memoryArea = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))]))),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); }),
  };
};
const stored = (o: Partial<Project> = {}): Project => ({ id: PID, recipeId: RID, key: 'ABC-1', createdAt: NOW, updatedAt: NOW, manual: [], excluded: [], linked: [], ...o });

type Session = { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
const memorySession = (): Session & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>();
  return { data, get: async (k) => structuredClone(data.get(k)), set: async (k, v) => { data.set(k, structuredClone(v)); } };
};

function harness(o: {
  program?: Program; local?: ReturnType<typeof memoryArea>; port?: FakeBrowserPort; session?: Session;
  onProjectsChanged?: (ps: { id: string; title: string }[]) => void;
} = {}) {
  const f = o.port ?? (() => { const p = new FakeBrowserPort(); p.addWindow(1, { focused: true }); return p; })();
  const local = o.local ?? memoryArea();
  const p = o.program ?? program();
  const logs: { tabId?: number; action: string; detail: string }[] = [];
  const closed: { url: string; reason: string; windowId: number; title: string }[] = [];
  const locked = new Set<number>();
  const clock = { now: NOW };
  type Facts = Record<string, SourceEntry<Record<string, unknown>>> | undefined;
  const sources = {
    factsFor: vi.fn<(id: number, url?: string) => Facts>(() => undefined),
    issues: vi.fn<(keys: string[]) => Promise<Map<string, SourceEntry<JiraIssue>>>>(async () => new Map()),
    linkedFor: vi.fn<(keys: string[], orgs: string[]) => Promise<Map<string, PrInfo[]>>>(async () => new Map()),
    jiraSite: vi.fn<() => Promise<string | undefined>>(async () => 'acme.atlassian.net'),
    githubIssues: vi.fn<(keys: string[]) => Promise<Map<string, SourceEntry<GithubIssueInfo>>>>(async () => new Map()),
  };
  const schedule = vi.fn();
  const toast = vi.fn();
  const store = new ProjectStore(local);
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p, sources, facts: { get: () => undefined }, log: { add: (e) => logs.push(e) },
    recentlyClosed: { add: (e) => { closed.push(e); return `rc${closed.length}`; } },
    safety: { isProtected: (t) => t.pinned || locked.has(t.id) },
    state: () => r.liveState(), schedule, toast, now: () => clock.now, ...(o.onProjectsChanged && { onProjectsChanged: o.onProjectsChanged }),
    ...(o.session && { session: o.session }),
  });
  r = new Reconciler(f, async () => p, { projects: svc, now: () => clock.now, log: { add: (e) => logs.push(e) } });
  const groupOf = (id: number) => f.state.groups.find((g) => g.id === f.state.tabs.find((t) => t.id === id)?.groupId)?.title;
  return { f, local, logs, closed, locked, clock, sources, schedule, toast, store, svc, r, groupOf };
}

describe('ProjectService.targets and the reconciler', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('a ticket + PR pair map to the same title; through the reconciler they form one group ABC-1 in that window', async () => {
    const h = harness();
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    const t = await h.svc.targets(await h.f.snapshot());
    expect(t.get(1)?.title).toBe('ABC-1');
    expect(t.get(2)?.title).toBe('ABC-1');
    await h.r.flush();
    expect(h.f.state.groups.map((g) => [g.windowId, g.title])).toEqual([[1, 'ABC-1']]);
    expect(h.groupOf(1)).toBe('ABC-1');
    expect(h.groupOf(2)).toBe('ABC-1');
    expect((await h.store.list()).map((p) => p.id)).toEqual([PID]);
    expect(h.logs.filter((l) => l.action === 'project-join').map((l) => [l.tabId, l.detail])).toEqual([
      [1, 'Joined ABC-1 by rule Jira ticket (title)'], [2, 'Joined ABC-1 by rule PR title'],
    ]);
  });

  it('each pass reports the open projects (id and group title) for the context menu', async () => {
    const seen: { id: string; title: string }[][] = [];
    const h = harness({ onProjectsChanged: (ps) => seen.push(ps) });
    await h.svc.targets(await h.f.snapshot());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.svc.targets(await h.f.snapshot());
    expect(seen).toEqual([[], [{ id: PID, title: 'ABC-1' }]]);
  });

  it('a disabled project recipe (no defs) gives no targets and no open projects', async () => {
    const seen: unknown[] = [];
    const h = harness({ program: { ...program(), projects: [] }, onProjectsChanged: (ps) => seen.push(ps) });
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    expect((await h.svc.targets(await h.f.snapshot())).size).toBe(0);
    expect(seen).toEqual([[]]);
  });

  it('sticky membership is persisted in RuntimeState.projectTabs with the assigning rule', async () => {
    const h = harness();
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    await h.r.flush();
    const rt = toRuntime(await h.r.liveState());
    expect(rt.projectTabs).toContainEqual({ tabId: 2, projectId: PID, url: PR, ruleKey: `${RID}/pr`, index: 1, sig: expect.any(String) });
    expect(toLive(rt).projectTabs.get(2)).toEqual({ projectId: PID, url: PR, ruleKey: `${RID}/pr`, index: 1, sig: expect.any(String) });
    expect(toLive(undefined).projectTabs.size).toBe(0);
    // While the PR reloads (its title lost the key), it stays in the group.
    h.f.state.tabs.find((t) => t.id === 2)!.title = 'github.com/acme/api/pull/5';
    await h.r.flush();
    expect(h.groupOf(2)).toBe('ABC-1');
  });
});

describe('ProjectService actions', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  async function withPair(o: Partial<Project> = {}) {
    const h = harness();
    await h.store.put(stored(o));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    await h.r.flush();
    return h;
  }

  it('openLinked opens the PR inactive in the project window; after the reconcile it is in the group while its title is empty', async () => {
    const h = await withPair({ linked: [{ url: PR2, title: 'ABC-1 web', state: 'merged' }] });
    const id = await h.svc.openLinked(PID, PR2);
    expect(h.f.calls.find((c) => c.method === 'createTab')?.args).toEqual([{ url: PR2, active: false, windowId: 1 }]);
    h.f.state.tabs.find((t) => t.id === id)!.title = '';
    await h.r.flush();
    expect(h.groupOf(id)).toBe('ABC-1');
    expect((await h.store.list())[0]!.manual).toEqual([{ url: PR2, windowId: 1, tabId: id }]);
    expect(h.logs).toContainEqual(expect.objectContaining({ tabId: id, action: 'project-join', detail: 'Joined ABC-1 manually' }));
    expect(h.schedule).toHaveBeenCalled();
  });

  it('openLinked rejects a URL that is not one of the project\'s linked PRs', async () => {
    const h = await withPair({ linked: [{ url: PR2, title: 'ABC-1 web', state: 'merged' }] });
    await expect(h.svc.openLinked(PID, 'https://evil.example/')).rejects.toThrow(/not a linked PR/);
    await expect(h.svc.openLinked('nope', PR2)).rejects.toThrow(/unknown project/);
    expect(h.f.calls.some((c) => c.method === 'createTab')).toBe(false);
  });

  it('addTab adds a tab to the project manually (wins over rules) and clears its exclusion', async () => {
    const h = await withPair({ excluded: ['https://example.com/notes'] });
    h.f.addTab(tab(3, 'https://example.com/notes', 'Notes'));
    await h.svc.addTab(3, PID);
    await h.r.flush();
    expect(h.groupOf(3)).toBe('ABC-1');
    const p = (await h.store.list())[0]!;
    expect(p.excluded).toEqual([]);
    expect(p.manual).toEqual([{ url: 'https://example.com/notes', windowId: 1, tabId: 3 }]);
    await expect(h.svc.addTab(99, PID)).rejects.toThrow(/tab not found/);
  });

  it('removeTab ungroups the tab and keeps it out across reconciles until it navigates', async () => {
    const h = await withPair();
    expect(h.groupOf(2)).toBe('ABC-1');
    await h.svc.removeTab(2);
    await h.r.flush();
    expect(h.groupOf(2)).toBeUndefined();
    expect((await h.store.list())[0]!.excluded).toEqual([PR]);
    await h.r.flush();
    await h.r.flush();
    expect(h.groupOf(2)).toBeUndefined();
    expect(h.groupOf(1)).toBe('ABC-1');
    const t = h.f.state.tabs.find((x) => x.id === 2)!;
    t.url = 'https://github.com/acme/api/pull/6';
    await h.r.flush();
    expect(h.groupOf(2)).toBe('ABC-1');
  });

  it('removeTab also drops a manual membership', async () => {
    const h = await withPair();
    h.f.addTab(tab(3, 'https://example.com/notes', 'Notes'));
    await h.svc.addTab(3, PID);
    await h.r.flush();
    await h.svc.removeTab(3);
    await h.r.flush();
    expect(h.groupOf(3)).toBeUndefined();
    expect((await h.store.list())[0]!.manual).toEqual([]);
  });

  it('closeGroup closes the project\'s tabs but a locked one: {closed: n-1, skipped: 1}, closed ones in recently closed', async () => {
    const h = await withPair();
    h.f.addTab(tab(3, 'https://github.com/acme/api/pull/7', 'ABC-1 more'));
    await h.r.flush();
    h.locked.add(3);
    expect(await h.svc.closeGroup(PID)).toEqual({ closed: 2, skipped: 1, ids: ['rc1', 'rc2'] }); // ids: the popup's undo (T17)
    expect(h.f.state.tabs.map((t) => t.id)).toEqual([3]);
    expect(h.closed.map((c) => [c.url, c.reason, c.windowId])).toEqual([[TICKET, 'project-closed', 1], [PR, 'project-closed', 1]]);
    expect(h.closed[0]!.title).toBe('[ABC-1] Login fails - Jira');
    expect((await h.store.list()).map((p) => p.id)).toEqual([PID]); // a tab remains
  });

  it('closeGroup with nothing protected keeps the project as a tombstone that cards and the menu hide (M3-R84)', async () => {
    const seen: { id: string }[][] = [];
    const h = harness({ onProjectsChanged: (ps) => seen.push(ps) });
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    await h.r.flush();
    expect(await h.svc.closeGroup(PID)).toEqual({ closed: 2, skipped: 0, ids: ['rc1', 'rc2'] });
    expect(await h.store.list()).toEqual([expect.objectContaining({ id: PID, closedAt: NOW, closedIds: ['rc1', 'rc2'] })]);
    expect(await h.svc.cards()).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
    await expect(h.svc.addTab(1, PID)).rejects.toThrow(); // gone from the UI: no manual adds either
  });

  it('closeGroup also closes a second copy of a manually added page (same PR open twice): the project closes', async () => {
    const h = await withPair();
    h.f.addTab(tab(3, PR2, 'Saved carts page')); // no key in the title: it joins only by hand
    h.f.addTab(tab(4, PR2, 'Saved carts page'));
    await h.r.flush();
    await h.svc.addTab(3, PID);
    await h.r.flush();
    expect([1, 2, 3, 4].map(h.groupOf)).toEqual(['ABC-1', 'ABC-1', 'ABC-1', 'ABC-1']);
    expect(await h.svc.closeGroup(PID)).toEqual({ closed: 4, skipped: 0, ids: ['rc1', 'rc2', 'rc3', 'rc4'] });
    expect(h.f.state.tabs).toEqual([]);
    expect(await h.store.list()).toEqual([expect.objectContaining({ id: PID, closedAt: NOW })]);
  });

  it('closeGroup closes the active tab last and offers M1 undo for the whole group in the newly focused tab (M3-R84)', async () => {
    const h = harness();
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira', { active: true }));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    h.f.addTab(tab(3, 'https://example.com/', 'Other'));
    await h.r.flush();
    const order: number[] = [];
    const close = h.f.closeTab.bind(h.f);
    vi.spyOn(h.f, 'closeTab').mockImplementation(async (id: number) => {
      order.push(id);
      await close(id);
      if (id === 1) h.f.state.tabs.find((t) => t.id === 3)!.active = true; // Chrome activates a neighbour
    });
    await h.svc.closeGroup(PID);
    expect(order).toEqual([2, 1]);
    expect(h.toast).toHaveBeenCalledTimes(1);
    const [ids, text, focused] = h.toast.mock.calls[0]!;
    expect(ids).toEqual(['rc1', 'rc2']);
    expect(text).toBe('Closed 2 tabs with project ABC-1.');
    expect(focused).toMatchObject({ id: 3 });
  });

  it('undo after closeGroup restores the same project: manual tab back in it, linked and summary kept (M3-R84)', async () => {
    const h = await withPair({ summary: 'Login fails', linked: [{ url: PR2, title: 'ABC-1 web', state: 'merged' }] });
    h.f.addTab(tab(3, 'https://example.com/notes', 'Notes'));
    await h.svc.addTab(3, PID);
    await h.r.flush();
    const { ids } = await h.svc.closeGroup(PID);
    expect(ids).toHaveLength(3);
    await h.r.flush();
    // recent.undo / the banner: SafetyService calls beforeUndo for each entry before it recreates the tab.
    for (const id of ids) await h.svc.onUndo(id);
    h.f.addTab(tab(11, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(12, PR, 'ABC-1: fix login'));
    h.f.addTab(tab(13, 'https://example.com/notes', 'Notes'));
    await h.r.flush();
    expect([11, 12, 13].map(h.groupOf)).toEqual(['ABC-1', 'ABC-1', 'ABC-1']);
    const [p] = await h.store.list();
    expect(p).toMatchObject({ id: PID, summary: 'Login fails', linked: [{ url: PR2, title: 'ABC-1 web', state: 'merged' }] });
    expect(p).not.toHaveProperty('closedAt');
    expect(p!.manual.map((m) => m.url)).toEqual(['https://example.com/notes']);
    expect((await h.svc.cards()).map((c) => [c.id, c.tabs.length])).toEqual([[PID, 3]]);
  });

  it('a rule reopening a tombstoned key revives the stored project instead of overwriting it; a manual URL alone does not', async () => {
    const h = await withPair({ summary: 'Login fails' });
    h.f.addTab(tab(3, 'https://example.com/notes', 'Notes'));
    await h.svc.addTab(3, PID);
    await h.r.flush();
    await h.svc.closeGroup(PID);
    h.f.addTab(tab(13, 'https://example.com/notes', 'Notes'));
    await h.r.flush();
    expect(h.groupOf(13)).toBeUndefined(); // a tombstone's manual entries take no tab
    h.f.addTab(tab(11, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    const list = await h.store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: PID, summary: 'Login fails' });
    expect(list[0]).not.toHaveProperty('closedAt');
    expect(h.groupOf(11)).toBe('ABC-1');
  });

  it('a tombstone is pruned like any project without open tabs', async () => {
    const h = harness();
    await h.store.put(stored({ closedAt: NOW - 30 * DAY, closedIds: ['rc9'], closedFor: PRUNE_AFTER_MS }));
    h.f.addTab(tab(5, 'https://example.com/', 'x'));
    await h.r.flush();
    expect(await h.store.list()).toEqual([]);
  });

  it('Review Focus #4: onReplaced migrates manual and sticky membership; the replaced (discarded) tab stays in the group', async () => {
    const h = await withPair();
    h.f.addTab(tab(3, 'https://example.com/notes', 'Notes'));
    await h.svc.addTab(3, PID);
    await h.r.flush();
    // Chrome swaps in a discarded tab with a new id (same URL; a PR title without the key while it is discarded).
    for (const [from, to] of [[2, 20], [3, 30]] as const) {
      const t = h.f.state.tabs.find((x) => x.id === from)!;
      Object.assign(t, { id: to, discarded: true, ...(from === 2 && { title: 'github.com/acme/api/pull/5' }) });
      await h.svc.onReplaced(to, from);
    }
    const st = await h.r.liveState();
    expect(st.projectTabs.get(20)).toMatchObject({ projectId: PID, url: PR });
    expect(st.projectTabs.has(2)).toBe(false);
    expect((await h.store.list())[0]!.manual).toEqual([{ url: 'https://example.com/notes', windowId: 1, tabId: 30 }]);
    h.f.calls.length = 0;
    await h.r.flush();
    expect(h.groupOf(20)).toBe('ABC-1');
    expect(h.groupOf(30)).toBe('ABC-1');
    expect(h.f.calls.filter((c) => c.method === 'ungroup')).toEqual([]);
  });
});

describe('ProjectStore and pruning', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('the store persists in storage.local `projects` across a new ProjectService instance', async () => {
    const local = memoryArea();
    const a = harness({ local });
    a.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await a.r.flush();
    expect((local.data.get(PROJECTS_KEY) as Project[]).map((p) => p.id)).toEqual([PID]);
    const b = harness({ local, port: a.f });
    expect((await b.store.list()).map((p) => p.id)).toEqual([PID]);
    await b.store.remove(PID);
    expect(await new ProjectStore(local).list()).toEqual([]);
  });

  it('a project with an unreadable saved tab list, keep or archivedAt is read without that field, not dropped', async () => {
    const local = memoryArea();
    const good = { tabs: [{ url: 'https://a.test/', title: 'A', group: 'G', pinned: true }], at: NOW, closed: true };
    const bad = (id: string, o: Record<string, unknown>) => ({ ...stored({ id: `${RID}:${id}`, key: id }), ...o });
    local.data.set(PROJECTS_KEY, [
      bad('S1', { saved: 'tabs' }), bad('S2', { saved: { tabs: 'x', at: NOW } }), bad('S3', { saved: { tabs: [{ title: 'no url' }], at: NOW } }),
      bad('S4', { saved: { tabs: [], at: 'now' } }), bad('S5', { saved: { tabs: [], at: NOW, closed: 'yes' } }), bad('OK', { saved: good, keep: true, archivedAt: 5 }),
      bad('K1', { keep: 'yes', archivedAt: 'x' }), bad('K2', { archivedAt: Number.NaN }), { id: 'broken' },
    ]);
    const byKey = new Map((await new ProjectStore(local).list()).map((p) => [p.key, p]));
    expect([...byKey.keys()]).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'OK', 'K1', 'K2']);
    for (const k of ['S1', 'S2', 'S3', 'S4', 'S5']) expect(byKey.get(k)).not.toHaveProperty('saved');
    expect(byKey.get('OK')).toMatchObject({ saved: good, keep: true, archivedAt: 5 });
    for (const k of ['K1', 'K2']) expect(byKey.get(k)).not.toHaveProperty('keep');
    expect(byKey.get('K1')).not.toHaveProperty('archivedAt');
    expect(byKey.get('K2')).not.toHaveProperty('archivedAt');
    expect(local.set).not.toHaveBeenCalled();
  });

  it('an unreadable saved tab list stays stored as it was through a put without one, until a readable list replaces it or the project goes', async () => {
    const local = memoryArea();
    const raw = { tabs: 'broken', at: NOW };
    local.data.set(PROJECTS_KEY, [{ ...stored(), saved: raw }, stored({ id: `${RID}:B`, key: 'B', saved: raw as never })]);
    const disk = (id: string) => (local.data.get(PROJECTS_KEY) as Record<string, unknown>[]).find((p) => p.id === id);
    const s = new ProjectStore(local);
    const p = (await s.list()).find((x) => x.id === PID)!;
    expect(p).not.toHaveProperty('saved');
    await s.put({ ...p, name: 'Renamed' });
    expect(disk(PID)).toMatchObject({ name: 'Renamed', saved: raw });
    // A new store (the worker restarted) over the same storage: still read without it, still stored.
    const s2 = new ProjectStore(local);
    expect((await s2.list()).find((x) => x.id === PID)).toMatchObject({ name: 'Renamed' });
    expect((await s2.list()).find((x) => x.id === PID)).not.toHaveProperty('saved');
    await s2.put({ ...(await s2.list()).find((x) => x.id === PID)!, archivedAt: 5 });
    expect(disk(PID)).toMatchObject({ archivedAt: 5, saved: raw });
    const good = { tabs: [{ url: 'https://a.test/', title: 'A' }], at: NOW + 1 };
    await s2.put({ ...(await s2.list()).find((x) => x.id === PID)!, saved: good });
    expect(disk(PID)?.saved).toEqual(good);
    expect((await new ProjectStore(local).list()).find((x) => x.id === PID)?.saved).toEqual(good);
    await s2.remove(`${RID}:B`);
    expect(disk(`${RID}:B`)).toBeUndefined();
    await s2.put(stored({ id: `${RID}:B`, key: 'B' }));
    expect(disk(`${RID}:B`)).not.toHaveProperty('saved');
  });

  it('unreadableSaved: read from storage, so a put without a saved list and a new store (worker restart) keep it; a readable list clears it', async () => {
    const local = memoryArea();
    local.data.set(PROJECTS_KEY, [{ ...stored(), saved: { tabs: 'broken', at: NOW } }, stored({ id: `${RID}:B`, key: 'B' })]);
    const s = new ProjectStore(local);
    expect(await s.unreadableSaved()).toEqual(new Set([PID]));
    await s.put({ ...(await s.list()).find((x) => x.id === PID)!, name: 'Renamed' });
    expect(await s.unreadableSaved()).toEqual(new Set([PID]));
    const s2 = new ProjectStore(local);
    expect(await s2.unreadableSaved()).toEqual(new Set([PID]));
    await s2.put({ ...(await s2.list()).find((x) => x.id === PID)!, saved: { tabs: [], at: NOW + 1 } });
    expect(await s2.unreadableSaved()).toEqual(new Set());
    expect(await new ProjectStore(local).unreadableSaved()).toEqual(new Set());
  });

  it('a failed write changes nothing: the cached list, the unreadable saved lists and later writes stay in step with storage', async () => {
    const local = memoryArea();
    const raw = { tabs: 'broken', at: NOW };
    local.data.set(PROJECTS_KEY, [{ ...stored(), saved: raw }, stored({ id: `${RID}:B`, key: 'B' })]);
    const s = new ProjectStore(local);
    const before = await s.list();
    const disk = () => structuredClone(local.data.get(PROJECTS_KEY));
    const onDisk = disk();
    local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(s.put(stored({ id: `${RID}:C`, key: 'C' }))).rejects.toThrow(/quota/);
    local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(s.remove(PID)).rejects.toThrow(/quota/);
    local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await expect(s.put({ ...before[0]!, saved: { tabs: [], at: NOW + 1 } })).rejects.toThrow(/quota/);
    expect(await s.list()).toEqual(before);
    expect(await s.unreadableSaved()).toEqual(new Set([PID]));
    expect(disk()).toEqual(onDisk);
    // The next write stores only its own change, and the unreadable list stays as it was.
    await s.put({ ...before[1]!, name: 'B2' });
    expect((disk() as Project[]).map((p) => [p.id, p.name, p.saved])).toEqual([[PID, undefined, raw], [`${RID}:B`, 'B2', undefined]]);
  });

  it('M4-R22: syncExtra that is not a plain object is dropped; a plain object is kept', async () => {
    const local = memoryArea();
    const bad = (id: string, o: Record<string, unknown>) => ({ ...stored({ id: `${RID}:${id}`, key: id }), ...o });
    local.data.set(PROJECTS_KEY, [
      bad('E1', { syncExtra: { tint: 'x', n: [1] } }), bad('E2', { syncExtra: 'x' }), bad('E3', { syncExtra: [1] }), bad('E4', { syncExtra: null }),
    ]);
    const byKey = new Map((await new ProjectStore(local).list()).map((p) => [p.key, p]));
    expect(byKey.get('E1')?.syncExtra).toEqual({ tint: 'x', n: [1] });
    for (const k of ['E2', 'E3', 'E4']) expect(byKey.get(k)).not.toHaveProperty('syncExtra');
  });

  it('on startup, a project closed for 7 days of browser time is pruned; a younger one or one with open tabs is kept', async () => {
    const local = memoryArea();
    local.data.set(PROJECTS_KEY, [
      stored({ id: `${RID}:OLD-1`, key: 'OLD-1', createdAt: NOW - 30 * DAY, closedFor: PRUNE_AFTER_MS }),
      stored({ id: `${RID}:NEW-1`, key: 'NEW-1', createdAt: NOW - 30 * DAY, closedFor: PRUNE_AFTER_MS - DAY }),
      stored({ createdAt: NOW - 30 * DAY, closedFor: PRUNE_AFTER_MS + DAY }),
    ]);
    const h = harness({ local });
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    expect((await h.store.list()).map((p) => p.id).sort()).toEqual([PID, `${RID}:NEW-1`]);
    expect((await h.store.list()).find((p) => p.id === PID)!.closedFor).toBeUndefined(); // open again: reset
  });

  it('fix I1: a pass before session restore (no tabs) prunes nothing, and wall-clock age alone never prunes', async () => {
    const local = memoryArea();
    local.data.set(PROJECTS_KEY, [
      stored({ createdAt: NOW - 8 * DAY }), // the browser was closed for 8 days with ABC-1 open
      stored({ id: `${RID}:OLD-1`, key: 'OLD-1', createdAt: NOW - 30 * DAY, closedFor: PRUNE_AFTER_MS }),
    ]);
    const h = harness({ local });
    await h.r.flush(); // before restore: empty snapshot
    expect((await h.store.list()).map((p) => p.id).sort()).toEqual([PID, `${RID}:OLD-1`]);
    h.clock.now += 60_000;
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira')); // tabs restore
    await h.r.flush();
    // The first pass that sees tabs is the startup prune: ABC-1 is open, OLD-1 was closed for 7 days of browser time.
    expect((await h.store.list()).map((p) => p.id)).toEqual([PID]);
  });

  it('fix I1: closed time counts only between passes that see tabs, at most 15 min per gap, stored hourly', async () => {
    const local = memoryArea();
    local.data.set(PROJECTS_KEY, [stored({ id: `${RID}:ZZZ-9`, key: 'ZZZ-9' })]);
    const h = harness({ local });
    h.f.addTab(tab(1, 'https://example.com/', 'x'));
    await h.r.flush();
    h.clock.now += 10 * DAY; // the browser was not running (or the worker slept): one capped gap
    await h.r.flush();
    for (let i = 0; i < 4; i++) { h.clock.now += 15 * 60_000; await h.r.flush(); }
    expect((await h.store.list())[0]!.closedFor).toBe(60 * 60_000); // 75 min counted, the last 15 not stored yet
  });
});

describe('ProjectService: dry run (fix I2)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const compiled = (over: Partial<Config>, r: Recipe = recipe): Program => {
    const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }], ...over };
    const { program: p, errors } = compileProgram(c, { [RID]: r });
    expect(errors).toEqual([]);
    return p;
  };

  it('global dry run: nothing is grouped, no project is stored and no join is logged; the dry-run pass reports would-group', async () => {
    const h = harness({ program: compiled({ dryRun: true }, { ...recipe, rules: recipe.rules.map((x) => ({ ...x })) }) });
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    await h.r.flush();
    expect(h.f.state.groups).toEqual([]);
    expect(await h.store.list()).toEqual([]);
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.logs.filter((l) => l.action === 'project-join')).toEqual([]);
    expect(h.logs.filter((l) => l.action === 'would-group').map((l) => [l.tabId, l.detail])).toEqual([
      // One group op: the planner names the title's highest-priority rule for every tab joining it.
      [1, 'Would move to ABC-1 by rule Jira ticket (title) (dry run)'], [2, 'Would move to ABC-1 by rule Jira ticket (title) (dry run)'],
    ]);
  });

  it('a dry-run assignProject rule falls through (R48): its tab is not grouped live and no join is logged for it', async () => {
    const r: Recipe = { ...recipe, rules: recipe.rules.map((x) => (x.id === 'pr' ? { ...x, dryRun: true } : x)) };
    const p = compiled({}, r);
    const h = harness({ program: p });
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    expect([...(await h.svc.targets(await h.f.snapshot())).keys()]).toEqual([1]);
    expect([...(await h.svc.previewTargets(await h.f.snapshot(), p)).keys()].sort()).toEqual([1, 2]);
    await h.r.flush();
    expect(h.groupOf(1)).toBe('ABC-1');
    expect(h.groupOf(2)).toBeUndefined();
    expect(h.logs.filter((l) => l.action === 'project-join').map((l) => l.tabId)).toEqual([1]);
  });

  it('previewTargets builds a recreated tombstone from its stored record, as the live pass does (summary kept)', async () => {
    const r: Recipe = { ...recipe, project: { ...recipe.project!, title: '{key} · {summary}' } };
    const p = compiled({}, r);
    const h = harness({ program: p });
    await h.store.put(stored({ summary: 'Stored summary', closedAt: NOW, closedIds: ['rc1'] }));
    h.f.addTab(tab(1, TICKET, 'ABC-1'));
    const preview = (await h.svc.previewTargets(await h.f.snapshot(), p)).get(1)?.title;
    const live = (await h.svc.targets(await h.f.snapshot())).get(1)?.title;
    expect(live).toBe('ABC-1 · Stored summary');
    expect(preview).toBe(live);
  });

  it('previewTargets has no side effects', async () => {
    const h = harness();
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    const t = await h.svc.previewTargets(await h.f.snapshot(), program());
    expect(t.get(1)?.title).toBe('ABC-1');
    expect(h.local.set).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
    expect((await h.r.liveState()).projectTabs.size).toBe(0);
  });
});

describe('ProjectService.cards', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('title, status from SourceService.issues, PR pills from factsFor, linked PRs from linkedFor (at most every 15 min), done', async () => {
    const h = harness({ program: program({ githubOrgs: ['Extra'] }) });
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira', { favIconUrl: 'https://acme.atlassian.net/f.png', lastAccessed: 5 }));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    await h.r.flush();
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', {
      data: { key: 'ABC-1', summary: 'Login fails', status: 'Done', statusCategory: 'done', url: TICKET }, via: 'api', fetchedAt: NOW, final: false, stale: false,
    }]]));
    h.sources.factsFor.mockImplementation((id: number) => (id === 2 ? { [`${RID}/pr`]: { data: { state: 'open' }, via: 'api', fetchedAt: NOW, final: false, stale: true } } : undefined));
    const merged: PrInfo = { owner: 'acme', repo: 'web', number: 9, state: 'merged', title: 'ABC-1 web', url: PR2 };
    const open: PrInfo = { owner: 'acme', repo: 'api', number: 5, state: 'open', title: 'ABC-1: fix login', url: PR };
    h.sources.linkedFor.mockResolvedValue(new Map([['ABC-1', [merged, open]]]));
    const [card] = await h.svc.cards();
    expect(card).toEqual({
      id: PID, key: 'ABC-1', title: 'ABC-1', summary: 'Login fails',
      status: { name: 'Done', category: 'done', via: 'api' }, done: true,
      tabs: [
        { tabId: 1, windowId: 1, title: '[ABC-1] Login fails - Jira', url: TICKET, favIconUrl: 'https://acme.atlassian.net/f.png', lastAccessed: 5 },
        { tabId: 2, windowId: 1, title: 'ABC-1: fix login', url: PR, pill: 'open', stale: true },
      ],
      linked: [{ url: PR2, title: 'ABC-1 web', state: 'merged' }],
    });
    expect(h.sources.issues).toHaveBeenCalledWith(['ABC-1']);
    expect(h.sources.linkedFor).toHaveBeenCalledWith(['ABC-1'], ['acme', 'extra']);
    await h.svc.cards();
    expect(h.sources.linkedFor).toHaveBeenCalledTimes(1);
    h.clock.now += LINKED_REFRESH_MS;
    await h.svc.cards();
    expect(h.sources.linkedFor).toHaveBeenCalledTimes(2);
    // openLinked accepts a URL linkedFor reported.
    await expect(h.svc.openLinked(PID, PR2)).resolves.toEqual(expect.any(Number));
  });

  it('without API data the ticket tab\'s own source entry (its page read) gives the status; projects without open tabs are not listed', async () => {
    const h = harness();
    await h.store.put(stored());
    await h.store.put(stored({ id: `${RID}:ZZZ-9`, key: 'ZZZ-9' }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    h.sources.factsFor.mockImplementation((id: number) => (id === 1
      ? { [`${RID}/ticket`]: { data: { status: 'In Progress', statusCategory: 'indeterminate' }, via: 'page', fetchedAt: NOW, final: false, stale: false } }
      : undefined));
    const cards = await h.svc.cards();
    expect(cards.map((c) => c.id)).toEqual([PID]);
    expect(cards[0]).toMatchObject({ status: { name: 'In Progress', category: 'indeterminate', via: 'page' }, done: false });
  });
});

describe('ProjectService: the first linked PR\'s title (prTitle), for lists to show beside the key', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const web = { url: PR2, title: 'ABC-1 web', state: 'merged' as const };

  it('cards: without a ticket summary, the first linked PR\'s title; with one, none', async () => {
    const h = harness();
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    h.sources.linkedFor.mockResolvedValue(new Map([['ABC-1', [{ owner: 'acme', repo: 'web', number: 9, state: 'merged', title: 'ABC-1 web', url: PR2 }]]]));
    expect((await h.svc.cards())[0]).toMatchObject({ prTitle: 'ABC-1 web' });
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', {
      data: { key: 'ABC-1', summary: 'Login fails', url: TICKET }, via: 'api', fetchedAt: NOW, final: false, stale: false,
    }]]));
    const [card] = await h.svc.cards();
    expect(card).toMatchObject({ summary: 'Login fails' });
    expect(card).not.toHaveProperty('prTitle');
  });

  it('savedLists and a resting Project home carry it; a named (manual) project and a PR without a title do not', async () => {
    const h = harness();
    await h.store.put(stored({ keep: true, linked: [web] }));
    await h.store.put(stored({ id: `${RID}:ZZZ-9`, key: 'ZZZ-9', keep: true, name: 'Taxes', linked: [web] }));
    await h.store.put(stored({ id: `${RID}:YYY-2`, key: 'YYY-2', keep: true, linked: [{ url: PR, title: PR, state: 'open' }] }));
    const { saved } = await h.svc.savedLists();
    expect(saved.find((x) => x.id === PID)).toMatchObject({ prTitle: 'ABC-1 web' });
    expect(saved.find((x) => x.key === 'ZZZ-9')).not.toHaveProperty('prTitle');
    expect(saved.find((x) => x.key === 'YYY-2')).not.toHaveProperty('prTitle');
    expect(await h.svc.home(PID)).toMatchObject({ prTitle: 'ABC-1 web' });
  });
});

describe('ProjectService: a renamed ticket refreshes the stored summary', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  type Entry = Partial<SourceEntry<JiraIssue>> & { summary?: string };
  const issue = ({ summary, ...o }: Entry): Map<string, SourceEntry<JiraIssue>> => new Map([['ABC-1', {
    data: { key: 'ABC-1', ...(summary !== undefined && { summary }), url: TICKET }, via: 'api', fetchedAt: NOW, final: false, stale: false, ...o,
  }]]);
  const storedSummary = async (h: ReturnType<typeof harness>) => (await h.store.list()).find((p) => p.id === PID)?.summary;

  it('a fresh lookup (api or page) with a new summary replaces it, written once, without bumping updatedAt (M4-R31)', async () => {
    const h = harness();
    await h.store.put(stored({ summary: 'Login fails' }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    h.clock.now += DAY;
    h.sources.issues.mockResolvedValue(issue({ summary: 'Login fails on Safari' }));
    h.local.set.mockClear();
    h.schedule.mockClear();
    expect((await h.svc.cards())[0]).toMatchObject({ summary: 'Login fails on Safari' });
    expect(await storedSummary(h)).toBe('Login fails on Safari');
    expect((await h.store.list()).find((p) => p.id === PID)?.updatedAt).toBe(NOW);
    expect(h.schedule).toHaveBeenCalledWith('project'); // its group title may follow it
    const writes = h.local.set.mock.calls.filter(([items]) => PROJECTS_KEY in items).length;
    h.schedule.mockClear();
    await h.svc.cards();
    expect(h.local.set.mock.calls.filter(([items]) => PROJECTS_KEY in items).length).toBe(writes); // unchanged: not written again
    expect(h.schedule).not.toHaveBeenCalled();
    h.sources.issues.mockResolvedValue(issue({ summary: 'Safari login', via: 'page' }));
    await h.svc.cards();
    expect(await storedSummary(h)).toBe('Safari login');
  });

  it('a stale, unread or empty lookup never overwrites it', async () => {
    const h = harness();
    await h.store.put(stored({ summary: 'Login fails' }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    for (const e of [{ summary: 'Old cached', stale: true }, { summary: 'Unread', via: 'none' as const }, { summary: '' }, { summary: '  ' }, {}]) {
      h.sources.issues.mockResolvedValue(issue(e));
      expect((await h.svc.cards())[0]).toMatchObject({ summary: 'Login fails' });
      expect(await storedSummary(h)).toBe('Login fails');
    }
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('a `{key} · {summary}` group is retitled through the reconciler\'s rename path', async () => {
    const r: Recipe = { ...recipe, project: { ...recipe.project!, title: '{key} · {summary}' } };
    const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }] };
    const h = harness({ program: compileProgram(c, { [RID]: r }).program });
    await h.store.put(stored({ summary: 'Login fails' }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, PR, 'ABC-1: fix login'));
    await h.r.flush();
    expect(h.groupOf(1)).toBe('ABC-1 · Login fails');
    const gid = h.f.state.tabs.find((t) => t.id === 1)?.groupId;
    h.sources.issues.mockResolvedValue(issue({ summary: 'Login fails on Safari' }));
    await h.svc.cards();
    await h.r.flush();
    expect(h.f.state.groups.map((g) => [g.id, g.title])).toEqual([[gid, 'ABC-1 · Login fails on Safari']]);
    expect([1, 2].map(h.groupOf)).toEqual(['ABC-1 · Login fails on Safari', 'ABC-1 · Login fails on Safari']);
    const st = await h.r.liveState();
    expect(st.managedTitles.has('ABC-1 · Login fails on Safari')).toBe(true);
    expect(st.managedTitles.has('ABC-1 · Login fails')).toBe(false);
  });
});

describe('ProjectService fixes (round 1)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('fix I3: a linkedFor that never answers does not block targets() (the queue is not held across the network)', async () => {
    const h = harness();
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.sources.linkedFor.mockReturnValue(new Promise(() => {}));
    h.sources.issues.mockReturnValue(new Promise(() => {}));
    void h.svc.cards();
    await new Promise((r) => setTimeout(r, 0));
    const t = await Promise.race([h.svc.targets(await h.f.snapshot()), new Promise((r) => setTimeout(() => r('blocked'), 200))]);
    expect(t).toBeInstanceOf(Map);
  });

  it('M3-R71: a linked search without results also counts for the 15-minute cap', async () => {
    const h = harness();
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.svc.cards();
    await h.svc.cards();
    expect(h.sources.linkedFor).toHaveBeenCalledTimes(1);
    expect((await h.store.list())[0]!.linkedFetchedAt).toBe(NOW);
  });

  it('M3-R71: openLinked stores the project as resolve() left it (no stale closedFor written back)', async () => {
    const h = harness();
    await h.store.put(stored({ closedFor: 5 * 3600_000, linked: [{ url: PR2, title: 'w', state: 'merged' }] }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.svc.openLinked(PID, PR2);
    const p = (await h.store.list())[0]!;
    expect(p.closedFor).toBeUndefined();
    expect(p.manual.map((m) => m.url)).toEqual([PR2]);
  });
});

describe('ProjectService fixes (round 2)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('N2: closed time accrues across MV3 worker restarts (clock in storage.session) until the 7-day prune', async () => {
    const local = memoryArea();
    const session = memorySession();
    const f = new FakeBrowserPort();
    f.addWindow(1, { focused: true });
    f.addTab(tab(1, 'https://example.com/', 'x'));
    local.data.set(PROJECTS_KEY, [stored({ id: `${RID}:ZZZ-9`, key: 'ZZZ-9', closedFor: PRUNE_AFTER_MS - 50 * 60_000 })]);
    const ids: string[][] = [];
    for (let i = 0; i <= 4; i++) {
      const h = harness({ local, session, port: f }); // a new worker: new instances, same storage
      h.clock.now = NOW + i * 15 * 60_000;
      await h.svc.targets(await f.snapshot());
      ids.push((await new ProjectStore(local).list()).map((p) => p.id));
    }
    // Workers 0-3: 45 min pending (+ 7 d - 50 min stored) → kept; worker 4: 60 min → stored and pruned on its start.
    expect(ids).toEqual([[`${RID}:ZZZ-9`], [`${RID}:ZZZ-9`], [`${RID}:ZZZ-9`], [`${RID}:ZZZ-9`], []]);
  });

  it('N2: the 15-minute cap per gap holds across workers; a browser restart (session cleared) starts the clock again', async () => {
    const local = memoryArea();
    const session = memorySession();
    const f = new FakeBrowserPort();
    f.addWindow(1, { focused: true });
    f.addTab(tab(1, 'https://example.com/', 'x'));
    local.data.set(PROJECTS_KEY, [stored({ id: `${RID}:ZZZ-9`, key: 'ZZZ-9' })]);
    const pass = async (at: number) => { const h = harness({ local, session, port: f }); h.clock.now = at; await h.svc.targets(await f.snapshot()); };
    await pass(NOW);
    await pass(NOW + 5 * DAY); // capped
    expect(session.data.get(CLOSED_CLOCK_KEY)).toEqual({ lastTick: NOW + 5 * DAY, pending: { [`${RID}:ZZZ-9`]: 15 * 60_000 } });
    session.data.clear();
    await pass(NOW + 6 * DAY);
    expect(session.data.get(CLOSED_CLOCK_KEY)).toEqual({ lastTick: NOW + 6 * DAY, pending: {} });
  });

  it('M3-R73 N3: under global dry run the menu lists only stored projects', async () => {
    const seen: unknown[] = [];
    const h = harness({ program: { ...program(), dryRun: true }, onProjectsChanged: (ps) => seen.push(ps) });
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.svc.targets(await h.f.snapshot());
    expect(await h.store.list()).toEqual([]);
    expect(seen).toEqual([[]]);
  });

  it('under global dry run a tombstoned project is not offered in the menu (addTab would reject it)', async () => {
    const seen: { id: string }[][] = [];
    const h = harness({ program: { ...program(), dryRun: true }, onProjectsChanged: (ps) => seen.push(ps) });
    await h.store.put(stored({ closedAt: NOW, closedIds: ['rc1'] }), stored({ id: `${RID}:XYZ-2`, key: 'XYZ-2' }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, 'https://acme.atlassian.net/browse/XYZ-2', '[XYZ-2] Other - Jira'));
    await h.svc.targets(await h.f.snapshot());
    expect(seen.at(-1)!.map((p) => p.id)).toEqual([`${RID}:XYZ-2`]);
  });

  it('M3-R73 N4: an older linked fetch finishing last does not overwrite newer linked PRs', async () => {
    const h = harness();
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    const pr = (n: number): PrInfo => ({ owner: 'acme', repo: 'api', number: n, state: 'merged', title: `ABC-1 #${n}`, url: `https://github.com/acme/api/pull/${n}` });
    let releaseOld!: (m: Map<string, PrInfo[]>) => void;
    h.sources.linkedFor.mockReturnValueOnce(new Promise((r) => { releaseOld = r; }));
    h.sources.linkedFor.mockResolvedValueOnce(new Map([['ABC-1', [pr(2)]]]));
    const old = h.svc.cards();
    await vi.waitFor(() => expect(h.sources.linkedFor).toHaveBeenCalledTimes(1));
    h.clock.now += 1000;
    await h.svc.cards();
    releaseOld(new Map([['ABC-1', [pr(1)]]]));
    await old;
    const p = (await h.store.list())[0]!;
    expect(p.linked.map((l) => l.url)).toEqual([pr(2).url]);
    expect(p.linkedFetchedAt).toBe(NOW + 1000);
  });
});

describe('ProjectService: project status fixes (#30)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  /** The recipe with a jira.issue source on its ticket rule: its ticket tabs give the project's site (M3-R110). */
  const sourced = (): Program => {
    const r: Recipe = { ...recipe, rules: recipe.rules.map((x) => (x.id === 'ticket'
      ? { ...x, source: { connection: 'jira', query: 'jira.issue' as const, args: { key: '{key}' }, fields: { status: 'status', statusCategory: 'statusCategory' } } } : x)) };
    const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }] };
    const { program: p, errors } = compileProgram(c, { [RID]: r });
    expect(errors).toEqual([]);
    return p;
  };

  it('on-site check needs a ticket tab: a Jira dashboard on the connected site does not ask the connection for status', async () => {
    const h = harness({ program: sourced() });
    h.f.addTab(tab(1, 'https://other.atlassian.net/browse/ABC-1', '[ABC-1] Their ticket - Jira'));
    await h.r.flush();
    h.f.addTab(tab(2, 'https://acme.atlassian.net/jira/dashboards', 'Dashboards - Jira'));
    await h.svc.addTab(2, PID);
    await h.r.flush();
    const cards = await h.svc.cards();
    expect(cards[0]!.tabs.map((t) => t.tabId)).toEqual([1, 2]);
    expect(h.sources.issues.mock.calls.flatMap(([ks]) => ks)).not.toContain('ABC-1');
    expect((await h.store.list())[0]!.site).toBe('other.atlassian.net');
  });

  it('site does not depend on assignment order: the lowest tab id\'s ticket host, whichever tab comes first', async () => {
    for (const order of [[5, 3], [3, 5]]) {
      const h = harness({ program: sourced() });
      const url = (id: number) => (id === 3 ? TICKET : 'https://other.atlassian.net/browse/ABC-1');
      for (const id of order) h.f.addTab(tab(id, url(id), '[ABC-1] Login fails - Jira'));
      await h.r.flush();
      expect((await h.store.list()).map((p) => p.site)).toEqual(['acme.atlassian.net']);
    }
  });
});

describe('GitHub issue projects (key owner/repo#N)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const GH = 'github-issue';
  const ghRecipe = (title = '#{num} · {summary}'): Recipe => ({
    recipe: GH, version: 1, name: 'GitHub issue', description: 'x',
    project: { key: '{key}', title, color: 'purple', container: 'group', join: ['rules', 'manual'] },
    rules: [{
      id: 'issue', name: 'GitHub issue', enabled: true, match: { url: 'github.com/:owner/:repo/issues/*' },
      extract: { key: { from: 'url', githubIssue: {} } },
      actions: [{ assignProject: { key: '{key}', create: true } }],
    }],
  });
  function ghProgram(title?: string): Program {
    const c: Config = { ...defaultConfig(), recipes: [{ id: GH, enabled: true, params: {}, source: 'builtin' }] };
    const { program: p, errors } = compileProgram(c, { [GH]: ghRecipe(title) });
    expect(errors).toEqual([]);
    return p;
  }
  const ISSUE = 'https://github.com/acme/web/issues/5';
  const entry = (data: GithubIssueInfo, o: Partial<SourceEntry<GithubIssueInfo>> = {}): SourceEntry<GithubIssueInfo> => ({ data, via: 'api', fetchedAt: NOW, final: false, stale: false, ...o });
  const closed: GithubIssueInfo = {
    owner: 'acme', repo: 'web', number: 5, summary: 'Fix login', state: 'closed', status: 'Closed', statusCategory: 'done', url: ISSUE,
    linkedPrs: [{ owner: 'acme', repo: 'web', number: 9, state: 'merged', title: 'Fix login (#5)', url: PR2 }],
  };

  it('Review Focus 2: acme/a#12 and acme/b#12 open → two groups a#12 and b#12; closing b\'s tab renames a\'s group back to #12', async () => {
    const h = harness({ program: ghProgram() });
    h.f.addTab(tab(1, 'https://github.com/acme/a/issues/12', 'a'));
    h.f.addTab(tab(2, 'https://github.com/acme/b/issues/12', 'b'));
    await h.r.flush();
    expect(h.f.state.groups.map((g) => g.title).sort()).toEqual(['a#12', 'b#12']);
    expect(h.groupOf(1)).toBe('a#12');
    expect(h.groupOf(2)).toBe('b#12');
    const aGroup = h.f.state.tabs.find((t) => t.id === 1)!.groupId;
    expect((await h.svc.cards()).map((c) => c.title).sort()).toEqual(['a#12', 'b#12']);
    await h.f.closeTab(2);
    await h.r.flush();
    expect(h.f.state.groups.map((g) => [g.id, g.title])).toEqual([[aGroup, '#12']]);
    expect((await h.svc.cards()).map((c) => c.title)).toEqual(['#12']);
  });

  it('a {repo}#{num} title: acme/web#12 alone is web#12; with other/web#12 open, acme/web#12 and other/web#12; one closes → web#12 again, same group', async () => {
    const h = harness({ program: ghProgram('{repo}#{num}') });
    h.f.addTab(tab(1, 'https://github.com/acme/web/issues/12', 'a'));
    await h.r.flush();
    expect(h.groupOf(1)).toBe('web#12');
    h.f.addTab(tab(2, 'https://github.com/other/web/issues/12', 'b'));
    await h.r.flush();
    expect(h.f.state.groups.map((g) => g.title).sort()).toEqual(['acme/web#12', 'other/web#12']);
    expect(h.groupOf(1)).toBe('acme/web#12');
    expect(h.groupOf(2)).toBe('other/web#12');
    const aGroup = h.f.state.tabs.find((t) => t.id === 1)!.groupId;
    expect((await h.svc.cards()).map((c) => c.title).sort()).toEqual(['acme/web#12', 'other/web#12']);
    await h.f.closeTab(2);
    await h.r.flush();
    expect(h.f.state.groups.map((g) => [g.id, g.title])).toEqual([[aGroup, 'web#12']]);
    expect((await h.svc.cards()).map((c) => c.title)).toEqual(['web#12']);
  });

  it('Review Focus 5: cards read the issue from githubIssues (never the Jira lookups), and list its linked PRs', async () => {
    const h = harness({ program: ghProgram() });
    h.f.addTab(tab(1, ISSUE, 'Fix login · Issue #5 · acme/web'));
    await h.r.flush();
    h.sources.githubIssues.mockResolvedValue(new Map([['acme/web#5', entry(closed)]]));
    const [card] = await h.svc.cards();
    expect(card).toMatchObject({
      key: 'acme/web#5', title: '#5 · Fix login', summary: 'Fix login', status: { name: 'Closed', category: 'done', via: 'api' }, done: true,
      linked: [{ url: PR2, title: 'Fix login (#5)', state: 'merged' }],
    });
    expect(h.sources.githubIssues).toHaveBeenCalledWith(['acme/web#5']);
    expect(h.sources.issues.mock.calls.flat(2)).not.toContain('acme/web#5');
    expect(h.sources.linkedFor.mock.calls.flatMap(([keys]) => keys)).not.toContain('acme/web#5');
  });

  it('a stale closed issue shows its status but is not done', async () => {
    const h = harness({ program: ghProgram() });
    h.f.addTab(tab(1, ISSUE, 'Fix login · Issue #5 · acme/web'));
    await h.r.flush();
    h.sources.githubIssues.mockResolvedValue(new Map([['acme/web#5', entry(closed, { stale: true })]]));
    const [card] = await h.svc.cards();
    expect(card).toMatchObject({ status: { name: 'Closed', category: 'done', via: 'api' }, done: false });
  });

  it('cards look the issue up once per render, its linked PRs included (an unreadable issue costs one lookup, not two)', async () => {
    const h = harness({ program: ghProgram() });
    h.f.addTab(tab(1, 'https://github.com/acme/web/issues/42', 'Issue #42'));
    await h.r.flush();
    const unknown: GithubIssueInfo = { owner: 'acme', repo: 'web', number: 42, state: 'unknown', url: 'https://github.com/acme/web/issues/42' };
    h.sources.githubIssues.mockResolvedValue(new Map([['acme/web#42', entry(unknown, { via: 'none', error: 'not-found' })]]));
    for (let i = 0; i < 3; i++) {
      h.sources.githubIssues.mockClear();
      h.clock.now += LINKED_REFRESH_MS; // the linked PRs are due on every render
      await h.svc.cards();
      expect(h.sources.githubIssues).toHaveBeenCalledTimes(1);
    }
    h.sources.githubIssues.mockClear();
    h.sources.githubIssues.mockResolvedValue(new Map([['acme/web#42', entry({ ...closed, number: 42 })]]));
    h.clock.now += LINKED_REFRESH_MS;
    const [card] = await h.svc.cards();
    expect(h.sources.githubIssues).toHaveBeenCalledTimes(1);
    expect(card).toMatchObject({ linked: [{ url: PR2, title: 'Fix login (#5)', state: 'merged' }] });
  });

  it('a stored issue project with API status confirms no Jira prefix: a PR titled MY-123 creates no project', async () => {
    const h = harness();
    const issue = { status: { name: 'Open', category: 'new' as const, via: 'api' as const } };
    await h.store.put(stored({ id: `${GH}:my-org/web#12`, recipeId: GH, key: 'my-org/web#12', ...issue }));
    h.f.addTab(tab(1, PR, 'MY-123: fix login'));
    expect((await h.svc.targets(await h.f.snapshot())).get(1)).toBeFalsy();
    // Control: a Jira project with API status does confirm its prefix.
    await h.store.put(stored({ id: `${RID}:MY-5`, key: 'MY-5', ...issue }));
    expect((await h.svc.targets(await h.f.snapshot())).get(1)?.title).toBe('MY-123');
  });
});
