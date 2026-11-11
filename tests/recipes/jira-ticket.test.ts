// Jira ticket projects (M3 T16): the jira-ticket-title / -branch / -either recipes. A Jira ticket tab creates one project
// per issue key; GitHub PR tabs join it by title, by head branch, or either. Three capability levels: Titles (nothing
// granted), Page details (host access: page reads), Connections (the APIs).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compileProgram } from '../../src/core/lang/compile';
import { evaluateTab } from '../../src/core/lang/evaluate';
import { normalizeUrl } from '../../src/core/url/normalize';
import { compilePattern } from '../../src/core/match/pattern';
import { defaultConfig } from '../../src/core/config/defaults';
import { DEFAULT_IGNORED_PREFIXES, DEFAULT_KEY_PATTERN } from '../../src/core/keys/jira-key';
import { resolveProjects } from '../../src/core/projects/resolve';
import { adapterKey } from '../../src/core/adapters';
import { createHandler, configRev, type HandlerDeps } from '../../src/engine/messages';
import { PermissionsManager, type LevelStatus } from '../../src/engine/permissions';
import { ProgramCache } from '../../src/engine/program-cache';
import { ProjectService, ProjectStore } from '../../src/engine/projects';
import { Reconciler } from '../../src/engine/reconciler';
import { SourceService } from '../../src/engine/sources';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { buildProjectCards } from '../../src/ui/projects-model';
import { withRecipe } from '../../src/ui/recipes-model';
import { builtinRecipes } from '../../src/recipes/load';
import { checkFile } from '../../scripts/validate-recipes';
import type { Config, RecipeRef, Snapshot, TabSnap } from '../../src/core/types';
import type { Program, Recipe, TabFacts } from '../../src/core/lang/types';
import type { ConnectionState } from '../../src/core/connections/types';
import type { JiraIssue, PrInfo, SourceEntry } from '../../src/core/sources/types';

const VARIANTS = ['title', 'branch', 'either'] as const;
type Variant = (typeof VARIANTS)[number];
const id = (v: Variant) => `jira-ticket-${v}`;
const body = (v: Variant) => builtinRecipes()[id(v)] as Recipe;
const rule = (v: Variant, r: 'ticket' | 'pr') => body(v).rules.find((x) => x.id === r)!;

const NOW = Date.parse('2026-11-02T10:00:00Z');
const GH = 'https://github.com/*';
const JIRA = 'https://*.atlassian.net/*';
const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const PR = 'https://github.com/acme/api/pull/5';
const PR2 = 'https://github.com/acme/web/pull/9';
const JK = { pattern: '{params.keyPattern}', allow: '{params.projectPrefixes}', ignore: '{params.ignoredPrefixes}' };

const tab = (tid: number, url: string, title: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id: tid, windowId: 1, index: tid, url, title, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const snapOf = (...tabs: TabSnap[]): Snapshot => ({ tabs, groups: [], windows: [{ id: 1, type: 'normal', focused: true }] });
const config = (v: Variant, params: Record<string, unknown> = {}): Config => ({
  ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === id(v) ? { ...r, enabled: true, params } : r)),
});
function program(v: Variant, params: Record<string, unknown> = {}, paused?: Set<string>): Program {
  const { program: p, errors } = compileProgram(config(v, params), builtinRecipes(), paused ? { paused } : {});
  expect(errors).toEqual([]);
  return p;
}
type Facts = Record<number, Partial<TabFacts>>;
/** resolveProjects over `tabs`: tabId → project key. */
function keys(p: Program, tabs: TabSnap[], facts: Facts = {}, o: { allow?: string[] } = {}) {
  const r = resolveProjects({
    snap: snapOf(...tabs), program: p, facts: (tid) => facts[tid] ?? {}, projects: [], knownPrefixes: new Set(),
    allowPrefixes: o.allow ?? [], now: NOW, sticky: new Map(),
  });
  return { byTab: Object.fromEntries([...r.assignments].map(([t, a]) => [t, a.key])), r };
}
const prSource = (v: Variant, data: Record<string, unknown>, o: { stale?: boolean } = {}): Partial<TabFacts> =>
  ({ source: { [`${id(v)}/pr`]: { data, ...o } } });

