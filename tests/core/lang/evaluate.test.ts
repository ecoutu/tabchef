import { describe, it, expect } from 'vitest';
import { compileProgram } from '../../../src/core/lang/compile';
import { evaluateTab } from '../../../src/core/lang/evaluate';
import { defaultConfig } from '../../../src/core/config/defaults';
import type { Action, Recipe, RecipeRef, Rule, TabFacts } from '../../../src/core/lang/types';
import type { Config, TabSnap } from '../../../src/core/types';

const NOW = 1_800_000_000_000;
const tab = (over: Partial<TabSnap> = {}): TabSnap => ({
  id: 1, windowId: 1, index: 0, url: 'https://github.com/acme/api/pull/7', title: '42 Fix it',
  pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...over,
});
const facts = (t: Partial<TabSnap> = {}, over: Partial<TabFacts> = {}): TabFacts => ({ tab: tab(t), ...over });
const rule = (id: string, url: Rule['match'], actions: Action[], over: Partial<Rule> = {}): Rule => ({ id, name: id, enabled: true, match: url, actions, ...over });
const group = (title: string, color = 'blue', more: object = {}): Action => ({ group: { title, color, ...more } });
const recipe = (id: string, rules: Rule[], over: Partial<Recipe> = {}): Recipe => ({ recipe: id, version: 1, name: id, description: id, rules, ...over });
const ref = (id: string, over: Partial<RecipeRef> = {}): RecipeRef => ({ id, enabled: true, params: {}, source: 'builtin', ...over });
const config = (over: Partial<Config> = {}): Config => ({ ...defaultConfig(), recipes: [], ...over });
const program = (c: Config, b: Record<string, Recipe> = {}) => {
  const { program: p, errors } = compileProgram(c, b);
  expect(errors).toEqual([]);
  return p;
};
const ev = (c: Config, f: TabFacts = facts(), b: Record<string, Recipe> = {}) => evaluateTab(program(c, b), f, NOW);

describe('evaluateTab: priority', () => {
  const A = rule('a', { url: 'github.com/acme/*' }, [group('acme')]);
  const gh = { gh: recipe('gh', [rule('b', { url: 'github.com/*' }, [group('gh')])]) };
  it('user rule A ordered before recipe rule B → "acme"; reversing order → "gh"', () => {
    expect(ev(config({ rules: [A], recipes: [ref('gh')], order: ['user/a', 'gh/b'] }), facts(), gh).group?.title).toBe('acme');
    expect(ev(config({ rules: [A], recipes: [ref('gh')], order: ['gh/b', 'user/a'] }), facts(), gh).group?.title).toBe('gh');
  });
  it('matched lists every matching key in priority order', () => {
    const c = config({
      rules: [A, rule('miss', { url: 'gitlab.com/*' }, [group('x')]), rule('c', { url: '*' }, [{ showInView: { view: 'all' } }])],
      recipes: [ref('gh')], order: ['gh/b', 'user/c', 'user/miss', 'user/a'],
    });
    const r = ev(c, facts(), gh);
    expect(r.matched).toEqual(['gh/b', 'user/c', 'user/a']);
    expect(r.group).toMatchObject({ key: 'gh/b', index: 0 });
  });
});

describe('evaluateTab: action kinds come from different rules', () => {
  it('a tab matching a group rule and a close rule gets both', () => {
    const c = config({ rules: [
      rule('g', { url: 'github.com/*' }, [group('GH')]),
      rule('c', { url: 'github.com/acme/*' }, [{ close: { after: '10s', mode: 'suggest' } }]),
      rule('c2', { url: 'github.com/*' }, [{ close: { after: '1s' } }]),
    ] });
    const r = ev(c);
    expect(r.group).toMatchObject({ key: 'user/g', title: 'GH' });
    expect(r.close).toEqual({ key: 'user/c', afterMs: 10_000, mode: 'suggest', dryRun: false });
  });
  it('close without after is immediate, mode defaults to auto', () => {
    const r = ev(config({ rules: [rule('c', { url: '*' }, [{ close: {} }])] }));
    expect(r.close).toEqual({ key: 'user/c', afterMs: 0, mode: 'auto', dryRun: false });
  });
  it('the first dedupe action wins and carries its override fields', () => {
    const c = config({ rules: [
      rule('d1', { url: 'github.com/*' }, [{ dedupe: { mode: 'ask', keepFragment: true, matchTitle: true, followFragment: false } }]),
      rule('d2', { url: '*' }, [{ dedupe: { mode: 'off' } }]),
    ] });
    expect(ev(c).dedupe).toEqual({ key: 'user/d1', mode: 'ask', keepFragment: true, matchTitle: true, followFragment: false });
  });
  it('views collects every matching showInView, once each', () => {
    const c = config({ rules: [
      rule('v1', { url: '*' }, [{ showInView: { view: 'a' } }]),
      rule('v2', { url: '*' }, [{ showInView: { view: 'b' } }, { showInView: { view: 'a' } }]),
    ] });
    expect(ev(c).views).toEqual(['a', 'b']);
  });
  it('no discard or notify fields (R26)', () => {
    const r = ev(config({ rules: [rule('g', { url: '*' }, [group('G')])] }));
    expect(r).not.toHaveProperty('discard');
    expect(r).not.toHaveProperty('notify');
  });
  it('dryRun flows from the rule or the config', () => {
    const rs = [rule('g', { url: '*' }, [group('G'), { close: {} }], { dryRun: true })];
    expect(ev(config({ rules: rs })).group?.dryRun).toBe(true);
    expect(ev(config({ rules: rs })).close?.dryRun).toBe(true);
    const plain = [rule('g', { url: '*' }, [group('G')])];
    expect(ev(config({ rules: plain })).group?.dryRun).toBe(false);
    expect(ev(config({ rules: plain, dryRun: true })).group?.dryRun).toBe(true);
  });
});

