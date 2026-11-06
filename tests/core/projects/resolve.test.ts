import { describe, expect, it } from 'vitest';
import { compileProgram } from '../../../src/core/lang/compile';
import { defaultConfig } from '../../../src/core/config/defaults';
import { planGroups, type PlanContext } from '../../../src/core/group/plan';
import {
  projectGroupTitle, projectTargets, resolveProjects, titleBelongsToProject, type ResolveInput, type StickyMap,
} from '../../../src/core/projects/resolve';
import type { Project, ProjectDef } from '../../../src/core/projects/types';
import type { Program, Recipe, Rule, TabFacts } from '../../../src/core/lang/types';
import type { Config, Snapshot, TabSnap } from '../../../src/core/types';

const NOW = 1_800_000_000_000;
const RID = 'jira-ticket-title';
const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const PR = 'https://github.com/acme/api/pull/5';

const def: ProjectDef = { recipeId: RID, key: '{key}', title: '{key} · {summary}', color: 'blue', container: 'group', join: ['rules', 'manual'],
  placement: ['existing', 'current'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload', start: 'auto' };
const recipe: Recipe = {
  recipe: RID, version: 1, name: 'Jira ticket (title)', description: 'x',
  project: { key: def.key, title: def.title, color: def.color, container: 'group', join: def.join },
  rules: [
    {
      id: 'ticket', name: 'ticket', enabled: true, match: { url: '*.atlassian.net/browse/*' },
      extract: { key: { from: 'url', jiraKey: {} }, summary: { from: 'title', regex: '^\\[[^\\]]+\\]\\s*(?<s>.+?)\\s*-\\s*Jira$', group: 's' } },
      actions: [{ assignProject: { key: '{key}', create: true } }],
    },
    {
      id: 'pr', name: 'pr', enabled: true, match: { url: 'github.com/:owner/:repo/pull/*' },
      extract: { key: { from: 'title', jiraKey: {} } },
      actions: [{ assignProject: { key: '{key}' } }],
    },
  ],
};
const acme: Rule = { id: 'acme', name: 'acme', enabled: true, match: { url: 'github.com/acme/*' }, actions: [{ group: { title: 'acme', color: 'red' } }] };

function program(over: Partial<Config> = {}): Program {
  const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }], ...over };
  const { program: p, errors } = compileProgram(c, { [RID]: recipe });
  expect(errors).toEqual([]);
  return p;
}
const tab = (id: number, url: string, title: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id, windowId: 1, index: id, url, title, pinned: false, groupId: -1, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});
const snapOf = (...tabs: TabSnap[]): Snapshot => ({ tabs, groups: [], windows: [{ id: 1, type: 'normal', focused: true }] });
const project = (key: string, o: Partial<Project> = {}): Project => ({
  id: `${RID}:${key}`, recipeId: RID, key, createdAt: 1, updatedAt: 1, manual: [], excluded: [], linked: [], ...o,
});
function resolve(snap: Snapshot, o: Partial<ResolveInput> = {}) {
  return resolveProjects({
    snap, program: program(), facts: (): Partial<TabFacts> => ({}), projects: [], knownPrefixes: new Set(),
    allowPrefixes: [], now: NOW, sticky: new Map(), ...o,
  });
}

describe('resolveProjects: rule join', () => {
  it('a Jira ticket tab and a PR whose title has its key → both in jira-ticket-title:ABC-1, one project created', () => {
    const r = resolve(snapOf(tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'ABC-1: fix login · Pull Request #5 · acme/api')));
    expect(r.assignments.get(1)).toEqual({ projectId: `${RID}:ABC-1`, key: 'ABC-1', via: 'rule', ruleKey: `${RID}/ticket`, index: 0 });
    expect(r.assignments.get(2)).toEqual({ projectId: `${RID}:ABC-1`, key: 'ABC-1', via: 'rule', ruleKey: `${RID}/pr`, index: 1 });
    expect(r.created).toEqual([project('ABC-1', { createdAt: NOW, updatedAt: NOW })]);
    expect(r.summaries).toEqual(new Map([[`${RID}:ABC-1`, 'Login fails']]));
  });

  it('an existing project is kept, not created again; a PR joins it with no ticket tab', () => {
    const r = resolve(snapOf(tab(2, PR, 'ABC-1 fix')), { projects: [project('ABC-1')] });
    expect(r.assignments.get(2)?.projectId).toBe(`${RID}:ABC-1`);
    expect(r.created).toEqual([]);
  });

  it('a source summary of the ticket rule wins over the title one', () => {
    const facts = (id: number): Partial<TabFacts> => (id === 1 ? { source: { [`${RID}/ticket`]: { data: { summary: 'From API' } } } } : {});
    const r = resolve(snapOf(tab(1, TICKET, '[ABC-1] Login fails - Jira')), { facts });
    expect(r.summaries.get(`${RID}:ABC-1`)).toBe('From API');
  });
});

