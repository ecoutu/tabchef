import { describe, expect, it } from 'vitest';
import { asGroupRule, orderedUserRules } from '../../../src/core/config/group-view';
import { groupRuleToRule } from '../../../src/core/config/migrate';
import { defaultConfig } from '../../../src/core/config/defaults';
import type { Config, GroupRule } from '../../../src/core/types';
import type { Rule } from '../../../src/core/lang/types';

const g = (id: string, o: Partial<GroupRule> = {}): GroupRule => ({
  id, name: id, enabled: true, match: { url: `${id}.com/*` }, group: { title: id, color: 'blue' }, ...o,
});
const v2 = (id: string, o: Partial<Rule> = {}): Rule => ({ ...groupRuleToRule(g(id)), ...o });
const cfg = (rules: Rule[], order: string[]): Config => ({ ...defaultConfig(), rules, order });

describe('asGroupRule', () => {
  it('inverts groupRuleToRule for every M1 field', () => {
    const full = g('a', { group: { title: 'A', color: 'red', collapsed: true }, sortGroups: 'alphabetical', dedupe: 'ask', strict: false, merge: true });
    expect(asGroupRule(groupRuleToRule(full))).toEqual(full);
    expect(asGroupRule(groupRuleToRule(g('b')))).toEqual(g('b'));
  });
  it('rejects rules the M1 engine cannot express', () => {
    expect(asGroupRule(v2('a', { match: { title: 'x' } }))).toBeNull();
    expect(asGroupRule(v2('a', { match: { all: [{ url: 'a.com/*' }] } }))).toBeNull();
    expect(asGroupRule(v2('a', { dryRun: true }))).toBeNull();
    expect(asGroupRule(v2('a', { extract: { x: { from: 'url', regex: 'x' } } }))).toBeNull();
    expect(asGroupRule(v2('a', { actions: [{ close: {} }] }))).toBeNull();
    expect(asGroupRule(v2('a', { actions: [{ group: { title: 'A', color: 'blue' } }, { group: { title: 'B', color: 'blue' } }] }))).toBeNull();
    expect(asGroupRule(v2('a', { actions: [{ group: { title: 'A', color: '{c}' } }] }))).toBeNull();
    expect(asGroupRule(v2('a', { actions: [{ group: { title: 'A', color: 'blue', anchors: ['x'] } }] }))).toBeNull();
    expect(asGroupRule(v2('a', { actions: [{ group: { title: 'A', color: 'blue' } }, { dedupe: { matchTitle: true } }] }))).toBeNull();
  });
});

describe('orderedUserRules', () => {
  it('follows order, then appends user rules missing from it', () => {
    const c = cfg([v2('a'), v2('b'), v2('c')], ['user/c', 'github-prs/pr', 'user/a', 'user/gone']);
    expect(orderedUserRules(c).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
});