describe('evaluateTab: params', () => {
  it('recipe finished with params.delay = 5s → close.afterMs 5000', () => {
    const finished = recipe('finished', [rule('oauth', { url: '{params.callbackPatterns}' }, [{ close: { after: '{params.delay}', mode: '{params.mode}' as 'auto' } }])], {
      params: {
        delay: { type: 'duration', default: '3s', label: 'Delay' },
        mode: { type: 'string', default: 'auto', label: 'Mode' },
        callbackPatterns: { type: 'string[]', default: ['http://localhost:8080/*callback*'], label: 'Patterns' },
      },
    });
    const f = facts({ url: 'http://localhost:8080/auth/callback?code=x' });
    expect(ev(config({ recipes: [ref('finished')] }), f, { finished }).close?.afterMs).toBe(3000);
    const r = ev(config({ recipes: [ref('finished', { params: { delay: '5s' } })] }), f, { finished });
    expect(r.close).toEqual({ key: 'finished/oauth', afterMs: 5000, mode: 'auto', dryRun: false });
  });
  it('a recipe with an invalid param type is reported; the other rules still evaluate', () => {
    const bad = recipe('bad', [rule('x', { url: '*' }, [group('{params.t}')])], { params: { t: { type: 'string', default: 'T', label: 't' } } });
    const c = config({ rules: [rule('u', { url: 'github.com/*' }, [group('U')])], recipes: [ref('bad', { params: { t: 7 } })] });
    const { program: p, errors } = compileProgram(c, { bad });
    expect(errors.map((e) => e.key)).toEqual(['bad']);
    const r = evaluateTab(p, facts(), NOW);
    expect(r.group?.title).toBe('U');
    expect(r.matched).toEqual(['user/u']);
  });
});

describe('evaluateTab: templates, tables and colors', () => {
  it('color {repo|map:repoColors|default:grey} resolves through config.tables', () => {
    const rs = [rule('g', { url: 'github.com/acme/:repo/*' }, [group('{repo}', '{repo|map:repoColors|default:grey}')])];
    const tables = { repoColors: { api: 'red' } };
    expect(ev(config({ rules: rs, tables })).group).toMatchObject({ title: 'api', color: 'red' });
    expect(ev(config({ rules: rs, tables }), facts({ url: 'https://github.com/acme/web/pull/1' })).group).toMatchObject({ title: 'web', color: 'grey' });
  });
  it('title renders with program.tables too (recipe tables, overridden by config)', () => {
    const r = recipe('r', [rule('g', { url: 'github.com/acme/:repo/*' }, [group('{repo|map:names}')])], { tables: { names: { api: 'API', web: 'Web' } } });
    const c = config({ recipes: [ref('r')], tables: { names: { api: 'The API' } } });
    expect(ev(c, facts(), { r }).group?.title).toBe('The API');
    expect(ev(c, facts({ url: 'https://github.com/acme/web/x' }), { r }).group?.title).toBe('Web');
  });
  it('a color outside the 9 Chrome colors falls back to grey and is marked invalidColor', () => {
    const rs = [rule('g', { url: 'github.com/acme/:repo/*' }, [group('G', '{repo|map:c}')])];
    const r = ev(config({ rules: rs, tables: { c: { api: 'magenta' } } }));
    expect(r.group).toMatchObject({ color: 'grey', invalidColor: true });
    expect(ev(config({ rules: [rule('g', { url: '*' }, [group('G', 'red')])] })).group).not.toHaveProperty('invalidColor');
  });
  it('group defaults', () => {
    expect(ev(config({ rules: [rule('g', { url: '*' }, [group('G')])] })).group).toEqual({
      key: 'user/g', index: 0, title: 'G', color: 'blue', collapsed: false, sortGroups: 'creation', strict: true, merge: false, anchors: [], dryRun: false,
    });
    const more = { collapsed: true, sortGroups: 'alphabetical', strict: false, merge: true, anchors: ['https://a.com/'] };
    expect(ev(config({ rules: [rule('g', { url: '*' }, [group('G', 'red', more)])] })).group).toMatchObject(more);
  });
  it('title-regex named groups are template vars', () => {
    const rs = [rule('g', { all: [{ url: 'github.com/*' }, { title: '/^(?<num>\\d+)/' }] }, [group('#{num}')])];
    expect(ev(config({ rules: rs })).group?.title).toBe('#42');
  });
  it('extract from url/title regexes and from page selectors become template vars', () => {
    const rs = [rule('g', { url: 'github.com/*' }, [group('{org}-{n}-{h}')], {
      extract: {
        org: { from: 'url', regex: 'github\\.com/(\\w+)/' },
        n: { from: 'title', regex: '(?<num>\\d+) Fix', group: 'num' },
        h: { selector: 'h1' },
      },
    })];
    const page = { texts: [], extracts: { 'user/g.h': 'Head' }, formEdited: false };
    expect(ev(config({ rules: rs }), facts({}, { page })).group?.title).toBe('acme-42-Head');
  });
  it('a matched rule with a selector extract and no page facts asks for the page', () => {
    const rs = [rule('g', { url: 'github.com/*' }, [group('G {h}')], { extract: { h: { selector: 'h1' } } })];
    const r = ev(config({ rules: rs }));
    expect(r.needsPage).toBe(true);
    expect(r.group?.title).toBe('G ');
  });
});