describe('resolveProjects: order independence (M3-R56)', () => {
  const mentionProgram = (): Program => {
    const r2: Recipe = { ...recipe, rules: [
      { id: 'mention', name: 'mention', enabled: true, match: { url: '*' }, extract: { key: { from: 'title', jiraKey: {} } }, actions: [{ assignProject: { key: '{key}' } }] },
      recipe.rules[0]!,
    ] };
    const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }] };
    const { program: p, errors } = compileProgram(c, { [RID]: r2 });
    expect(errors).toEqual([]);
    return p;
  };
  it('pass 2a skips a candidate whose project excludes this tab, so its later create still settles before PRs', () => {
    const projects = [project('DEF-7', { excluded: [TICKET] })];
    const r = resolve(snapOf(tab(1, PR, 'ABC-1 fix'), tab(2, TICKET, 'DEF-7 mentioned')), { program: mentionProgram(), projects });
    expect(r.assignments.get(2)?.projectId).toBe(`${RID}:ABC-1`);
    expect(r.assignments.get(1)?.projectId).toBe(`${RID}:ABC-1`);
  });
  it('a PR tab listed before a tab whose later create candidate makes the project still joins it', () => {
    const r2: Recipe = { ...recipe, rules: [
      { id: 'mention', name: 'mention', enabled: true, match: { url: '*' }, extract: { key: { from: 'title', jiraKey: {} } }, actions: [{ assignProject: { key: '{key}' } }] },
      recipe.rules[0]!,
    ] };
    const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }] };
    const { program: p, errors } = compileProgram(c, { [RID]: r2 });
    expect(errors).toEqual([]);
    // Tab 1 (PR) comes first; tab 2's top candidate is an unconfirmed DEF-7, its second creates ABC-1.
    const r = resolve(snapOf(tab(1, PR, 'ABC-1 fix'), tab(2, TICKET, 'DEF-7 mentioned')), { program: p });
    expect(r.assignments.get(2)?.projectId).toBe(`${RID}:ABC-1`);
    expect(r.assignments.get(1)?.projectId).toBe(`${RID}:ABC-1`);
    expect(r.created.map((x) => x.id)).toEqual([`${RID}:ABC-1`]);
  });
});

describe('resolveProjects: Review Focus #5 (unconfirmed keys)', () => {
  it('a PR titled "Bump UTF-8 lib" with no ticket tab → no assignment, no project', () => {
    const r = resolve(snapOf(tab(2, PR, 'Bump UTF-8 lib')));
    expect(r.assignments.size).toBe(0);
    expect(r.created).toEqual([]);
  });
  it('a PR "DEF-3 fix" with no ticket tab → no project unless DEF is an allowed or known prefix', () => {
    const s = snapOf(tab(2, PR, 'DEF-3 fix'));
    expect(resolve(s).assignments.size).toBe(0);
    expect(resolve(s).created).toEqual([]);
    for (const o of [{ allowPrefixes: ['DEF'] }, { knownPrefixes: new Set(['DEF']) }]) {
      const r = resolve(s, o);
      expect(r.assignments.get(2)?.projectId).toBe(`${RID}:DEF-3`);
      expect(r.created.map((p) => p.id)).toEqual([`${RID}:DEF-3`]);
    }
  });
});

describe('resolveProjects: a project created by a confirmed prefix', () => {
  it('records the creating candidate\'s summary', () => {
    const pr: Rule = { ...recipe.rules[1]!, extract: { key: { from: 'title', jiraKey: {} }, summary: { from: 'title', regex: '^\\S+ (.+)$' } } };
    const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }] };
    const { program: p, errors } = compileProgram(c, { [RID]: { ...recipe, rules: [recipe.rules[0]!, pr] } });
    expect(errors).toEqual([]);
    const r = resolve(snapOf(tab(2, PR, 'DEF-3 fix login')), { program: p, allowPrefixes: ['DEF'] });
    expect(r.summaries).toEqual(new Map([[`${RID}:DEF-3`, 'fix login']]));
  });
});