describe('jira-ticket recipes: shape', () => {
  it('validate (npm run validate:recipes) and are all disabled by default', () => {
    for (const v of VARIANTS) {
      expect(checkFile(`src/recipes/builtin/${id(v)}.yaml`)).toEqual([]);
      expect(defaultConfig().recipes.find((r) => r.id === id(v))?.enabled).toBe(false);
    }
  });

  it('ship the plan params with help text', () => {
    const p = body('title').params!;
    expect(Object.keys(p)).toEqual(['jiraSite', 'keyPattern', 'projectPrefixes', 'ignoredPrefixes', 'titleFormat', 'color', 'githubOrgs']);
    expect(p.jiraSite).toEqual(expect.objectContaining({ type: 'string', default: '*.atlassian.net' }));
    expect(p.keyPattern).toEqual(expect.objectContaining({ type: 'regex', default: DEFAULT_KEY_PATTERN }));
    expect(p.projectPrefixes).toEqual(expect.objectContaining({ type: 'string[]', default: [] }));
    expect(p.ignoredPrefixes).toEqual(expect.objectContaining({ type: 'string[]', default: DEFAULT_IGNORED_PREFIXES }));
    expect(p.titleFormat).toEqual(expect.objectContaining({ type: 'string', default: '{key}', enum: ['{key}', '{key} · {summary}'] }));
    expect(p.color).toEqual(expect.objectContaining({ type: 'string', default: 'blue' }));
    expect(p.githubOrgs).toEqual(expect.objectContaining({ type: 'string[]', default: [] }));
    for (const d of Object.values(p)) expect(d.help).toEqual(expect.any(String));
  });

  it('the project, the Projects view and the ticket rule', () => {
    const b = body('title');
    expect(b.project).toEqual({ key: '{key}', title: '{params.titleFormat}', color: '{params.color}', container: 'group', join: ['rules', 'manual'] });
    expect(b.views).toEqual([{ id: 'projects', tab: 'Projects', kind: 'projects', actions: [] }]);
    const t = rule('title', 'ticket');
    expect(t.match).toEqual({ any: [{ url: '{params.jiraSite}/browse/*' }, { url: '{params.jiraSite}/*selectedIssue=*' }] });
    expect(t.extract).toEqual({
      key: { from: 'url', jiraKey: JK },
      summary: { from: 'title', regex: '^\\[[^\\]]+\\]\\s*(?<s>.+?)\\s*-\\s*Jira$', group: 's' },
    });
    expect(t.source).toEqual({
      connection: 'jira', query: 'jira.issue', args: { key: '{key}' },
      fields: { status: 'status', statusCategory: 'statusCategory', summary: 'summary' }, fallback: { adapter: 'jira.issuePage' },
    });
    expect(t.needs).toEqual({ anyOf: [{ connections: ['jira'] }, { hosts: ['https://{params.jiraSite}/*'] }, {}] });
    expect(t.actions).toEqual([{ assignProject: { key: '{key}', create: true } }]);
  });

  it('the pr rule: merged-prs pr-state\'s source (same args: one shared cache entry, M3-R77) with headRefName and state', () => {
    const pr = builtinRecipes()['merged-prs']!.rules.find((x) => x.id === 'pr-state')!;
    for (const v of VARIANTS) {
      const r = rule(v, 'pr');
      expect(r.match).toEqual({ url: 'github.com/:owner/:repo/pull/:num*' });
      expect(r.source).toEqual({ ...pr.source, fields: { headRefName: 'headRefName', state: 'state' } });
    }
  });

  it('the pr rule\'s needs, extracts and assignProject per variant', () => {
    expect(rule('title', 'pr').needs).toEqual({});
    expect(rule('branch', 'pr').needs).toEqual({ anyOf: [{ connections: ['github'] }, { hosts: [GH] }] });
    expect(rule('either', 'pr').needs).toEqual({ anyOf: [{ connections: ['github'] }, { hosts: [GH] }, {}] });
    expect(rule('title', 'pr').extract).toEqual({ key: { from: 'title', jiraKey: JK } });
    expect(rule('branch', 'pr').extract).toEqual({ key: { from: 'source.headRefName', jiraKey: JK } });
    expect(rule('either', 'pr').extract).toEqual({ keyTitle: { from: 'title', jiraKey: JK }, keyBranch: { from: 'source.headRefName', jiraKey: JK } });
    expect(rule('title', 'pr').actions).toEqual([{ assignProject: { key: '{key}' } }]);
    expect(rule('branch', 'pr').actions).toEqual([{ assignProject: { key: '{key}' } }]);
    expect(rule('either', 'pr').actions).toEqual([{ assignProject: { key: '{keyTitle}', fallbackKey: '{keyBranch}' } }]);
  });

  it('each variant conflicts with the other two', () => {
    for (const v of VARIANTS) expect([...body(v).conflicts!].sort()).toEqual(VARIANTS.filter((o) => o !== v).map(id).sort());
  });

  it('levels: Titles, Page details, Connections, listing the rules that run at that kind', () => {
    const lv = (v: Variant) => body(v).levels!.map((l) => [l.id, l.label, l.rules]);
    expect(lv('title')).toEqual([['titles', 'Titles', ['ticket', 'pr']], ['page', 'Page details', ['ticket']], ['connections', 'Connections', ['ticket']]]);
    expect(lv('branch')).toEqual([['titles', 'Titles', ['ticket']], ['page', 'Page details', ['ticket', 'pr']], ['connections', 'Connections', ['ticket', 'pr']]]);
    expect(lv('either')).toEqual([['titles', 'Titles', ['ticket', 'pr']], ['page', 'Page details', ['ticket', 'pr']], ['connections', 'Connections', ['ticket', 'pr']]]);
  });

  it('the three files differ only in recipe, name, description, conflicts, levels and the pr rule\'s name, needs, extracts and assignProject', () => {
    const omit = <T extends object>(o: T, ks: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)));
    const shared = (v: Variant) => {
      const b = structuredClone(body(v));
      const rules = b.rules.map((x) => (x.id === 'pr' ? omit(x, ['name', 'needs', 'extract', 'actions']) : x));
      return { ...omit(b, ['recipe', 'name', 'description', 'conflicts', 'levels']), rules };
    };
    expect(shared('branch')).toEqual(shared('title'));
    expect(shared('either')).toEqual(shared('title'));
  });

  it('every rule has a short human name (the why-log names it)', () => {
    expect(VARIANTS.map((v) => body(v).rules.map((r) => r.name))).toEqual([
      ['Ticket tab', 'PR by title'], ['Ticket tab', 'PR by branch'], ['Ticket tab', 'PR by title or branch'],
    ]);
  });
});

describe('jira-ticket: the ticket rule', () => {
  const evalTicket = (url: string, title: string) => evaluateTab(program('title'), { tab: tab(1, url, title) }, NOW).project;

  it('a /browse/ tab: key from the URL, summary from the loaded title', () => {
    expect(evalTicket(TICKET, '[ABC-1] Login fails - Jira')).toEqual([{ key: 'ABC-1', ruleKey: 'jira-ticket-title/ticket', index: expect.any(Number), create: true, summary: 'Login fails' }]);
  });
  it('a board ?selectedIssue= tab gives the key too', () => {
    expect(evalTicket('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-7', 'Board - Jira')?.map((c) => c.key)).toEqual(['ABC-7']);
  });
  it('M3-R102: the SPA shell titled just "Jira": the key from the URL, no summary (no error, no bogus summary)', () => {
    const c = evalTicket(TICKET, 'Jira');
    expect(c).toEqual([expect.objectContaining({ key: 'ABC-1', create: true })]);
    expect(c![0]).not.toHaveProperty('summary');
  });
  it('another host or a non-issue Jira page is no ticket', () => {
    expect(evalTicket('https://example.com/browse/ABC-1', '[ABC-1] x - Jira')).toBeUndefined();
    expect(evalTicket('https://acme.atlassian.net/jira/your-work', 'Your work - Jira')).toBeUndefined();
  });
  it('jiraSite narrows the match', () => {
    const p = program('title', { jiraSite: 'other.atlassian.net' });
    expect(evaluateTab(p, { tab: tab(1, TICKET, 'x') }, NOW).project).toBeUndefined();
    expect(evaluateTab(p, { tab: tab(1, 'https://other.atlassian.net/browse/ABC-1', 'x') }, NOW).project?.map((c) => c.key)).toEqual(['ABC-1']);
  });
});