describe('evaluateTab: group invariants (R7)', () => {
  const rs = [
    rule('g', { url: '*' }, [group('G')]),
    rule('c', { url: '*' }, [{ close: {} }]),
  ];
  it('never groups a pinned tab (other kinds still apply)', () => {
    const r = ev(config({ rules: rs }), facts({ pinned: true }));
    expect(r.group).toBeUndefined();
    expect(r.close?.key).toBe('user/c');
    expect(r.matched).toEqual(['user/g', 'user/c']);
  });
  it('never groups an exempt URL', () => {
    const rs2 = [rule('g', { url: 'chrome://*' }, [group('G')])];
    expect(ev(config({ rules: rs2 }), facts({ url: 'chrome://settings/' })).group).toBeUndefined();
  });
  it('uses pendingUrl for the exemption check, as M1', () => {
    expect(ev(config({ rules: rs }), facts({ pendingUrl: 'chrome://newtab/' })).group).toBeUndefined();
  });
  it('an empty rendered title falls through to the next matching group rule', () => {
    const c = config({ rules: [
      rule('e', { url: 'github.com/:org/*' }, [group('{org|map:t}')]),
      rule('f', { url: '*' }, [group('Fallback')]),
    ], tables: { t: {} } });
    expect(ev(c).group).toMatchObject({ key: 'user/f', index: 1, title: 'Fallback' });
  });
});

describe('evaluateTab: groupNeedsPage', () => {
  it('set when the winning group rule lacks a selector extract, or a higher group rule waits on pageText', () => {
    const sel = rule('s', { url: '*' }, [group('G {h}')], { extract: { h: { selector: 'h1' } } });
    expect(ev(config({ rules: [sel] })).groupNeedsPage).toBe(true);
    expect(ev(config({ rules: [sel] }), facts({}, { page: { texts: [], extracts: { 'user/s.h': 'x' }, formEdited: false } })).groupNeedsPage).toBe(false);
    const pt = rule('p', { pageText: 'done' }, [group('Done')]);
    const plain = rule('q', { url: '*' }, [group('Plain')]);
    expect(ev(config({ rules: [pt, plain], order: ['user/p', 'user/q'] })).groupNeedsPage).toBe(true);
    // A pageText rule below the winner, or one without a group action, cannot change the group.
    expect(ev(config({ rules: [plain, pt], order: ['user/q', 'user/p'] })).groupNeedsPage).toBe(false);
    const ptClose = rule('pc', { pageText: 'done' }, [{ close: {} }]);
    const r = ev(config({ rules: [ptClose, plain], order: ['user/pc', 'user/q'] }));
    expect(r).toMatchObject({ needsPage: true, groupNeedsPage: false });
  });
});

describe('evaluateTab: needsPage', () => {
  it('a pageText condition without page facts sets needsPage and does not match', () => {
    const c = config({ rules: [rule('p', { all: [{ url: '*' }, { pageText: 'done' }] }, [{ close: {} }])] });
    const r = ev(c);
    expect(r).toMatchObject({ needsPage: true, matched: [] });
    expect(r.close).toBeUndefined();
    const withPage = ev(c, facts({}, { page: { texts: ['All done'], extracts: {}, formEdited: false } }));
    expect(withPage).toMatchObject({ needsPage: false, matched: ['user/p'] });
  });
});
