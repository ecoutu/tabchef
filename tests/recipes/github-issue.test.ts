// GitHub issue projects: the github-issue recipe. A GitHub issue tab creates one project per issue (`owner/repo#N`);
// a pull request joins it by its head branch (`fix/12-login`), else by the first issue GitHub says it closes. Three
// capability levels: Titles (issue tabs only), Page details (the branch from the PR page), Connections (the branch and
// the closing link from the API).
import { describe, expect, it, vi } from 'vitest';
import { compileProgram } from '../../src/core/lang/compile';
import { evaluateTab } from '../../src/core/lang/evaluate';
import { defaultConfig } from '../../src/core/config/defaults';
import { DEFAULT_BRANCH_PATTERN } from '../../src/core/keys/github-issue';
import { projectTargets, resolveProjects, type StickyMap } from '../../src/core/projects/resolve';
import { pickFields } from '../../src/core/sources/registry';
import { adapterKey } from '../../src/core/adapters';
import { PermissionsManager, type LevelStatus } from '../../src/engine/permissions';
import { ProgramCache } from '../../src/engine/program-cache';
import { SourceService } from '../../src/engine/sources';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import { checkFile } from '../../scripts/validate-recipes';
import { normalizeUrl } from '../../src/core/url/normalize';
import { programOf } from '../helpers/config';
import type { Config, Snapshot, TabSnap } from '../../src/core/types';
import type { Project } from '../../src/core/projects/types';
import type { Program, Recipe, TabFacts } from '../../src/core/lang/types';
import type { PrInfo } from '../../src/core/sources/types';

const RID = 'github-issue';
const body = () => builtinRecipes()[RID] as Recipe;
const rule = (r: 'issue' | 'pr') => body().rules.find((x) => x.id === r)!;

const NOW = Date.parse('2026-11-10T10:00:00Z');
const GH = 'https://github.com/*';
const ISSUE = 'https://github.com/acme/web/issues/12';
const ISSUE_TITLE = 'Fix login · Issue #12 · acme/web · GitHub';
const PR = 'https://github.com/acme/web/pull/40';
const GI = { allow: '{params.repos}', ignore: '{params.ignoredRepos}' };