describe('jira-ticket: dedupe key of a ticket tab (#179)', () => {
  const keyOf = (v: Variant, params: Record<string, unknown> = {}) => (u: string) => normalizeUrl(u, program(v, params).dedupe)?.key;

  it('a /browse/<KEY> URL with Jira\'s own query or fragment is the ticket itself, in every variant', () => {
    for (const v of VARIANTS) {
      const key = keyOf(v);
      for (const u of [
        TICKET, `${TICKET}?atlOrigin=eyJpIjoiMTIzIn0`, `${TICKET}?focusedCommentId=10001`, `${TICKET}?focusedCommentId=1&page=x#c`,
        `${TICKET}/`, 'http://acme.atlassian.net/browse/ABC-1?a=1',
      ]) expect(key(u), `${v}: ${u}`).toBe(u.startsWith('http:') ? 'http://acme.atlassian.net/browse/ABC-1' : TICKET);
    }
  });

  it('folds a ticket\'s #fragment even when duplicate detection keeps fragments', () => {
    for (const v of VARIANTS) {
      const c = config(v);
      const { program: p } = compileProgram({ ...c, dedupe: { ...c.dedupe, stripFragment: false } }, builtinRecipes());
      expect(normalizeUrl(`${TICKET}#comment-1`, p.dedupe)?.key, v).toBe(TICKET);
      expect(normalizeUrl('https://acme.atlassian.net/wiki#x', p.dedupe)?.key, v).toBe('https://acme.atlassian.net/wiki#x');
    }
  });

  it('another ticket, a board with ?selectedIssue=, a /browse/<PROJECT> page and other hosts keep their own key', () => {
    const key = keyOf('title');
    expect(key('https://acme.atlassian.net/browse/ABC-2?atlOrigin=x')).toBe('https://acme.atlassian.net/browse/ABC-2');
    const board = 'https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-1';
    expect(key(board)).toBe(board);
    expect(key('https://acme.atlassian.net/browse/ABC?selectedTab=x')).toBe('https://acme.atlassian.net/browse/ABC?selectedTab=x');
    expect(key('https://example.com/browse/ABC-1?atlOrigin=x')).toBe('https://example.com/browse/ABC-1?atlOrigin=x');
    expect(key('https://acme.atlassian.net.evil.com/browse/ABC-1?a=1')).toBe('https://acme.atlassian.net.evil.com/browse/ABC-1?a=1');
    expect(key('https://a.com/?u=https://acme.atlassian.net/browse/ABC-1')).toBe('https://a.com/?u=https%3A%2F%2Facme.atlassian.net%2Fbrowse%2FABC-1');
  });

  it('is scoped to jiraSite: a self-hosted site folds, the default *.atlassian.net no longer does', () => {
    const key = keyOf('title', { jiraSite: 'jira.acme.com:8443' });
    expect(key('https://jira.acme.com:8443/browse/ABC-1?atlOrigin=x')).toBe('https://jira.acme.com:8443/browse/ABC-1');
    expect(key(`${TICKET}?atlOrigin=x`)).toBe(`${TICKET}?atlOrigin=x`);
    expect(key('https://jiraxacme.com:8443/browse/ABC-1?a=1')).toBe('https://jiraxacme.com:8443/browse/ABC-1?a=1'); // `.` is escaped
  });

  it('an empty or unusable jiraSite drops the fold: it never folds every host', () => {
    for (const jiraSite of ['', '*', '*.*', 'a b', '*:8080', 'acme.com:*', '*.*.*.*.atlassian.net', '*.x/a*b*c*d']) {
      const { program: p } = compileProgram(config('title', { jiraSite }), builtinRecipes());
      expect(p.dedupe.urlTransforms.filter((t) => t.pattern.includes('/browse/')), jiraSite).toEqual([]);
      expect(normalizeUrl(`${TICKET}?atlOrigin=x`, p.dedupe)?.key, jiraSite).toBe(`${TICKET}?atlOrigin=x`);
    }
    expect(compileProgram(config('title', { jiraSite: '*' }), builtinRecipes()).errors).toEqual([]); // the rules still run
  });
});

describe('jira-ticket: a jiraSite of *.<host>, a host or a host with a path folds its ticket URLs (#179)', () => {
  const CASES = [
    { jiraSite: 'Acme.atlassian.net', ticket: 'https://acme.atlassian.net/browse/ABC-1' },
    { jiraSite: '*.Atlassian.net', ticket: 'https://acme.atlassian.net/browse/ABC-1' },
    { jiraSite: 'example.com/jira', ticket: 'https://example.com/jira/browse/ABC-1' },
    { jiraSite: 'jira.example.com:8443/jira', ticket: 'https://jira.example.com:8443/jira/browse/ABC-1' },
    { jiraSite: 'example.com/Jira', ticket: 'https://example.com/jira/browse/ABC-1' }, // a path differing only in case
  ];
  for (const { jiraSite, ticket } of CASES) {
    for (const v of VARIANTS) {
      it(`${v}: ${jiraSite}`, () => {
        const p = program(v, { jiraSite }); // compiles with this value: recipes.setParams would accept it
        expect(JSON.stringify(evaluateTab(p, { tab: tab(1, `${ticket}?atlOrigin=x`, '[ABC-1] Login fails - Jira') } as never, 0))).toContain(`${id(v)}/ticket`);
        expect(normalizeUrl(`${ticket}?atlOrigin=x`, p.dedupe)?.key).toBe(ticket);
        expect(normalizeUrl(`${ticket}?focusedCommentId=1#c`, p.dedupe)?.key).toBe(ticket);
      });
    }
  }
});

describe('jira-ticket: a jiraSite with a path or upper case folds nothing outside the ticket rule (#179)', () => {
  const keyOf = (jiraSite: string) => {
    const p = program('title', { jiraSite });
    return (u: string) => normalizeUrl(u, p.dedupe)?.key;
  };
  it('example.com/jira folds only <host>/jira/browse/<KEY>', () => {
    const key = keyOf('example.com/jira');
    for (const u of [
      'https://example.com/jira-evil/browse/ABC-1?a=1', 'https://example.com/x/jira/browse/ABC-1?a=1',
      'https://example.com.evil.com/jira/browse/ABC-1?a=1', 'https://evil.com/example.com/jira/browse/ABC-1?a=1',
      'https://example.com/browse/ABC-1?a=1', 'https://example.com/jira/browse/ABC?a=1',
    ]) expect(key(u), u).toBe(u);
  });
  it('a host that is only wildcards never folds, even with a path', () => {
    for (const jiraSite of ['*/jira', '*.*/jira', '/jira', '**/jira']) {
      const { program: p } = compileProgram(config('title', { jiraSite }), builtinRecipes());
      expect(p.dedupe.urlTransforms.filter((t) => t.pattern.includes('/browse/')), jiraSite).toEqual([]);
    }
  });
  it('Acme.atlassian.net folds only acme.atlassian.net', () => {
    const key = keyOf('Acme.atlassian.net');
    expect(key('https://other.atlassian.net/browse/ABC-1?a=1')).toBe('https://other.atlassian.net/browse/ABC-1?a=1');
    expect(key('https://acme.atlassian.net.evil.com/browse/ABC-1?a=1')).toBe('https://acme.atlassian.net.evil.com/browse/ABC-1?a=1');
  });
});

