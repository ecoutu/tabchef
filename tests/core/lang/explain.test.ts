import { describe, it, expect, beforeAll } from 'vitest';
import raw from '../../../fixtures/auto-group-tabs.json?raw';
import { importAutoGroupTabs } from '../../../src/core/import/auto-group-tabs';
import { compileProgram } from '../../../src/core/lang/compile';
import { defaultConfig } from '../../../src/core/config/defaults';
import { explainTab, findShadowed, shadowText } from '../../../src/core/lang/explain';
import type { Action, Program, Rule, TabFacts } from '../../../src/core/lang/types';
import type { Config, GroupRule, TabSnap } from '../../../src/core/types';
import { withGroupRules } from '../../helpers/config';

const NOW = 1_800_000_000_000;
const tab = (url: string, over: Partial<TabSnap> = {}): TabSnap => ({
  id: 1, windowId: 1, index: 0, url, title: 'A tab', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...over,
});
const facts = (url: string, over: Partial<TabFacts> = {}): TabFacts => ({ tab: tab(url), ...over });
const rule = (id: string, match: Rule['match'], actions: Action[], over: Partial<Rule> = {}): Rule => ({ id, name: `Rule ${id}`, enabled: true, match, actions, ...over });
const group = (title: string): Action => ({ group: { title, color: 'blue' } });
const config = (rules: Rule[], over: Partial<Config> = {}): Config => ({ ...defaultConfig(), recipes: [], rules, order: rules.map((r) => `user/${r.id}`), ...over });
const program = (c: Config): Program => {
  const { program: p, errors } = compileProgram(c, {});
  expect(errors).toEqual([]);
  return p;
};

let agt: GroupRule[];
const byName = (n: string): GroupRule => agt.find((r) => r.name === n)!;
const keyOf = (n: string): string => `user/${byName(n).id}`;
const fixtureProgram = (rules: GroupRule[]): Program => program({ ...withGroupRules(rules), recipes: [] });
beforeAll(async () => { agt = (await importAutoGroupTabs(JSON.parse(raw))).rules; });

describe('explainTab', () => {
  it('fixture: a tab matching "Github Acme" and "Github Other" → the first won group, the second lost it to the first', () => {
    const p = fixtureProgram(agt);
    const out = explainTab(p, facts('https://github.com/acme/web/pull/1'), NOW);
    const acme = out.find((e) => e.key === keyOf('Github Acme'))!;
    const other = out.find((e) => e.key === keyOf('Github Other'))!;
    expect(acme).toMatchObject({ name: 'Github Acme', actions: ['group'], won: ['group'], lostTo: {} });
    expect(other).toMatchObject({ name: 'Github Other', actions: ['group'], won: [], lostTo: { group: keyOf('Github Acme') } });
    // Only relevant rules are listed, in priority order: the repo-N and GCP rules do not match this tab.
    expect(out.map((e) => e.key)).toEqual([keyOf('Github Acme'), keyOf('Github Other')]);
  });

  it('different kinds can be won by different rules (R34)', () => {
    const p = program(config([
      rule('a', { url: 'x.com/*' }, [group('A')]),
      rule('b', { url: 'x.com/*' }, [group('B'), { dedupe: { mode: 'off' } }]),
    ]));
    const [a, b] = explainTab(p, facts('https://x.com/1'), NOW);
    expect(a).toMatchObject({ key: 'user/a', actions: ['group'], won: ['group'], lostTo: {} });
    expect(b).toMatchObject({ key: 'user/b', actions: ['group', 'dedupe'], won: ['dedupe'], lostTo: { group: 'user/a' } });
  });

  it('dry-run rules (R48): labelled, won = what they would win over the full Program; live rules read the live outcome', () => {
    const p = program(config([
      rule('d', { url: 'x.com/*' }, [group('D')], { dryRun: true }),
      rule('l', { url: 'x.com/*' }, [group('L')]),
    ]));
    const [d, l] = explainTab(p, facts('https://x.com/1'), NOW);
    expect(d).toMatchObject({ key: 'user/d', dryRun: true, won: ['group'], lostTo: {} });
    // The dry-run rule falls through: the live rule really groups the tab.
    expect(l).toMatchObject({ key: 'user/l', won: ['group'], lostTo: {} });
    expect(l!.dryRun).toBeUndefined();
  });

  it('a dry-run rule below a live winner lost to it', () => {
    const p = program(config([
      rule('l', { url: 'x.com/*' }, [group('L')]),
      rule('d', { url: 'x.com/*' }, [group('D')], { dryRun: true }),
    ]));
    const d = explainTab(p, facts('https://x.com/1'), NOW).find((e) => e.key === 'user/d');
    expect(d).toMatchObject({ dryRun: true, won: [], lostTo: { group: 'user/l' } });
  });

  it('paused rules (R45) carry their reason and take no part: the next rule wins', () => {
    const p = program(config([rule('a', { url: 'x.com/*' }, [group('A')]), rule('b', { url: 'x.com/*' }, [group('B')])]));
    const out = explainTab(p, facts('https://x.com/1'), NOW, { 'user/a': 'Paused: needs access to https://x.com/*' });
    expect(out[0]).toMatchObject({ key: 'user/a', paused: 'Paused: needs access to https://x.com/*', won: [], lostTo: {} });
    expect(out[1]).toMatchObject({ key: 'user/b', won: ['group'], lostTo: {} });
  });

  it('a paused recipe pauses every one of its rules', () => {
    const recipe = { recipe: 'r', version: 1, name: 'R', description: 'R', rules: [rule('x', { url: 'x.com/*' }, [group('X')])] };
    const { program: p } = compileProgram({ ...defaultConfig(), recipes: [{ id: 'r', enabled: true, params: {}, source: 'user', body: recipe }] }, {});
    const [x] = explainTab(p, facts('https://x.com/1'), NOW, { r: 'Paused: needs access to https://x.com/*' });
    expect(x).toMatchObject({ key: 'r/x', name: 'Rule x', paused: 'Paused: needs access to https://x.com/*' });
  });

  it('relevance: a rule that needs page facts is listed with needsPage while the facts are missing', () => {
    const p = program(config([
      rule('pt', { all: [{ url: 'x.com/*' }, { pageText: 'hello' }] }, [{ close: {} }]),
      rule('no', { url: 'y.com/*' }, [group('Y')]),
    ]));
    const out = explainTab(p, facts('https://x.com/1'), NOW);
    expect(out).toEqual([expect.objectContaining({ key: 'user/pt', matched: false, needsPage: true, won: [], lostTo: {} })]);
    const withPage = explainTab(p, facts('https://x.com/1', { page: { texts: ['hello'], extracts: {}, formEdited: false } }), NOW);
    expect(withPage[0]).toMatchObject({ key: 'user/pt', matched: true, won: ['close'] });
    expect(withPage[0]!.needsPage).toBeUndefined();
    // Facts present but the text is not there: still relevant (listed), not matched.
    const miss = explainTab(p, facts('https://x.com/1', { page: { texts: [], extracts: {}, formEdited: false } }), NOW);
    expect(miss[0]).toMatchObject({ key: 'user/pt', matched: false, won: [] });
  });

  it('a pinned tab: the group rule matched but nobody wins group', () => {
    const p = program(config([rule('a', { url: 'x.com/*' }, [group('A')])]));
    const [a] = explainTab(p, { tab: tab('https://x.com/1', { pinned: true }) }, NOW);
    expect(a).toMatchObject({ matched: true, won: [], lostTo: {} });
  });
});

