import { describe, expect, it } from 'vitest';
import { compileProgram } from '../../../src/core/lang/compile';
import { defaultConfig } from '../../../src/core/config/defaults';
import { planGroups, type PlanContext } from '../../../src/core/group/plan';
import {
  issueTitlePrefixes, projectGroupTitle, projectTargets, resolveProjects, titleBelongsToProject, type ResolveInput, type StickyMap,
} from '../../../src/core/projects/resolve';
import type { Project, ProjectDef } from '../../../src/core/projects/types';
import type { Program, Recipe, Rule, TabFacts } from '../../../src/core/lang/types';
import type { Config, Snapshot, TabSnap } from '../../../src/core/types';
import { builtinRecipes } from '../../../src/recipes/load';

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
    expect(first.sticky.get(2)).toEqual({ projectId: `${RID}:ABC-1`, url: PR, ruleKey: `${RID}/pr`, index: 1, sig: expect.any(String) });
    const projects = first.created;

    const loading = resolve(snapOf(ticket, tab(2, PR, 'github.com/acme/api/pull/5')), { projects, sticky: first.sticky });
    expect(loading.assignments.get(2)).toMatchObject({ projectId: `${RID}:ABC-1`, via: 'rule' });
    expect(loading.sticky.get(2)).toEqual(first.sticky.get(2));

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
    expect(r.sticky.get(2)).toEqual({ projectId: `${RID}:ABC-1`, url: PR, ruleKey: `${RID}/pr`, index: 1, sig: expect.any(String) });
  });
  it('a sticky entry for a project that no longer exists is dropped', () => {
    const sticky: StickyMap = new Map([[2, { projectId: `${RID}:ABC-1`, url: PR }]]);
    expect(resolve(snapOf(tab(2, PR, 'loading')), { sticky }).assignments.size).toBe(0);
  });
});