describe('jira-ticket: the fold stays fast on a page-controlled URL, whatever jiraSite (#179)', () => {
  const timed = (c: Config, u: string) => {
    const { program: p, errors } = compileProgram(c, builtinRecipes());
    expect(errors).toEqual([]);
    const t0 = performance.now();
    normalizeUrl(u, p.dedupe);
    return performance.now() - t0;
  };
  it('the default *.atlassian.net folds a long, adversarial URL quickly', () => {
    const c = config('title', { jiraSite: '*.atlassian.net' });
    expect(compileProgram(c, builtinRecipes()).program.dedupe.urlTransforms.some((t) => t.pattern.includes('/browse/'))).toBe(true);
    expect(timed(c, `https://${'a.'.repeat(1000)}x.atlassian.ne/browse/ABC-1?x`)).toBeLessThan(200);
    expect(timed(c, `https://${'a.'.repeat(1000)}atlassian.net/browse/ABC-1?${'x'.repeat(2000)}`)).toBeLessThan(200);
  });
  it('a *.<host> with a path folds a long, adversarial URL quickly', () => {
    const c = config('title', { jiraSite: '*.example.com/jira' });
    expect(compileProgram(c, builtinRecipes()).program.dedupe.urlTransforms.some((t) => t.pattern.includes('/browse/'))).toBe(true);
    expect(timed(c, `https://${'a.'.repeat(1000)}example.co/jira/browse/ABC-1?x`)).toBeLessThan(200);
  });
});

describe('jira-ticket: *.<host> folds the bare host too, as the ticket rule matches it (#179)', () => {
  it('*.example.com: example.com/browse/ABC-1?atlOrigin=x folds; another host ending in example.com does not', () => {
    const { program } = compileProgram(config('title', { jiraSite: '*.example.com' }), builtinRecipes());
    expect(compilePattern('*.example.com/browse/*')('https://example.com/browse/ABC-1')).not.toBeNull();
    expect(normalizeUrl('https://example.com/browse/ABC-1?atlOrigin=x', program.dedupe)?.key).toBe('https://example.com/browse/ABC-1');
    expect(normalizeUrl('https://a.b.example.com/browse/ABC-1?atlOrigin=x', program.dedupe)?.key).toBe('https://a.b.example.com/browse/ABC-1');
    expect(normalizeUrl('https://evilexample.com/browse/ABC-1?a=1', program.dedupe)?.key).toBe('https://evilexample.com/browse/ABC-1?a=1');
  });
});

describe('jira-ticket: :443 and IDN jiraSite values match no ticket, so neither folds (#179)', () => {
  it('the ticket rule itself never matches them', () => {
    expect(compilePattern('acme.atlassian.net:443/browse/*')('https://acme.atlassian.net/browse/ABC-1')).toBeNull();
    expect(compilePattern('bücher.example/browse/*')('https://xn--bcher-kva.example/browse/ABC-1')).toBeNull();
    expect(() => compilePattern('*.bücher.example/browse/*')).toThrow();
    for (const jiraSite of ['acme.atlassian.net:443', 'bücher.example', '*.bücher.example']) {
      const { program: p } = compileProgram(config('title', { jiraSite }), builtinRecipes());
      expect(p.dedupe.urlTransforms.filter((t) => t.pattern.includes('/browse/')), jiraSite).toEqual([]);
    }
  });
});