const tab = (tid: number, url: string, title: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id: tid, windowId: 1, index: tid, url, title, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const snapOf = (...tabs: TabSnap[]): Snapshot => ({ tabs, groups: [], windows: [{ id: 1, type: 'normal', focused: true }] });
/** The defaults with github-issue on (with `params`), plus `also` on, and `order` as the rule priority. */
const config = (params: Record<string, unknown> = {}, o: { also?: string[]; order?: string[] } = {}): Config => ({
  ...defaultConfig(),
  recipes: defaultConfig().recipes.map((r) => (r.id === RID ? { ...r, enabled: true, params } : o.also?.includes(r.id) ? { ...r, enabled: true } : r)),
  order: o.order ?? [],
});
function program(params: Record<string, unknown> = {}, o: { also?: string[]; order?: string[] } = {}): Program {
  const { program: p, errors } = compileProgram(config(params, o), builtinRecipes());
  expect(errors).toEqual([]);
  return p;
}
type Facts = Record<number, Partial<TabFacts>>;
/** resolveProjects over `tabs`: tabId → project key. */
function keys(p: Program, tabs: TabSnap[], facts: Facts = {}, o: { projects?: Project[]; sticky?: StickyMap } = {}) {
  const r = resolveProjects({
    snap: snapOf(...tabs), program: p, facts: (tid) => facts[tid] ?? {}, projects: o.projects ?? [], knownPrefixes: new Set(),
    allowPrefixes: [], now: NOW, sticky: o.sticky ?? new Map(),
  });
  return { byTab: Object.fromEntries([...r.assignments].map(([t, a]) => [t, a.key])), r };
}
/** A PR tab's source facts for `ruleKey`, as SourceService hands them to rules: the API answer projected to the rule's fields. */
const prSource = (pr: Partial<PrInfo>, ruleKey = `${RID}/pr`): Partial<TabFacts> =>
  ({ source: { [ruleKey]: { data: pickFields(pr, rule('pr').source!.fields) } } });
const candidates = (p: Program, url: string, title: string, f: Partial<TabFacts> = {}) =>
  evaluateTab(p, { ...f, tab: tab(1, url, title) }, NOW).project;

describe('github-issue recipe: shape', () => {
  it('validates (npm run validate:recipes) and is disabled by default', () => {
    expect(checkFile(`src/recipes/builtin/${RID}.yaml`)).toEqual([]);
    expect(defaultConfig().recipes.find((r) => r.id === RID)?.enabled).toBe(false);
  });

  it('ships the plan params with help text', () => {
    const p = body().params!;
    expect(Object.keys(p)).toEqual(['branchPattern', 'repos', 'ignoredRepos', 'titleFormat', 'color']);
    expect(p.branchPattern).toEqual(expect.objectContaining({ type: 'regex', default: DEFAULT_BRANCH_PATTERN }));
    expect(p.repos).toEqual(expect.objectContaining({ type: 'string[]', default: [] }));
    expect(p.ignoredRepos).toEqual(expect.objectContaining({ type: 'string[]', default: [] }));
    expect(p.titleFormat).toEqual(expect.objectContaining({
      type: 'string', default: '{owner}/{repo}#{num} · {summary}',
      enum: ['{owner}/{repo}#{num}', '{owner}/{repo}#{num} · {summary}', '{repo}#{num}', '{repo}#{num} · {summary}', '#{num}', '#{num} · {summary}'],
    }));
    expect(p.titleFormat!.help).toMatch(/repositor.*owner/i);
    expect(p.color).toEqual(expect.objectContaining({ type: 'string', default: 'purple', enum: builtinRecipes()['jira-ticket-either']!.params!.color!.enum }));
    for (const d of Object.values(p)) {
      expect(d.label).toEqual(expect.any(String));
      expect(d.help).toEqual(expect.any(String));
    }
  });

  it('the project, the Projects view, the levels, and no conflicts with the Jira recipes (either way)', () => {
    const b = body();
    expect(b.project).toEqual({ key: '{key}', title: '{params.titleFormat}', color: '{params.color}', container: 'group', join: ['rules', 'manual'] });
    expect(b.views).toEqual([{ id: 'projects', tab: 'Projects', kind: 'projects', actions: [] }]);
    expect(b.levels!.map((l) => [l.id, l.label, l.rules])).toEqual([
      ['titles', 'Titles', ['issue']], ['page', 'Page details', ['issue', 'pr']], ['connections', 'Connections', ['issue', 'pr']],
    ]);
    expect(b.conflicts ?? []).toEqual([]);
    for (const j of ['jira-ticket-title', 'jira-ticket-branch', 'jira-ticket-either']) expect(builtinRecipes()[j]!.conflicts).not.toContain(RID);
    expect(b.rules.map((r) => r.name)).toEqual(['Issue tab', 'PR by branch or closing link']);
  });

  it('the issue rule', () => {
    const r = rule('issue');
    expect(r.needs).toEqual({ anyOf: [{ connections: ['github'] }, { hosts: [GH] }, {}] });
    expect(r.source).toEqual({
      connection: 'github', query: 'github.issue', args: { owner: '{owner}', repo: '{repo}', number: '{num}' },
      fields: { status: 'status', statusCategory: 'statusCategory', summary: 'summary' }, fallback: { adapter: 'github.issuePage' },
    });
    expect(r.match).toEqual({ url: 'github.com/:owner/:repo/issues/:num*' });
    expect(r.extract).toEqual({
      key: { from: 'url', githubIssue: GI },
      summary: { from: 'title', regex: '^(?<s>.+?) · Issue #\\d+ · ', group: 's' },
    });
    expect(r.actions).toEqual([{ assignProject: { key: '{key}', create: true } }]);
  });

  it("the pr rule: jira-ticket-either's pr source (same args: one shared cache entry) with the closing link", () => {
    const r = rule('pr');
    const jira = builtinRecipes()['jira-ticket-either']!.rules.find((x) => x.id === 'pr')!;
    expect(r.needs).toEqual({ anyOf: [{ connections: ['github'] }, { hosts: [GH] }] });
    expect(r.match).toEqual(jira.match);
    expect(r.source).toEqual({ ...jira.source, fields: { headRefName: 'headRefName', state: 'state', closes: 'closingIssues.0' } });
    expect(r.extract).toEqual({
      branchIssue: { from: 'source.headRefName', githubIssue: { pattern: '{params.branchPattern}', ...GI } },
      linkIssue: { from: 'source.closes', githubIssue: GI },
    });
    expect(r.actions).toEqual([{ assignProject: { key: '{branchIssue}', fallbackKey: '{linkIssue}', create: true } }]);
  });
});

describe('github-issue: Titles (nothing granted)', () => {
  it('an issue tab: key from the URL (lower-cased), summary from the title; it creates', () => {
    expect(candidates(program(), ISSUE, ISSUE_TITLE)).toEqual([
      { key: 'acme/web#12', ruleKey: `${RID}/issue`, index: expect.any(Number), create: true, summary: 'Fix login' },
    ]);
    expect(candidates(program(), 'https://github.com/Acme/Web/issues/12', 'x')?.map((c) => c.key)).toEqual(['acme/web#12']);
  });

  it('/issues/new, the issue list and an issue sub-page give no candidate', () => {
    expect(candidates(program(), 'https://github.com/acme/web/issues/new', 'New Issue · acme/web')).toBeUndefined();
    expect(candidates(program(), 'https://github.com/acme/web/issues?q=is%3Aopen', 'Issues · acme/web')).toBeUndefined();
    expect(candidates(program(), 'https://github.com/acme/web/issues/12/linked_closing_reference', 'Linked · acme/web')).toBeUndefined();
  });

  it('a PR tab gives nothing: the pr rule is paused, and its title alone names no issue', async () => {
    const s = await levelsSetup();
    expect([...s.pm.paused()]).toEqual([`${RID}/pr`]);
    expect(await s.levels()).toEqual(['Titles: available', 'Page details: locked, needs github.com', 'Connections: locked, needs GitHub connection']);
    expect(keys(await s.programs.get(), [tab(1, ISSUE, ISSUE_TITLE), tab(2, PR, 'Fix login (#12)')]).byTab).toEqual({ 1: 'acme/web#12' });
  });
});

/** A PermissionsManager + ProgramCache over the real recipe, with `granted` and the GitHub connection's state. */
async function levelsSetup(granted: string[] = [], github: 'ok' | 'not-configured' = 'not-configured') {
  const port = new FakeBrowserPort();
  for (const g of granted) port.granted.add(g);
  const cfg = config();
  const holder: { pm?: PermissionsManager } = {};
  const programs = new ProgramCache(async () => cfg, { builtins: builtinRecipes(), paused: () => holder.pm?.paused() ?? [], warn: () => {} });
  const pm = new PermissionsManager(port, () => programs.get(), { register: async () => [], unregister: async () => [], inject: async () => {} }, {
    connections: async () => [{ id: 'github', label: 'GitHub', state: github }],
  });
  holder.pm = pm;
  await pm.onChanged();
  const levelText = (l: LevelStatus) => (l.available ? `${l.label}: available` : `${l.label}: locked, needs ${l.needs}`);
  return { port, pm, programs, levels: async () => (await pm.status())[RID]!.levels!.map(levelText) };
}

describe('github-issue: Page details (github.com granted, the PR page read)', () => {
  /** Page facts of a PR tab whose head ref reads `headRef` (the github.prPage adapter's branch text). */
  const prPage = (headRef: string) => ({
    texts: [], formEdited: false,
    extracts: { [adapterKey('github.prPage', 'state')]: 'Open', [adapterKey('github.prPage', 'branch')]: headRef },
  });
  async function run(tabs: TabSnap[], pages: Record<number, ReturnType<typeof prPage>>) {
    const s = await levelsSetup([GH, 'scripting']);
    const p = await s.programs.get();
    const snap = snapOf(...tabs);
    const svc = new SourceService({
      conn: { fetch: vi.fn(), status: async () => [], defs: async () => [] },
      getProgram: () => p, levelFor: (k) => s.pm.levelFor(k),
      port: { snapshot: async () => structuredClone(snap), hasPermission: (q) => s.port.hasPermission(q) },
      facts: { get: (tid) => pages[tid] }, local: { get: async () => ({}), set: async () => {} }, now: () => NOW, onUpdated: () => {},
    });
    await svc.refresh('manual');
    const facts: Facts = Object.fromEntries(tabs.map((t) => [t.id, { ...(pages[t.id] && { page: pages[t.id] }), ...(svc.factsFor(t.id) && { source: svc.factsFor(t.id) }) }]));
    return { s, k: keys(p, tabs, facts) };
  }

  it('the branch fix/12-login on the PR page → acme/web#12, with its issue tab', async () => {
    const { s, k } = await run([tab(1, ISSUE, ISSUE_TITLE), tab(2, PR, 'Fix the login form')], { 2: prPage('fix/12-login') });
    expect(await s.pm.levelFor(`${RID}/pr`)).toBe('page');
    expect(await s.levels()).toEqual(['Titles: available', 'Page details: available', 'Connections: locked, needs GitHub connection']);
    expect(k.byTab).toEqual({ 1: 'acme/web#12', 2: 'acme/web#12' });
  });

  it('a PR alone starts its issue project from its branch', async () => {
    const { k } = await run([tab(2, PR, 'Fix the login form')], { 2: prPage('acme/web:fix/12-login') });
    expect(k.byTab).toEqual({ 2: 'acme/web#12' });
    expect(k.r.created.map((p) => p.id)).toEqual([`${RID}:acme/web#12`]);
  });

  it("Review Focus 4: a fork's head ref someone:fix/12-x maps to the PR's own repo (acme/web#12), never someone/web#12", async () => {
    const { k } = await run([tab(2, PR, 'Fix the login form')], { 2: prPage('someone:fix/12-x') });
    expect(k.byTab).toEqual({ 2: 'acme/web#12' });
    // The API's headRefName for a fork PR is the bare branch name: the same key.
    expect(keys(program(), [tab(2, PR, 'x')], { 2: prSource({ headRefName: 'fix/12-x' }) }).byTab).toEqual({ 2: 'acme/web#12' });
  });

  it('a branch that names no issue joins nothing', async () => {
    const { k } = await run([tab(1, ISSUE, ISSUE_TITLE), tab(2, PR, 'Fix login')], { 2: prPage('login-fix') });
    expect(k.byTab).toEqual({ 1: 'acme/web#12' });
  });
});

describe('github-issue: Connections (the branch and the closing link from the API)', () => {
  it("a branch that names no issue falls back to the first issue GitHub says it closes (another repo's)", () => {
    const c = candidates(program(), PR, 'x', prSource({ headRefName: 'main', state: 'open', closingIssues: ['acme/api#7', 'acme/web#3'] }));
    expect(c?.map((x) => [x.key, x.create])).toEqual([['acme/api#7', true]]);
  });

  it('both present and different: the branch first, the link as fallback', () => {
    const c = candidates(program(), PR, 'x', prSource({ headRefName: 'fix/12-login', closingIssues: ['acme/api#7'] }));
    expect(c?.map((x) => x.key)).toEqual(['acme/web#12', 'acme/api#7']);
    expect(keys(program(), [tab(2, PR, 'x')], { 2: prSource({ headRefName: 'fix/12-login', closingIssues: ['acme/api#7'] }) }).byTab).toEqual({ 2: 'acme/web#12' });
  });

  it('both naming the same issue: one candidate', () => {
    expect(candidates(program(), PR, 'x', prSource({ headRefName: 'fix/12', closingIssues: ['acme/web#12'] }))?.map((x) => x.key)).toEqual(['acme/web#12']);
  });

  it('a custom branchPattern', () => {
    const p = program({ branchPattern: '^(?<n>\\d+)-' });
    expect(candidates(p, PR, 'x', prSource({ headRefName: '12-login' }))?.map((x) => x.key)).toEqual(['acme/web#12']);
  });
});

describe('github-issue: repository scope', () => {
  it("ignoredRepos ['acme/*']: neither an issue tab nor a PR in acme gives a candidate", () => {
    const p = program({ ignoredRepos: ['acme/*'] });
    expect(candidates(p, ISSUE, ISSUE_TITLE)).toBeUndefined();
    expect(candidates(p, PR, 'x', prSource({ headRefName: 'fix/12', closingIssues: ['acme/api#7'] }))).toBeUndefined();
  });

  it("repos ['acme/web']: an other/x issue tab gives none, acme/web's still does", () => {
    const p = program({ repos: ['acme/web'] });
    expect(candidates(p, 'https://github.com/other/x/issues/3', 'y')).toBeUndefined();
    expect(candidates(p, ISSUE, ISSUE_TITLE)?.map((c) => c.key)).toEqual(['acme/web#12']);
    // A PR in acme/web whose closing link is in another repo: only the allowed issue counts.
    expect(candidates(p, PR, 'x', prSource({ headRefName: 'main', closingIssues: ['other/x#3'] }))).toBeUndefined();
  });
});

describe('github-issue: dedupe of issue links', () => {
  const key = (u: string, p = program()) => normalizeUrl(u, p.dedupe)?.key;

  it('a query (notifications, timeline pages) and owner/repo letter case fold into the issue URL', () => {
    for (const u of [
      `${ISSUE}?notification_referrer_id=NT_kwDOABC`, `${ISSUE}?timeline_page=1`, `${ISSUE}?a=1&b=2`, `${ISSUE}/?timeline_page=1`,
      'https://github.com/ACME/Web/issues/12', 'https://github.com/Acme/WEB/issues/12?notification_referrer_id=x', 'http://github.com/acme/web/issues/12',
    ]) expect(key(u), u).toBe(u.startsWith('http:') ? 'http://github.com/acme/web/issues/12' : ISSUE);
  });

  it('the fragment and trailing slash are handled as before', () => {
    expect(key(`${ISSUE}#issuecomment-123`)).toBe(ISSUE);
    expect(key(`${ISSUE}/`)).toBe(ISSUE);
    expect(normalizeUrl(`https://github.com/ACME/web/issues/12?x=1#issuecomment-1`, program().dedupe)?.fragment).toBe('issuecomment-1');
  });

  it('another issue, another repository, or a page that is not an issue keeps its own key', () => {
    expect(key('https://github.com/acme/web/issues/13?x=1')).toBe('https://github.com/acme/web/issues/13');
    expect(key('https://github.com/acme/api/issues/12')).not.toBe(ISSUE);
    for (const u of [
      'https://github.com/Acme/Web/issues?q=is%3Aopen', 'https://github.com/Acme/Web/issues/new?title=x', 'https://github.com/Acme/Web/pull/12?x=1',
      'https://github.com/Acme/Web/issues/12/linked_closing_reference?x=1', 'https://github.com/Acme/Web', 'https://example.com/Acme/Web/issues/12?x=1',
      'https://evilgithub.com/Acme/Web/issues/12?x=1', 'https://gist.github.com/Acme/Web/issues/12?x=1',
    ]) expect(key(u), u).toBe(normalizeUrl(u, programOf(defaultConfig()).dedupe)?.key);
  });

  it('with the recipe off, a query or letter case still makes another tab', () => {
    const off = programOf(defaultConfig());
    expect(key(`${ISSUE}?timeline_page=1`, off)).not.toBe(key(ISSUE, off));
    expect(key('https://github.com/ACME/web/issues/12', off)).not.toBe(key(ISSUE, off));
  });
});

describe('github-issue: resolveProjects end to end', () => {
  it('a PR tab alone creates acme/web#12; its issue tab opened later joins the same project', () => {
    const p = program();
    const prTab = tab(2, PR, 'Fix the login form');
    const facts: Facts = { 2: prSource({ headRefName: 'fix/12-login', state: 'open' }) };
    const first = keys(p, [prTab], facts);
    expect(first.byTab).toEqual({ 2: 'acme/web#12' });
    expect(first.r.created.map((x) => x.id)).toEqual([`${RID}:acme/web#12`]);
    const second = keys(p, [prTab, tab(1, ISSUE, ISSUE_TITLE)], facts, { projects: first.r.created, sticky: first.r.sticky });
    expect(second.byTab).toEqual({ 1: 'acme/web#12', 2: 'acme/web#12' });
    expect(second.r.created).toEqual([]);
  });

  it('the issue tab, then a PR closing it (branch main): one project, summary from the issue title', () => {
    const { byTab, r } = keys(program(), [tab(1, ISSUE, ISSUE_TITLE), tab(2, PR, 'x')], { 2: prSource({ headRefName: 'main', closingIssues: ['acme/web#12'] }) });
    expect(byTab).toEqual({ 1: 'acme/web#12', 2: 'acme/web#12' });
    expect([...r.summaries]).toEqual([[`${RID}:acme/web#12`, 'Fix login']]);
  });
});

describe('github-issue: group titles', () => {
  /** The group title of each tab, with the recipe's titleFormat `format` (the default when undefined). */
  function titles(format: string | undefined, tabs: TabSnap[]) {
    const p = program(format === undefined ? {} : { titleFormat: format });
    const { r } = keys(p, tabs);
    const projects = r.created.map((x) => ({ ...x, ...(r.summaries.has(x.id) && { summary: r.summaries.get(x.id) }) }));
    return Object.fromEntries([...projectTargets(r.assignments, projects, p.projects ?? [])].map(([t, g]) => [t, g.title]));
  }
  const other = tab(2, 'https://github.com/other/web/issues/12', 'Crash · Issue #12 · other/web · GitHub');

  it('the default is owner/repo#N · summary, owner/repo#N while the summary is unknown; it never needs to tell two apart', () => {
    expect(titles(undefined, [tab(1, ISSUE, ISSUE_TITLE)])).toEqual({ 1: 'acme/web#12 · Fix login' });
    expect(titles(undefined, [tab(1, ISSUE, 'x')])).toEqual({ 1: 'acme/web#12' });
    expect(titles(undefined, [tab(1, ISSUE, ISSUE_TITLE), other])).toEqual({ 1: 'acme/web#12 · Fix login', 2: 'other/web#12 · Crash' });
    expect(titles('{owner}/{repo}#{num}', [tab(1, ISSUE, ISSUE_TITLE), other])).toEqual({ 1: 'acme/web#12', 2: 'other/web#12' });
  });
  it('repo#N alone; two issues that would share it add the owner', () => {
    expect(titles('{repo}#{num}', [tab(1, ISSUE, ISSUE_TITLE)])).toEqual({ 1: 'web#12' });
    expect(titles('{repo}#{num}', [tab(1, ISSUE, ISSUE_TITLE), other])).toEqual({ 1: 'acme/web#12', 2: 'other/web#12' });
  });
  it('the other formats: repo#N · summary, #N, #N · summary', () => {
    expect(titles('{repo}#{num} · {summary}', [tab(1, ISSUE, ISSUE_TITLE)])).toEqual({ 1: 'web#12 · Fix login' });
    expect(titles('#{num}', [tab(1, ISSUE, ISSUE_TITLE)])).toEqual({ 1: '#12' });
    expect(titles('#{num} · {summary}', [tab(1, ISSUE, ISSUE_TITLE), other])).toEqual({ 1: 'acme/web#12 · Fix login', 2: 'other/web#12 · Crash' });
  });
});

describe('github-issue: coexistence with jira-ticket-either (rule priority decides)', () => {
  const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
  const tabs = [tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'ABC-1 fix')];
  const facts = (): Facts => ({
    2: { source: { ...prSource({ headRefName: 'fix/12' }).source, ...prSource({ headRefName: 'fix/12' }, 'jira-ticket-either/pr').source } },
  });
  const run = (order: string[]) => keys(program({}, { also: ['jira-ticket-either'], order }), tabs, facts()).byTab;

  it('both on compile with no conflict', () => {
    expect(program({}, { also: ['jira-ticket-either'] }).rules.map((r) => r.key)).toEqual(expect.arrayContaining([`${RID}/pr`, 'jira-ticket-either/pr']));
  });
  it("the Jira rule first: the PR titled ABC-1 joins ABC-1", () => {
    expect(run(['jira-ticket-either/pr', `${RID}/pr`])[2]).toBe('ABC-1');
  });
  it('the GitHub issue rule first: the PR on branch fix/12 joins acme/web#12', () => {
    expect(run([`${RID}/pr`, 'jira-ticket-either/pr'])[2]).toBe('acme/web#12');
  });
});