describe('resolveProjects: a settings change that stops a sticky tab\'s rule from matching', () => {
  // The builtin jira-ticket-title recipe; the ticket tab (key from its URL) joins ABC-1, then the config changes while
  // the tab stays at the same URL.
  const prog = (o: { params?: Record<string, unknown>; ruleEnabled?: Record<string, boolean> } = {}): Program => {
    const c: Config = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === RID ? { ...r, enabled: true, ...o } : r)) };
    const { program: p, errors } = compileProgram(c, builtinRecipes());
    expect(errors).toEqual([]);
    return p;
  };
  const ticket = tab(1, TICKET, '[ABC-1] Login fails - Jira');
  const pr = (title: string) => tab(2, PR, title);
  /** Resolves `tabs` with `first`, then again with `next` and the sticky map and projects of the first pass. */
  function change(first: Program, next: Program, tabs: TabSnap[], again: TabSnap[] = tabs) {
    const a = resolve(snapOf(...tabs), { program: first });
    const b = resolve(snapOf(...again), { program: next, projects: a.created, sticky: a.sticky });
    return { a, b, keys: Object.fromEntries([...b.assignments].map(([t, x]) => [t, x.key])) };
  }

  it('S1. the ticket rule turned off: the ticket tab leaves ABC-1 (the recipe\'s other rule does not hold it)', () => {
    const { a, keys } = change(prog(), prog({ ruleEnabled: { ticket: false } }), [ticket]);
    expect(a.assignments.get(1)?.key).toBe('ABC-1');
    expect(keys).toEqual({});
  });

  it('S2. Your Jira project keys narrowed to XYZ: the ABC-1 ticket tab leaves', () => {
    expect(change(prog(), prog({ params: { projectPrefixes: ['XYZ'] } }), [ticket]).keys).toEqual({});
  });

  it('S3. ABC added to the ignored prefixes: the ABC-1 ticket tab leaves', () => {
    const ignored = builtinRecipes()[RID]!.params!.ignoredPrefixes!.default as string[];
    expect(change(prog(), prog({ params: { ignoredPrefixes: [...ignored, 'ABC'] } }), [ticket]).keys).toEqual({});
  });

  it('a changed rule that still matches keeps the tab, with the new rule\'s signature', () => {
    const { a, b, keys } = change(prog(), prog({ params: { projectPrefixes: ['ABC'] } }), [ticket]);
    expect(keys).toEqual({ 1: 'ABC-1' });
    expect(b.sticky.get(1)?.sig).not.toBe(a.sticky.get(1)?.sig);
  });

  it('a change no rule uses (the group color) keeps a loading PR whose title lost the key', () => {
    const { keys } = change(prog(), prog({ params: { color: 'red' } }), [ticket, pr('ABC-1: fix login')], [ticket, pr('github.com/acme/api/pull/5')]);
    expect(keys).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });

  it('a loading PR whose rule changed leaves until its title names the key again', () => {
    const next = prog({ params: { keyPattern: '[A-Z]+-\\d+' } });
    const { b, keys } = change(prog(), next, [ticket, pr('ABC-1: fix login')], [ticket, pr('github.com/acme/api/pull/5')]);
    expect(keys).toEqual({ 1: 'ABC-1' });
    const loaded = resolve(snapOf(ticket, pr('ABC-1: fix login')), { program: next, projects: [project('ABC-1')], sticky: b.sticky });
    expect(loaded.assignments.get(2)?.key).toBe('ABC-1');
  });

  it('an entry stored without a signature (an older build) keeps today\'s behaviour: the recipe still holds the tab', () => {
    const sticky: StickyMap = new Map([[1, { projectId: `${RID}:ABC-1`, url: TICKET, ruleKey: `${RID}/ticket`, index: 0 }]]);
    const r = resolve(snapOf(ticket), { program: prog({ ruleEnabled: { ticket: false } }), projects: [project('ABC-1')], sticky });
    expect(r.assignments.get(1)?.key).toBe('ABC-1');
    expect(r.sticky.get(1)?.sig).toEqual(expect.any(String)); // re-stamped: the next change is checked
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
  it('a Manual-only project (join: [manual]) is not strict and unordered; one rules can assign stays strict', () => {
    const a = new Map([[2, { projectId: `${RID}:ABC-1`, key: 'ABC-1', via: 'manual' as const, index: -1 }]]);
    const manualOnly = projectTargets(a, [project('ABC-1')], [{ ...def, join: ['manual'] }]).get(2)!;
    expect(manualOnly).toMatchObject({ strict: false, unordered: true });
    const ruled = projectTargets(a, [project('ABC-1')], [def]).get(2)!;
    expect(ruled.strict).toBe(true);
    expect(ruled).not.toHaveProperty('unordered');
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

describe('GitHub issue projects: #N titles, disambiguated when two would collide', () => {
  const GH = 'github-issue';
  const ghDef: ProjectDef = { ...def, recipeId: GH, title: '#{num} · {summary}', color: 'purple' };
  const issue = (key: string, o: Partial<Project> = {}): Project => ({
    id: `${GH}:${key}`, recipeId: GH, key, createdAt: 1, updatedAt: 1, manual: [], excluded: [], linked: [], ...o,
  });
  const assign = (...keys: string[]) => new Map(keys.map((k, i) => [i + 1, { projectId: `${GH}:${k}`, key: k, via: 'rule' as const, ruleKey: `${GH}/issue`, index: 0 }]));

  it('projectGroupTitle: #N · summary, or #N without one; {owner}/{repo}/{num} are template vars', () => {
    expect(projectGroupTitle(ghDef, issue('acme/web#12', { summary: 'Fix login' }))).toBe('#12 · Fix login');
    expect(projectGroupTitle(ghDef, issue('acme/web#12'))).toBe('#12');
    expect(projectGroupTitle({ ...ghDef, title: '{owner}/{repo} {num}' }, issue('acme/web#12', { summary: 'x' }))).toBe('acme/web 12');
    expect(projectGroupTitle(def, project('ABC-1'))).toBe('ABC-1'); // Jira unchanged
  });
  it('titleBelongsToProject: an issue key matches #N (or the prefix given), never another number', () => {
    expect(titleBelongsToProject('#12', 'acme/web#12')).toBe(true);
    expect(titleBelongsToProject('#12 · Fix login', 'acme/web#12')).toBe(true);
    expect(titleBelongsToProject('#123', 'acme/web#12')).toBe(false);
    expect(titleBelongsToProject('acme/web#12', 'acme/web#12')).toBe(true);
    expect(titleBelongsToProject('#12', 'acme/web#12', 'web#12')).toBe(false);
    expect(titleBelongsToProject('web#12 · x', 'acme/web#12', 'web#12')).toBe(true);
  });
  it('issueTitlePrefixes: #N alone; repo#N when the number collides; owner/repo#N when the repo name does too', () => {
    const ps = [issue('acme/a#12'), issue('acme/b#12'), issue('other/b#12'), issue('acme/a#7'), project('ABC-1')];
    expect(issueTitlePrefixes(ps)).toEqual(new Map([
      [`${GH}:acme/a#12`, 'a#12'], [`${GH}:acme/b#12`, 'acme/b#12'], [`${GH}:other/b#12`, 'other/b#12'], [`${GH}:acme/a#7`, '#7'],
    ]));
    expect(projectGroupTitle(ghDef, issue('acme/a#12', { summary: 'Fix login' }), issueTitlePrefixes(ps))).toBe('a#12 · Fix login');
    expect(projectGroupTitle(ghDef, issue('acme/a#12'), issueTitlePrefixes(ps))).toBe('a#12');
  });
  it('Review Focus 2: projectTargets gives acme/a#12 and acme/b#12 their own titles; neither accepts a bare #12', () => {
    const t = projectTargets(assign('acme/a#12', 'acme/b#12'), [issue('acme/a#12'), issue('acme/b#12')], [ghDef]);
    expect([t.get(1)?.title, t.get(2)?.title]).toEqual(['a#12', 'b#12']);
    expect(t.get(1)?.titleMatches?.('#12')).toBe(false);
    expect(t.get(1)?.titleMatches?.('a#12')).toBe(true);
    expect(t.get(1)?.titleMatches?.('acme/a#12 · x')).toBe(true);
    expect(t.get(1)?.titleMatches?.('b#12')).toBe(false);
    // Only projects with tabs count: alone, acme/a#12 is #12 again, and adopts its a#12 group.
    const alone = projectTargets(assign('acme/a#12'), [issue('acme/a#12'), issue('acme/b#12')], [ghDef]).get(1)!;
    expect(alone.title).toBe('#12');
    expect(alone.titleMatches?.('a#12')).toBe(true);
    expect(alone.titleMatches?.('b#12')).toBe(false);
  });

  describe('a {repo}#{num} title template: base repo#N, owner/repo#N on a collision', () => {
    const repoDef: ProjectDef = { ...ghDef, title: '{repo}#{num} · {summary}' };
    it('projectGroupTitle: repo#N with no summary (never the full key), repo#N · summary with one', () => {
      expect(projectGroupTitle(repoDef, issue('acme/web#12'))).toBe('web#12');
      expect(projectGroupTitle({ ...repoDef, title: '{repo}#{num}' }, issue('acme/web#12', { summary: 'x' }))).toBe('web#12');
      expect(projectGroupTitle(repoDef, issue('acme/web#12', { summary: 'Fix login' }))).toBe('web#12 · Fix login');
    });
    it('projectTargets: acme/web#12 alone → web#12; never takes a bare #12', () => {
      const t = projectTargets(assign('acme/web#12'), [issue('acme/web#12')], [repoDef]).get(1)!;
      expect(t.title).toBe('web#12');
      expect(t.titleMatches?.('web#12 · Fix login')).toBe(true);
      expect(t.titleMatches?.('acme/web#12')).toBe(true);
      expect(t.titleMatches?.('#12')).toBe(false);
    });
    it('acme/web#12 and acme/api#12 keep web#12 and api#12 (no collision)', () => {
      const t = projectTargets(assign('acme/web#12', 'acme/api#12'), [issue('acme/web#12'), issue('acme/api#12')], [repoDef]);
      expect([t.get(1)?.title, t.get(2)?.title]).toEqual(['web#12', 'api#12']);
    });
    it('acme/web#12 and other/web#12 → acme/web#12 and other/web#12; neither accepts web#12; alone again → web#12, adopting its old group', () => {
      const ps = [issue('acme/web#12', { summary: 'Fix login' }), issue('other/web#12')];
      const t = projectTargets(assign('acme/web#12', 'other/web#12'), ps, [repoDef]);
      expect([t.get(1)?.title, t.get(2)?.title]).toEqual(['acme/web#12 · Fix login', 'other/web#12']);
      expect(t.get(1)?.titleMatches?.('web#12')).toBe(false);
      expect(t.get(1)?.titleMatches?.('other/web#12')).toBe(false);
      const alone = projectTargets(assign('acme/web#12'), ps, [repoDef]).get(1)!;
      expect(alone.title).toBe('web#12 · Fix login');
      expect(alone.titleMatches?.('acme/web#12 · Fix login')).toBe(true);
    });
    it('Jira keys are unchanged', () => {
      expect(projectGroupTitle(def, project('ABC-1'))).toBe('ABC-1');
      expect(projectGroupTitle(def, project('ABC-1', { summary: 'x' }))).toBe('ABC-1 · x');
    });
  });

  describe('a {owner}/{repo}#{num} title template: always the full key, never escalated', () => {
    const ownerDef: ProjectDef = { ...ghDef, title: '{owner}/{repo}#{num} · {summary}' };
    it('projectGroupTitle: owner/repo#N with no summary, owner/repo#N · summary with one', () => {
      expect(projectGroupTitle(ownerDef, issue('acme/web#12'))).toBe('acme/web#12');
      expect(projectGroupTitle(ownerDef, issue('acme/web#12', { summary: 'Fix login' }))).toBe('acme/web#12 · Fix login');
      expect(projectGroupTitle({ ...ownerDef, title: '{owner}/{repo}#{num}' }, issue('acme/web#12', { summary: 'x' }))).toBe('acme/web#12');
    });
    it('projectTargets: acme/web#12 and other/web#12 keep their keys; neither takes web#12 or #12', () => {
      const ps = [issue('acme/web#12', { summary: 'Fix login' }), issue('other/web#12')];
      const t = projectTargets(assign('acme/web#12', 'other/web#12'), ps, [ownerDef]);
      expect([t.get(1)?.title, t.get(2)?.title]).toEqual(['acme/web#12 · Fix login', 'other/web#12']);
      const alone = projectTargets(assign('acme/web#12'), ps, [ownerDef]).get(1)!;
      expect(alone.title).toBe('acme/web#12 · Fix login');
      for (const g of ['#12', 'web#12', 'web#12 · Fix login']) expect(alone.titleMatches?.(g)).toBe(false);
      expect(alone.titleMatches?.('acme/web#12')).toBe(true);
    });
  });
});