describe('jira-ticket: Jira\'s ?atlOrigin= tracking param is dropped on any page of the site (#179)', () => {
  const SITE = 'https://acme.atlassian.net';
  const BOARD = `${SITE}/jira/software/projects/SCRUM/boards/1`;
  const keyOf = (v: Variant, params: Record<string, unknown> = {}, stripFragment = true) => {
    const c = config(v, params);
    const { program: p, errors } = compileProgram({ ...c, dedupe: { ...c.dedupe, stripFragment } }, builtinRecipes());
    expect(errors).toEqual([]);
    return (u: string) => normalizeUrl(u, p.dedupe)?.key;
  };
  const atl = (p: Program) => p.dedupe.urlTransforms.filter((t) => /atlOrigin/i.test(t.pattern));

  it('a shared board link is the board itself, in every variant', () => {
    for (const v of VARIANTS) {
      const key = keyOf(v);
      expect(key(`${BOARD}?filter=&groupBy=none&selectedIssue=SCRUM-1&atlOrigin=test`), v)
        .toBe(`${BOARD}?filter=&groupBy=none&selectedIssue=SCRUM-1`);
    }
  });

  it('wherever it sorts among the params: only, first, middle, last', () => {
    const key = keyOf('title');
    for (const [u, k] of [
      [`${BOARD}?atlOrigin=x`, BOARD],
      [`${BOARD}?z=1&atlOrigin=x`, `${BOARD}?z=1`], // atlOrigin sorts first
      [`${BOARD}?z=2&atlOrigin=x&a=1`, `${BOARD}?a=1&z=2`], // middle
      [`${BOARD}?atlOrigin=x&ab=1&Z=1`, `${BOARD}?Z=1&ab=1`], // last (upper case and "ab" sort before it)
      [`${BOARD}?atlOrigin=`, BOARD], // empty value
      [`${BOARD}?atlOrigin=eyJpIjoiMTIzIn0%3D&a=1`, `${BOARD}?a=1`],
      [`${SITE}/?atlOrigin=x`, `${SITE}/`],
      [`${SITE}/wiki/spaces/A/pages/1?atlOrigin=x`, `${SITE}/wiki/spaces/A/pages/1`], // Confluence on the same site
      [`${SITE}/browse/ABC?atlOrigin=x&selectedTab=y`, `${SITE}/browse/ABC?selectedTab=y`], // a project page keeps its tab
      [`${TICKET}?atlOrigin=x&focusedCommentId=1`, TICKET], // the ticket fold still applies
    ] as const) expect(key(u), u).toBe(k);
  });

  it('ignores the param name\'s case, as the site match does', () => {
    const key = keyOf('title');
    expect(key(`${BOARD}?ATLORIGIN=x&a=1`)).toBe(`${BOARD}?a=1`);
    expect(key(`HTTPS://ACME.atlassian.net/jira/x?atlorigin=x`)).toBe(`${SITE}/jira/x`);
  });

  it('keeps a #fragment when duplicate detection keeps fragments', () => {
    const key = keyOf('title', {}, false);
    expect(key(`${BOARD}?atlOrigin=x#f`)).toBe(`${BOARD}#f`);
    expect(key(`${BOARD}?a=1&atlOrigin=x#f`)).toBe(`${BOARD}?a=1#f`);
    expect(key(`${BOARD}?z=1&atlOrigin=x#f`)).toBe(`${BOARD}?z=1#f`);
    expect(key(`${BOARD}#atlOrigin=x`)).toBe(`${BOARD}#atlOrigin=x`); // in the fragment: not a query param
    expect(key(`${BOARD}?a=1#x&atlOrigin=y`)).toBe(`${BOARD}?a=1#x&atlOrigin=y`);
  });

  it('keeps a param that only contains atlOrigin, and atlOrigin text in a value', () => {
    const key = keyOf('title');
    for (const u of [
      `${BOARD}?xatlOrigin=1`, `${BOARD}?a=1&xatlOrigin=1`, `${BOARD}?atlOriginX=1`, `${BOARD}?atlOrigin_=1`,
      `${BOARD}?q=atlOrigin%3D1`, `${BOARD}?q=a%26atlOrigin%3D1`,
    ]) expect(key(u), u).toBe(u);
    expect(key(`${BOARD}?q=atlOrigin=1`)).toBe(`${BOARD}?q=atlOrigin%3D1`); // the value is encoded, then kept
  });

  it('touches only the query: a path ending in & or holding &atlOrigin= is kept', () => {
    const key = keyOf('title');
    for (const u of [`${SITE}/a&`, `${SITE}/a&atlOrigin=x`, `${SITE}/a&?b=1`]) expect(key(u), u).toBe(u);
    expect(key(`${SITE}/a&atlOrigin=x?atlOrigin=y`)).toBe(`${SITE}/a&atlOrigin=x`);
  });

  it('other hosts keep it', () => {
    const key = keyOf('title');
    for (const u of [
      'https://example.com/x?atlOrigin=1', 'https://acme.atlassian.net.evil.com/x?atlOrigin=1', 'https://atlassian.com/x?atlOrigin=1',
      'https://evil.com/acme.atlassian.net/x?atlOrigin=1', 'https://a.com/?u=https%3A%2F%2Facme.atlassian.net%2F%3FatlOrigin%3D1',
    ]) expect(key(u), u).toBe(u);
  });

  it('is scoped to jiraSite, its port and context path', () => {
    const key = keyOf('title', { jiraSite: 'jira.acme.com:8443' });
    expect(key('https://jira.acme.com:8443/secure/RapidBoard.jspa?atlOrigin=x&rapidView=1')).toBe('https://jira.acme.com:8443/secure/RapidBoard.jspa?rapidView=1');
    expect(key(`${BOARD}?atlOrigin=x`)).toBe(`${BOARD}?atlOrigin=x`);
    expect(key('https://jira.acme.com/x?atlOrigin=x')).toBe('https://jira.acme.com/x?atlOrigin=x');
    const ctx = keyOf('title', { jiraSite: 'example.com/jira' });
    expect(ctx('https://example.com/jira/secure/x?atlOrigin=1&a=1')).toBe('https://example.com/jira/secure/x?a=1');
    for (const u of ['https://example.com/other?atlOrigin=1', 'https://example.com/jira-evil/x?atlOrigin=1']) expect(ctx(u), u).toBe(u);
  });

  it('runs after the ticket fold, and every variant ships the same transforms', () => {
    for (const v of VARIANTS) {
      const t = body(v).dedupe!.urlTransforms!;
      expect(t[0]!.pattern, v).toContain('/browse/');
      expect(t.slice(1).map((x) => x.pattern), v).toEqual(body('title').dedupe!.urlTransforms!.slice(1).map((x) => x.pattern));
      expect(t.slice(1).length, v).toBe(2);
    }
  });

  it('an empty or unusable jiraSite drops it too: it never strips on every host', () => {
    expect(atl(program('title'))).toHaveLength(2);
    for (const jiraSite of ['', '*', '*.*', 'a b', '*:8080', 'acme.com:*', '*/jira', 'acme.atlassian.net:443', '*.bücher.example']) {
      const { program: p } = compileProgram(config('title', { jiraSite }), builtinRecipes());
      expect(atl(p), jiraSite).toEqual([]);
      expect(normalizeUrl(`${BOARD}?atlOrigin=x`, p.dedupe)?.key, jiraSite).toBe(`${BOARD}?atlOrigin=x`);
    }
  });

  it('stays fast on a long, adversarial URL', () => {
    const timed = (jiraSite: string, u: string) => {
      const { program: p } = compileProgram(config('title', { jiraSite }), builtinRecipes());
      expect(atl(p)).toHaveLength(2);
      const t0 = performance.now();
      normalizeUrl(u, p.dedupe);
      return performance.now() - t0;
    };
    const host = `${'a.'.repeat(1000)}atlassian.net`;
    for (const u of [
      `https://${host}/${'x/'.repeat(2000)}?${'a=1&'.repeat(2000)}xatlOrigin=1`,
      `https://${host}/x?${'atlOrigin'.repeat(500)}=1&${'b=atlOrigin&'.repeat(2000)}c=1`,
      `https://${'a.'.repeat(1000)}x.atlassian.ne/${'x/'.repeat(2000)}?${'a=1&'.repeat(2000)}atlOrigin=1`,
      `https://${host}/x?${'a=1&'.repeat(4000)}atlOrigin=1#${'&'.repeat(4000)}`,
    ]) expect(timed('*.atlassian.net', u), u.slice(0, 40)).toBeLessThan(200);
    expect(timed('*.example.com/jira', `https://${'a.'.repeat(1000)}example.com/jira/${'x/'.repeat(2000)}?${'a=1&'.repeat(2000)}z=1`)).toBeLessThan(200);
  });
});

/** A PermissionsManager + ProgramCache over the real recipe, with `granted` and the connection states. */
async function levelsSetup(v: Variant, granted: string[] = [], conn: Record<string, ConnectionState> = {}) {
  const port = new FakeBrowserPort();
  for (const g of granted) port.granted.add(g);
  const cfg = config(v);
  const holder: { pm?: PermissionsManager } = {};
  const programs = new ProgramCache(async () => cfg, { builtins: builtinRecipes(), paused: () => holder.pm?.paused() ?? [], warn: () => {} });
  const labels: Record<string, string> = { github: 'GitHub', jira: 'Jira' };
  const pm = new PermissionsManager(port, () => programs.get(), { register: async () => [], unregister: async () => [], inject: async () => {} }, {
    connections: async () => ['github', 'jira'].map((c) => ({ id: c, label: labels[c]!, state: conn[c] ?? 'not-configured' })),
  });
  holder.pm = pm;
  await pm.onChanged();
  const levelText = (l: LevelStatus) => (l.available ? `${l.label}: available` : `${l.label}: locked, needs ${l.needs}`);
  return { port, pm, programs, levels: async () => (await pm.status())[id(v)]!.levels!.map(levelText), status: async () => (await pm.status())[id(v)]! };
}