describe('resolveProjects: manual and excluded', () => {
  it('a tab manually added to ABC-1 whose rules say DEF-2 → ABC-1', () => {
    const r = resolve(snapOf(tab(2, PR, 'DEF-2 fix')), {
      projects: [project('ABC-1', { manual: [{ url: PR, windowId: 1, tabId: 2 }] }), project('DEF-2')],
    });
    expect(r.assignments.get(2)).toEqual({ projectId: `${RID}:ABC-1`, key: 'ABC-1', via: 'manual', index: -1 });
  });
  it('a manual entry matches by normalized URL when its tab id is gone (browser restart)', () => {
    const r = resolve(snapOf(tab(9, `${PR}#top`, 'x')), { projects: [project('ABC-1', { manual: [{ url: PR, windowId: 1, tabId: 2 }] })] });
    expect(r.assignments.get(9)?.via).toBe('manual');
  });
  it('a manual entry whose own tab navigated away can be claimed by another tab at its URL', () => {
    const r = resolve(snapOf(tab(2, 'https://github.com/acme/api/pull/6', 'x'), tab(3, PR, 'y')), {
      projects: [project('ABC-1', { manual: [{ url: PR, windowId: 1, tabId: 2 }] })],
    });
    expect(r.assignments.has(2)).toBe(false);
    expect(r.assignments.get(3)?.via).toBe('manual');
  });
  it('a second copy of a manually added page joins with it (same PR open twice)', () => {
    const r = resolve(snapOf(tab(2, PR, 'x'), tab(3, PR, 'y')), { projects: [project('ABC-1', { manual: [{ url: PR, windowId: 1, tabId: 2 }] })] });
    expect(r.assignments.get(2)?.via).toBe('manual');
    expect(r.assignments.get(3)).toEqual({ projectId: `${RID}:ABC-1`, key: 'ABC-1', via: 'manual', index: -1 });
  });
  it('two projects listing the same URL each keep their own tab; a further copy goes to the first', () => {
    const r = resolve(snapOf(tab(2, PR, 'x'), tab(3, PR, 'y'), tab(4, PR, 'z')), {
      projects: [project('ABC-1', { manual: [{ url: PR, windowId: 1, tabId: 2 }] }), project('DEF-2', { manual: [{ url: PR, windowId: 1, tabId: 3 }] })],
    });
    expect([2, 3, 4].map((id) => r.assignments.get(id)?.key)).toEqual(['ABC-1', 'DEF-2', 'ABC-1']);
  });
  it('a manual entry whose tab navigated away no longer holds that tab', () => {
    const r = resolve(snapOf(tab(2, 'https://github.com/acme/api/pull/6', 'x')), { projects: [project('ABC-1', { manual: [{ url: PR, windowId: 1, tabId: 2 }] })] });
    expect(r.assignments.size).toBe(0);
  });
  it('an excluded URL is never assigned by rules (nor by sticky membership)', () => {
    const projects = [project('ABC-1', { excluded: [PR] })];
    const s = snapOf(tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'ABC-1 fix'));
    const r = resolve(s, { projects, sticky: new Map([[2, { projectId: `${RID}:ABC-1`, url: PR }]]) });
    expect(r.assignments.get(1)?.projectId).toBe(`${RID}:ABC-1`);
    expect(r.assignments.has(2)).toBe(false);
  });
});

describe('resolveProjects: sticky membership', () => {
  it('the title loses the key while loading (same URL) → still assigned; the URL changes → re-evaluated', () => {
    const ticket = tab(1, TICKET, '[ABC-1] Login fails - Jira');
    const first = resolve(snapOf(ticket, tab(2, PR, 'ABC-1: fix login · Pull Request #5 · acme/api')));
    expect(first.sticky.get(2)).toEqual({ projectId: `${RID}:ABC-1`, url: PR, ruleKey: `${RID}/pr`, index: 1 });
    const projects = first.created;

    const loading = resolve(snapOf(ticket, tab(2, PR, 'github.com/acme/api/pull/5')), { projects, sticky: first.sticky });
    expect(loading.assignments.get(2)).toMatchObject({ projectId: `${RID}:ABC-1`, via: 'rule' });
    expect(loading.sticky.get(2)).toEqual({ projectId: `${RID}:ABC-1`, url: PR, ruleKey: `${RID}/pr`, index: 1 });

    const moved = resolve(snapOf(ticket, tab(2, 'https://github.com/acme/api/pull/6', 'github.com/acme/api/pull/6')), { projects, sticky: loading.sticky });
    expect(moved.assignments.has(2)).toBe(false);
    expect(moved.sticky.has(2)).toBe(false);
  });
  it('while loading, a sticky tab keeps the rule that assigned it (T14 carry), at that rule\'s current index', () => {
    const extra: Recipe = {
      ...recipe,
      rules: [...recipe.rules, { id: 'late', name: 'late', enabled: true, match: { url: 'nowhere.test/*' }, actions: [{ assignProject: { key: 'ZZZ-1' } }] }],
    };
    const c: Config = { ...defaultConfig(), recipes: [{ id: RID, enabled: true, params: {}, source: 'builtin' }] };
    const { program: p, errors } = compileProgram(c, { [RID]: extra });
    expect(errors).toEqual([]);
    const projects = [project('ABC-1')];
    const sticky: StickyMap = new Map([[2, { projectId: `${RID}:ABC-1`, url: PR, ruleKey: `${RID}/pr`, index: 7 }]]);
    const r = resolve(snapOf(tab(2, PR, 'github.com/acme/api/pull/5')), { program: p, projects, sticky });
    expect(r.assignments.get(2)).toMatchObject({ ruleKey: `${RID}/pr`, index: 1 }); // not the recipe's last rule (late, 2)
    expect(r.sticky.get(2)).toEqual({ projectId: `${RID}:ABC-1`, url: PR, ruleKey: `${RID}/pr`, index: 1 });
  });
  it('a sticky entry for a project that no longer exists is dropped', () => {
    const sticky: StickyMap = new Map([[2, { projectId: `${RID}:ABC-1`, url: PR }]]);
    expect(resolve(snapOf(tab(2, PR, 'loading')), { sticky }).assignments.size).toBe(0);
  });
});