describe('findShadowed', () => {
  it('fixture, original order: only repo-10 is reported, shadowed by repo-1 (`repo-1*` catches `repo-10x`)', () => {
    expect(findShadowed(fixtureProgram(agt))).toEqual([{ key: keyOf('repo-10'), shadowedBy: keyOf('repo-1') }]);
  });

  it('fixture reordered with "Github Other" first: every acme rule is shadowed by it', () => {
    const other = byName('Github Other');
    const out = findShadowed(fixtureProgram([other, ...agt.filter((r) => r !== other)]));
    const acme = agt.filter((r) => r.match.url.toString().includes('github.com/acme'));
    expect(acme).toHaveLength(11);
    expect(out).toEqual(acme.map((r) => ({ key: `user/${r.id}`, shadowedBy: keyOf('Github Other') })));
  });

  it('regex-only rules are never reported', () => {
    const p = program(config([
      rule('all', { url: '*' }, [group('All')]),
      rule('re', { url: '/github\\.com/' }, [group('Re')]),
      rule('re2', { url: ['/a/', '/b/'] }, [group('Re2')]),
    ]));
    expect(findShadowed(p)).toEqual([]);
  });

  it('needs the same action kind', () => {
    const p = program(config([
      rule('g', { url: 'x.com/*' }, [group('G')]),
      rule('d', { url: 'x.com/a/*' }, [{ dedupe: { mode: 'off' } }]),
      rule('g2', { url: 'x.com/b/*' }, [group('G2')]),
    ]));
    expect(findShadowed(p)).toEqual([{ key: 'user/g2', shadowedBy: 'user/g' }]);
  });

  it('A with not / pageText / title conditions never shadows', () => {
    for (const extra of [{ not: { pinned: true } }, { pageText: 'x' }, { title: '*' }]) {
      const p = program(config([
        rule('a', { all: [{ url: 'x.com/*' }, extra] }, [group('A')]),
        rule('b', { url: 'x.com/b/*' }, [group('B')]),
      ]));
      expect(findShadowed(p)).toEqual([]);
    }
  });

  it('A must catch every sample (`:param` → p1): a partial overlap is not reported', () => {
    const p = program(config([
      rule('a', { url: 'x.com/p1/*' }, [group('A')]),
      rule('b', { url: ['x.com/:org/*', 'y.com/*'] }, [group('B')]),
      rule('c', { url: 'x.com/:org/*' }, [group('C')]),
    ]));
    expect(findShadowed(p)).toEqual([{ key: 'user/c', shadowedBy: 'user/a' }]);
  });

  it('a dry-run A does not shadow a live B (R48 falls through)', () => {
    const p = program(config([
      rule('a', { url: 'x.com/*' }, [group('A')], { dryRun: true }),
      rule('b', { url: 'x.com/b/*' }, [group('B')]),
    ]));
    expect(findShadowed(p)).toEqual([]);
  });

  it('copy', () => {
    expect(shadowText('Github Other')).toBe('Likely never matches: rule "Github Other" above catches these first.');
  });
});