describe('jira-ticket: level 1 (Titles, nothing granted)', () => {
  it('title variant: ticket "[ABC-1] Login fails - Jira" + PR "ABC-1 fix" → one project ABC-1, summary "Login fails" from the title', () => {
    const { byTab, r } = keys(program('title'), [tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'ABC-1 fix')]);
    expect(byTab).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
    expect(r.created.map((p) => p.id)).toEqual(['jira-ticket-title:ABC-1']);
    expect([...r.summaries]).toEqual([['jira-ticket-title:ABC-1', 'Login fails']]);
  });

  it('title variant: nothing paused; Titles available, the others locked with what unlocks them', async () => {
    const s = await levelsSetup('title');
    expect([...s.pm.paused()]).toEqual([]);
    expect(await s.levels()).toEqual(['Titles: available', 'Page details: locked, needs *.atlassian.net', 'Connections: locked, needs Jira connection']);
    expect(await s.pm.levelFor('jira-ticket-title/ticket')).toBe('titles');
  });

  it('branch variant: the pr rule is paused (needs github.com or the GitHub connection); the ticket still makes a project', async () => {
    const s = await levelsSetup('branch');
    expect([...s.pm.paused()]).toEqual(['jira-ticket-branch/pr']);
    expect((await s.status()).rules!['jira-ticket-branch/pr']).toEqual({ level: -1, paused: 'Paused: needs the GitHub connection, or needs access to github.com' });
    expect(await s.levels()).toEqual([
      'Titles: available', 'Page details: locked, needs *.atlassian.net, github.com', 'Connections: locked, needs Jira or GitHub connection',
    ]);
    const { byTab } = keys(await s.programs.get(), [tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'ABC-1 fix')]);
    expect(byTab).toEqual({ 1: 'ABC-1' });
  });

  it('branch variant, Jira host granted, github.com not: Page details is blocked by the paused pr rule and asks for github.com (T12 carry)', async () => {
    const s = await levelsSetup('branch', [JIRA, 'scripting']);
    const st = await s.status();
    expect(await s.levels()).toEqual(['Titles: available', 'Page details: locked, needs github.com', 'Connections: locked, needs Jira or GitHub connection']);
    expect(st.levels![1]!.missing).toEqual({ origins: [GH], permissions: [], connections: [] });
    const c = await levelsSetup('branch', [JIRA, 'scripting'], { jira: 'ok' });
    expect((await c.levels())[2]).toBe('Connections: locked, needs GitHub connection');
    expect((await c.status()).levels![2]!.missing).toEqual({ origins: [], permissions: [], connections: ['github'] });
  });

  it('either variant at level 1: joins by title (the branch is unknown)', async () => {
    const s = await levelsSetup('either');
    expect([...s.pm.paused()]).toEqual([]);
    expect(await s.levels()).toEqual([
      'Titles: available', 'Page details: locked, needs *.atlassian.net, github.com', 'Connections: locked, needs Jira or GitHub connection',
    ]);
    expect(keys(await s.programs.get(), [tab(1, TICKET, 'Jira'), tab(2, PR, 'ABC-1 fix')]).byTab).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });
});

describe('jira-ticket: level 2 (Page details: github.com granted, the PR page read)', () => {
  /** Page facts of a PR tab with head branch `branch` (the github.prPage adapter fields). */
  const prPage = (branch: string) => ({
    texts: [], formEdited: false,
    extracts: { [adapterKey('github.prPage', 'state')]: 'Status: Open', [adapterKey('github.prPage', 'branch')]: `acme/api:${branch}` },
  });
  async function run(v: Variant, tabs: TabSnap[], pages: Record<number, ReturnType<typeof prPage>>) {
    const s = await levelsSetup(v, [GH, 'scripting']);
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
    return { s, svc, p, keys: keys(p, tabs, facts).byTab };
  }

  it('branch variant: the PR whose title lacks the key joins ABC-1 by its branch feat/ABC-1-login', async () => {
    const { s, keys: k } = await run('branch', [tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'Fix login')], { 2: prPage('feat/ABC-1-login') });
    expect(await s.pm.levelFor('jira-ticket-branch/pr')).toBe('page');
    expect(await s.levels()).toEqual(['Titles: available', 'Page details: available', 'Connections: locked, needs Jira or GitHub connection']);
    expect(k).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });

  it("a PR tab that moves to its Files changed tab stays with its ticket before the next source refresh", async () => {
    // GitHub's PR links navigate the same document: the URL changes first, the page is re-read later.
    const pages: Record<number, ReturnType<typeof prPage>> = { 2: prPage('feat/ABC-1-login') };
    const { svc, p, keys: before } = await run('branch', [tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'Fix login')], pages);
    expect(before).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
    delete pages[2];
    const moved = [tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, `${PR}/files`, 'Fix login')];
    const facts: Facts = Object.fromEntries(moved.map((t) => [t.id, { ...(svc.factsFor(t.id, t.url) && { source: svc.factsFor(t.id, t.url) }) }]));
    expect(keys(p, moved, facts).byTab).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });

  it('the real fixtures PR: branch feature/scrum-1-login joins SCRUM-1', async () => {
    const { keys: k } = await run('branch', [tab(1, 'https://acme.atlassian.net/browse/SCRUM-1', 'Jira'), tab(2, PR, 'Login')], { 2: prPage('feature/scrum-1-login') });
    expect(k).toEqual({ 1: 'SCRUM-1', 2: 'SCRUM-1' });
  });

  it('a discarded PR tab without page facts does not join by branch; in the either variant it joins by title', async () => {
    const tabs = [tab(1, TICKET, '[ABC-1] Login fails - Jira'), tab(2, PR, 'ABC-1 fix login', { discarded: true })];
    expect((await run('branch', tabs, {})).keys).toEqual({ 1: 'ABC-1' });
    expect((await run('either', tabs, {})).keys).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });

  it('either variant: a PR titled without the key joins by its branch (fallbackKey)', async () => {
    const { keys: k } = await run('either', [tab(1, TICKET, 'Jira'), tab(2, PR, 'Fix login')], { 2: prPage('feat/abc-1-login') });
    expect(k).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });
});

describe('jira-ticket: level 3 (Connections: source data from the APIs)', () => {
  it('branch variant: the headRefName from the API joins', () => {
    const { byTab } = keys(program('branch'), [tab(1, TICKET, 'Jira'), tab(2, PR, 'Fix login')], {
      2: prSource('branch', { headRefName: 'feature/abc-1-login', state: 'open' }),
    });
    expect(byTab).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });

  it('either variant: a title key that resolves to no project falls back to the branch key', () => {
    const { byTab } = keys(program('either'), [tab(1, TICKET, 'Jira'), tab(2, PR, 'XYZ-9 follow-up')], {
      2: prSource('either', { headRefName: 'abc-1-login', state: 'open' }),
    });
    expect(byTab).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
  });

  it('branch mode (M3-R105): a key after a hyphen counts (feature-abc-12-login → ABC-12)', () => {
    const { byTab } = keys(program('branch'), [tab(1, 'https://acme.atlassian.net/browse/ABC-12', 'Jira'), tab(2, PR, 'x')], {
      2: prSource('branch', { headRefName: 'feature-abc-12-login' }),
    });
    expect(byTab).toEqual({ 1: 'ABC-12', 2: 'ABC-12' });
  });

  it('M3-R105 + Review Focus #5: a false key from a hyphenated branch creates no project (its prefix is not confirmed)', () => {
    const { byTab, r } = keys(program('branch'), [tab(2, PR, 'x')], { 2: prSource('branch', { headRefName: 'bump-lib-2-and-utf-8' }) });
    expect(byTab).toEqual({});
    expect(r.created).toEqual([]);
  });

  it('projectPrefixes confirms a prefix: a PR alone starts its project', () => {
    const p = program('title', { projectPrefixes: ['ABC'] });
    expect(keys(p, [tab(2, PR, 'ABC-3 fix')], {}, { allow: ['ABC'] }).byTab).toEqual({ 2: 'ABC-3' });
  });
});