describe('projectGroupTitle / titleBelongsToProject', () => {
  it('renders {key} and {summary}; a missing summary falls back to the key', () => {
    expect(projectGroupTitle(def, project('ABC-1', { summary: 'Login fails' }))).toBe('ABC-1 · Login fails');
    expect(projectGroupTitle(def, project('ABC-1'))).toBe('ABC-1');
    expect(projectGroupTitle({ ...def, title: '{key}' }, project('ABC-1', { summary: 'x' }))).toBe('ABC-1');
  });
  it('a title belongs to the key when equal or "<key> · …"', () => {
    expect(titleBelongsToProject('ABC-1', 'ABC-1')).toBe(true);
    expect(titleBelongsToProject('ABC-1 · Login fails', 'ABC-1')).toBe(true);
    expect(titleBelongsToProject('ABC-12', 'ABC-1')).toBe(false);
    expect(titleBelongsToProject('ABC-1: x', 'ABC-1')).toBe(false);
  });
});

describe('projectTargets', () => {
  it('builds full group targets: strict, not merged, index = the assignment index, titleMatches by key', () => {
    const t = projectTargets(
      new Map([[2, { projectId: `${RID}:ABC-1`, key: 'ABC-1', via: 'rule' as const, ruleKey: `${RID}/pr`, index: 3 }]]),
      [project('ABC-1', { summary: 'Login fails' })], [def],
    ).get(2)!;
    expect(t).toMatchObject({
      key: `${RID}/pr`, ruleId: `${RID}/pr`, index: 3, ruleIndex: 3, title: 'ABC-1 · Login fails', color: 'blue',
      collapsed: false, sortGroups: 'creation', strict: true, merge: false, dryRun: false, anchors: [],
    });
    expect(t.titleMatches?.('ABC-1')).toBe(true);
    expect(t.titleMatches?.('ABC-2')).toBe(false);
  });
  it('an assignment whose project or def is missing gets no target', () => {
    const a = new Map([[2, { projectId: `${RID}:ABC-1`, key: 'ABC-1', via: 'manual' as const, index: -1 }]]);
    expect(projectTargets(a, [], [def]).size).toBe(0);
    expect(projectTargets(a, [project('ABC-1')], []).size).toBe(0);
  });
});

describe('priority: a project wins over a group rule only when its rule is earlier', () => {
  const ctx = (overrides: PlanContext['overrides']): PlanContext => ({ leaveAlone: new Set(), managedTitles: new Set(), creationOrder: new Map(), overrides });
  const titles = (order: string[]) => {
    const p = program({ rules: [acme], order });
    const s = snapOf(tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'ABC-1: fix login · Pull Request #5 · acme/api'));
    const r = resolve(s, { program: p });
    const projects = r.created.map((x) => ({ ...x, summary: r.summaries.get(x.id) ?? '' })); // as T15 stores them
    const overrides = projectTargets(r.assignments, projects, [def]);
    return planGroups(s, p, ctx(overrides)).flatMap((o) => (o.kind === 'group' ? [[o.title, o.tabIds]] : []));
  };
  it('user rule "acme" ordered before the project rule → the PR stays in "acme"', () => {
    expect(titles(['user/acme', `${RID}/ticket`, `${RID}/pr`])).toEqual([['acme', [2]], ['ABC-1 · Login fails', [1]]]);
  });
  it('ordered after → the PR joins the project', () => {
    expect(titles([`${RID}/ticket`, `${RID}/pr`, 'user/acme'])).toEqual([['ABC-1 · Login fails', [1, 2]]]);
  });
});
