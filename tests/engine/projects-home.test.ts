// ProjectService.home (M4 T4): one project's card data plus its groups in tab-bar order, its settings and its recipe's
// name, fetched through the same path as cards() (only that project's ticket and linked PRs are asked for).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Program, Recipe } from '../../src/core/lang/types';
import type { Project } from '../../src/core/projects/types';
import type { JiraIssue, PrInfo, SourceEntry } from '../../src/core/sources/types';
import type { Config, TabSnap } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const RID = 'jira-ticket-title';
const PID = `${RID}:ABC-1`;
const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const PR = 'https://github.com/acme/api/pull/5';

const recipe: Recipe = {
  recipe: RID, version: 1, name: 'Jira ticket (title)', description: 'x',
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
function program(): Program {
  const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }] };
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
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))]))),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); }),
  };
};
const stored = (o: Partial<Project> = {}): Project => ({ id: PID, recipeId: RID, key: 'ABC-1', createdAt: NOW, updatedAt: NOW, manual: [], excluded: [], linked: [], ...o });

function harness(o: { recipeName?: (id: string) => Promise<string | undefined> } = {}) {
  const f = new FakeBrowserPort();
  f.addWindow(1, { focused: true });
  f.addWindow(2);
  const p = program();
  type Facts = Record<string, SourceEntry<Record<string, unknown>>> | undefined;
  const sources = {
    factsFor: vi.fn<(id: number, url?: string) => Facts>(() => undefined),
    issues: vi.fn<(keys: string[]) => Promise<Map<string, SourceEntry<JiraIssue>>>>(async () => new Map()),
    linkedFor: vi.fn<(keys: string[], orgs: string[]) => Promise<Map<string, PrInfo[]>>>(async () => new Map()),
    jiraSite: vi.fn<() => Promise<string | undefined>>(async () => 'acme.atlassian.net'),
    githubIssues: vi.fn(async () => new Map()),
  };
  const store = new ProjectStore(memoryArea());
  // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
  let r: Reconciler;
  const svc = new ProjectService({
    store, port: f, getProgram: async () => p, sources, facts: { get: () => undefined }, log: { add: () => {} },
    recentlyClosed: { add: () => 'rc' }, safety: { isProtected: () => false },
    state: () => r.liveState(), now: () => NOW, ...(o.recipeName && { recipeName: o.recipeName }),
  });
  r = new Reconciler(f, async () => p, { projects: svc, now: () => NOW, log: { add: () => {} } });
  return { f, sources, store, svc, r };
}

describe('ProjectService.home (M4 T4)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('groups the project\'s tabs by group, ordered by the lowest tab index per window; tabs in index order', async () => {
    const h = harness();
    await h.store.put(stored());
    h.f.addTab(tab(1, 'https://example.com/a', 'Other'));
    h.f.addTab(tab(2, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(3, PR, 'ABC-1: fix login'));
    await h.r.flush(); // the reconciler groups 2 and 3 as ABC-1 in window 1
    // A second ABC-1 group in window 2, after a tab of another group, and one in window 1 before the first one.
    h.f.addGroup({ id: 50, windowId: 2, title: 'ABC-1', color: 'blue', collapsed: false });
    h.f.addGroup({ id: 60, windowId: 1, title: 'ABC-1 (2)', color: 'red', collapsed: false });
    h.f.addTab(tab(10, 'https://github.com/acme/web/pull/9', 'ABC-1: web', { windowId: 2, groupId: 50 }));
    h.f.addTab(tab(11, 'https://github.com/acme/web/pull/7', 'ABC-1: docs', { windowId: 1, groupId: 60 }));
    await h.svc.cards(); // membership of the new tabs (sticky by rule)
    await h.f.moveGroup(60, 0); // tab 11's group is first in window 1's tab bar
    const snap = await h.f.snapshot();
    const idx = (id: number) => snap.tabs.find((t) => t.id === id)!.index;
    expect(idx(11)).toBeLessThan(idx(2));
    const home = await h.svc.home(PID);
    expect(home?.groups).toEqual([
      { title: 'ABC-1 (2)', color: 'red', windowId: 1, tabIds: [11] },
      { title: 'ABC-1', color: 'blue', windowId: 1, tabIds: [2, 3] },
      { title: 'ABC-1', color: 'blue', windowId: 2, tabIds: [10] },
    ]);
  });

  it('tabs not in a group form one untitled grey entry per window', async () => {
    const h = harness();
    await h.store.put(stored({ manual: [{ url: 'https://example.com/x', windowId: 1, tabId: 1 }] }));
    h.f.addTab(tab(1, 'https://example.com/x', 'X'));
    const home = await h.svc.home(PID);
    expect(home?.groups).toEqual([{ title: '', color: 'grey', windowId: 1, tabIds: [1] }]);
  });

  it('carries the card data, the settings from the ProjectDef and the recipe\'s name', async () => {
    const h = harness({ recipeName: async (id) => (id === RID ? 'Jira ticket (title)' : undefined) });
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    const home = await h.svc.home(PID);
    expect(home).toMatchObject({
      id: PID, key: 'ABC-1', title: 'ABC-1', done: false, linked: [],
      tabs: [{ tabId: 1, url: TICKET }],
      settings: { container: 'group', placement: ['existing', 'current'], join: ['rules', 'manual'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload' },
      recipeName: 'Jira ticket (title)',
    });
    expect(Object.keys(home!.settings!).sort()).toEqual(['container', 'join', 'onOpenElsewhere', 'onSwitchAway', 'placement']);
  });

  it('without a recipeName dep (or an unknown recipe) the recipe id is the name', async () => {
    const h = harness();
    await h.store.put(stored());
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    expect((await h.svc.home(PID))?.recipeName).toBe(RID);
  });

  it('an unknown, closed or tab-less project is undefined', async () => {
    const h = harness();
    await h.store.put(stored(), stored({ id: `${RID}:ZZZ-9`, key: 'ZZZ-9' }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    expect(await h.svc.home('nope')).toBeUndefined();
    expect(await h.svc.home(`${RID}:ZZZ-9`)).toBeUndefined();
    await h.svc.closeGroup(PID);
    expect(await h.svc.home(PID)).toBeUndefined();
  });

  it('asks the sources about that project only (the cards() fetch path, one project)', async () => {
    const h = harness();
    await h.store.put(stored(), stored({ id: `${RID}:ZZZ-9`, key: 'ZZZ-9' }));
    h.f.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.f.addTab(tab(2, 'https://acme.atlassian.net/browse/ZZZ-9', '[ZZZ-9] Other - Jira'));
    await h.r.flush();
    await h.svc.home(PID);
    expect(h.sources.issues.mock.calls).toEqual([[['ABC-1']]]);
    expect(h.sources.linkedFor.mock.calls.map(([keys]) => keys)).toEqual([['ABC-1']]);
  });
});