describe('jira-ticket: Review Focus #5 (look-alike keys)', () => {
  it('a ticket ABC-1 + a PR "Upgrade to UTF-8 (ABC-1)" → joins ABC-1; a PR "Handle UTF-8" → no project', () => {
    for (const v of ['title', 'either'] as const) {
      const { byTab, r } = keys(program(v), [tab(1, TICKET, 'Jira'), tab(2, PR, 'Upgrade to UTF-8 (ABC-1)'), tab(3, PR2, 'Handle UTF-8')]);
      expect(byTab).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
      expect(r.created.map((p) => p.key)).toEqual(['ABC-1']);
    }
  });
  it('UTF-8, SHA-256, ISO-8859-1, COVID-19, GPT-4 and HTTP-2 alone never create a project', () => {
    const titles = ['UTF-8', 'SHA-256', 'ISO-8859-1', 'COVID-19', 'GPT-4', 'HTTP-2'];
    const { byTab, r } = keys(program('title'), titles.map((t, i) => tab(i + 2, `https://github.com/acme/api/pull/${i + 2}`, `Fix ${t}`)));
    expect(byTab).toEqual({});
    expect(r.created).toEqual([]);
  });
});

describe('jira-ticket: ProjectService (cards, done prompt, why-log)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const RID = 'jira-ticket-title';
  const issue = (o: Partial<SourceEntry<JiraIssue>> = {}): SourceEntry<JiraIssue> => ({
    data: { key: 'ABC-1', summary: 'Login fails', status: 'Done', statusCategory: 'done', url: TICKET }, via: 'api', fetchedAt: NOW, final: false, stale: false, ...o,
  });
  function harness(v: Variant = 'title', params: Record<string, unknown> = {}) {
    const port = new FakeBrowserPort();
    port.addWindow(1, { focused: true });
    const p = program(v, params);
    const logs: { tabId?: number; ruleId?: string; action: string; detail: string }[] = [];
    const data = new Map<string, unknown>();
    const local = {
      get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))])),
      set: async (items: Record<string, unknown>) => { for (const [k, x] of Object.entries(items)) data.set(k, structuredClone(x)); },
    };
    const sources = {
      factsFor: vi.fn<(tid: number, url?: string) => Record<string, SourceEntry<Record<string, unknown>>> | undefined>(() => undefined),
      issues: vi.fn<(ks: string[]) => Promise<Map<string, SourceEntry<JiraIssue>>>>(async () => new Map()),
      linkedFor: vi.fn<(ks: string[], orgs: string[]) => Promise<Map<string, PrInfo[]>>>(async () => new Map()),
      jiraSite: vi.fn<() => Promise<string | undefined>>(async () => 'acme.atlassian.net'),
      githubIssues: vi.fn(async () => new Map()),
    };
    // eslint-disable-next-line prefer-const -- the service reads the reconciler's state lazily
    let r: Reconciler;
    const svc = new ProjectService({
      store: new ProjectStore(local), port, getProgram: async () => p, sources, facts: { get: () => undefined }, log: { add: (e) => logs.push(e) },
      recentlyClosed: { add: () => 'rc' }, safety: { isProtected: () => false }, state: () => r.liveState(), now: () => NOW,
    });
    r = new Reconciler(port, async () => p, { projects: svc, now: () => NOW, log: { add: (e) => logs.push(e) } });
    return { port, svc, r, sources, logs, rid: id(v) };
  }

  it('Level 3: the ticket status Done (fresh, from the API) → cards()[0].done and the "Close this group?" prompt', async () => {
    const h = harness();
    h.port.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.port.addTab(tab(2, PR, 'ABC-1 fix'));
    await h.r.flush();
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue()]]));
    const cards = await h.svc.cards();
    expect(cards[0]).toMatchObject({ key: 'ABC-1', summary: 'Login fails', status: { name: 'Done', category: 'done', via: 'api' }, done: true });
    expect(buildProjectCards(cards)[0]!.showClose).toBe(true);
  });

  it('M3-R90: a stale Done (cache kept after a failed refresh) shows the status but never prompts to close', async () => {
    const h = harness();
    h.port.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue({ stale: true, error: 'network' })]]));
    const cards = await h.svc.cards();
    expect(cards[0]).toMatchObject({ status: { name: 'Done', category: 'done', via: 'api' }, done: false });
    expect(buildProjectCards(cards)[0]!.showClose).toBe(false);
  });

  it('M3-R90: a Done stored from an earlier pass (no fresh data now) never prompts; nor does a stale page read', async () => {
    const h = harness();
    h.port.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    await h.r.flush();
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue()]]));
    expect((await h.svc.cards())[0]!.done).toBe(true); // stores status Done
    h.sources.issues.mockResolvedValue(new Map());
    expect((await h.svc.cards())[0]).toMatchObject({ status: { category: 'done' }, done: false });
    h.sources.factsFor.mockImplementation((tid) => (tid === 1
      ? { [`${RID}/ticket`]: { data: { status: 'Done', statusCategory: 'done' }, via: 'page', fetchedAt: NOW, final: false, stale: true } } : undefined));
    expect((await h.svc.cards())[0]!.done).toBe(false);
    h.sources.factsFor.mockImplementation((tid) => (tid === 1
      ? { [`${RID}/ticket`]: { data: { status: 'Done', statusCategory: 'done' }, via: 'page', fetchedAt: NOW, final: false, stale: false } } : undefined));
    expect((await h.svc.cards())[0]).toMatchObject({ status: { via: 'page' }, done: true });
  });

  it('M3-R110: a ticket tab on another Jira site is not looked up on the connected one: its Done there never prompts', async () => {
    for (const v of ['title', 'branch', 'either'] as const) {
      const h = harness(v);
      h.port.addTab(tab(1, 'https://other.atlassian.net/browse/SCRUM-1', '[SCRUM-1] Their ticket - Jira'));
      await h.r.flush();
      // The connected site (acme) has its own SCRUM-1, Done.
      h.sources.issues.mockImplementation(async (ks) => new Map(ks.filter((k) => k === 'SCRUM-1').map((k) => [k, issue({
        data: { key: k, summary: 'Acme sprint', status: 'Done', statusCategory: 'done', url: 'https://acme.atlassian.net/browse/SCRUM-1' },
      })])));
      const cards = await h.svc.cards();
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ key: 'SCRUM-1', done: false });
      expect(cards[0]).not.toHaveProperty('status');
      expect(cards[0]!.summary).not.toBe('Acme sprint');
      expect(buildProjectCards(cards)[0]!.showClose).toBe(false);
      expect(h.sources.issues.mock.calls.flatMap(([ks]) => ks)).not.toContain('SCRUM-1');
    }
  });

  it('M3-R110: a project with only a PR tab (no ticket tab seen) is still looked up on the connected site', async () => {
    const h = harness('title', { projectPrefixes: ['ABC'] });
    h.port.addTab(tab(2, PR, 'ABC-1 fix'));
    await h.r.flush();
    h.sources.issues.mockResolvedValue(new Map([['ABC-1', issue()]]));
    const cards = await h.svc.cards();
    expect(h.sources.issues).toHaveBeenCalledWith(['ABC-1']);
    expect(cards[0]).toMatchObject({ key: 'ABC-1', status: { category: 'done', via: 'api' }, done: true });
  });

  it('M3-R110: the site of a project\'s ticket tab is kept: once that other-site tab closes, its PR tab still never asks the connected site', async () => {
    const h = harness();
    h.port.addTab(tab(1, 'https://other.atlassian.net/browse/SCRUM-1', '[SCRUM-1] Their ticket - Jira'));
    h.port.addTab(tab(2, PR, 'SCRUM-1 fix'));
    await h.r.flush();
    await h.port.closeTab(1);
    await h.r.flush();
    h.sources.issues.mockImplementation(async (ks) => new Map(ks.map((k) => [k, issue({
      data: { key: k, summary: 'Acme sprint', status: 'Done', statusCategory: 'done', url: `https://acme.atlassian.net/browse/${k}` },
    })])));
    const cards = await h.svc.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: 'SCRUM-1', done: false });
    expect(cards[0]!.tabs.map((t) => t.tabId)).toEqual([2]);
    expect(h.sources.issues.mock.calls.flatMap(([ks]) => ks)).not.toContain('SCRUM-1');
  });

  it('a title alone (Titles level) gives no status and no prompt', async () => {
    const h = harness();
    h.port.addTab(tab(1, TICKET, '[ABC-1] Done thing - Jira'));
    await h.r.flush();
    const [card] = await h.svc.cards();
    expect(card).not.toHaveProperty('status');
    expect(card!.done).toBe(false);
  });

  it('the why-log line names the rule (its name), not the recipe', async () => {
    const h = harness('either');
    h.port.addTab(tab(1, TICKET, '[ABC-1] Login fails - Jira'));
    h.port.addTab(tab(2, PR, 'ABC-1 fix'));
    await h.r.flush();
    expect(h.logs.filter((l) => l.action === 'project-join').map((l) => [l.tabId, l.detail, l.ruleId])).toEqual([
      [1, 'Joined ABC-1 by rule Ticket tab', 'jira-ticket-either/ticket'], [2, 'Joined ABC-1 by rule PR by title or branch', 'jira-ticket-either/pr'],
    ]);
  });
});

describe('jira-ticket: conflicts (M3-R17)', () => {
  it('the preview config (withRecipe with the built-ins) turns the conflicting variant off too', () => {
    const on = (c: Config) => c.recipes.filter((r) => r.enabled && r.id.startsWith('jira-ticket-')).map((r) => r.id);
    expect(on(withRecipe(config('title'), 'jira-ticket-either', { enabled: true }, builtinRecipes()))).toEqual(['jira-ticket-either']);
    expect(on(withRecipe(config('title'), 'jira-ticket-either', { enabled: true }))).toEqual(['jira-ticket-title', 'jira-ticket-either']);
    expect(on(withRecipe(config('title'), 'jira-ticket-title', { params: {} }, builtinRecipes()))).toEqual(['jira-ticket-title']);
  });

  function setup(enabled: Variant[]) {
    const port = new FakeBrowserPort();
    let cfg: Config = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r): RecipeRef => ({ ...r, enabled: VARIANTS.some((v) => id(v) === r.id && enabled.includes(v)) })) };
    const store = {
      get: async () => cfg, set: vi.fn(async (c: Config) => { cfg = c; }),
      update: vi.fn(async (fn: (c: Config) => Config) => { cfg = fn(cfg); return cfg; }),
      backups: async () => [], restore: async () => {}, status: async () => ({ syncing: true }),
    };
    const programs = new ProgramCache(() => store.get(), { builtins: builtinRecipes(), warn: () => {} });
    const pm = new PermissionsManager(port, () => programs.get(), { register: async () => [], unregister: async () => [], inject: async () => {} });
    const deps: HandlerDeps = {
      runtimeId: 'ext', extensionOrigin: 'chrome-extension://ext', store, port, getSettings: async () => (await programs.get()).dedupe,
      safety: { pause: vi.fn(), resume: vi.fn(), isPaused: () => false, lock: vi.fn(), unlock: vi.fn(), isLocked: () => false, lockedTabIds: () => [], undo: vi.fn(async () => {}) },
      recentlyClosed: { ready: Promise.resolve(), list: () => [], add: () => 'id' },
      whyLog: { ready: Promise.resolve(), all: () => [], forTab: () => [], add: () => {} },
      ask: { listPending: async () => [], resolvePending: vi.fn(async () => {}) },
      recipes: { builtins: builtinRecipes(), permissions: pm },
    };
    const on = () => cfg.recipes.filter((r) => r.enabled && r.id.startsWith('jira-ticket-')).map((r) => r.id);
    return { handle: createHandler(deps), on, cfg: () => cfg };
  }
  const ui = { id: 'ext', url: 'chrome-extension://ext/options.html' };

  it('enabling jira-ticket-either while jira-ticket-title is enabled disables the title variant (one update, baseRev honored)', async () => {
    const t = setup(['title']);
    expect(await t.handle({ type: 'recipes.enable', id: 'jira-ticket-either', baseRev: configRev(t.cfg()) }, { ...ui })).toEqual({ ok: true, data: null });
    expect(t.on()).toEqual(['jira-ticket-either']);
    const { errors } = compileProgram(t.cfg(), builtinRecipes());
    expect(errors).toEqual([]);
  });

  it('enabling jira-ticket-title while -branch is enabled (title earlier in config.recipes) disables -branch', async () => {
    const t = setup(['branch']);
    expect(await t.handle({ type: 'recipes.enable', id: 'jira-ticket-title' }, ui)).toEqual({ ok: true, data: null });
    expect(t.on()).toEqual(['jira-ticket-title']);
  });
});
