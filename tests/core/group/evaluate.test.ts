import { describe, expect, it } from 'vitest';
import { evaluateGroupRules } from '../../../src/core/group/evaluate';
import type { GroupRule, TabSnap } from '../../../src/core/types';
import type { Rule } from '../../../src/core/lang/types';
import { defaultConfig } from '../../../src/core/config/defaults';
import { programFromGroupRules, programOf } from '../../helpers/config';

const tab = (o: Partial<TabSnap> = {}): TabSnap => ({
  id: 1, windowId: 1, index: 0, url: 'https://github.com/acme/widgets/pulls', title: 't',
  pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const rule = (o: Partial<GroupRule> & { url?: string | string[]; title?: string } = {}): GroupRule => ({
  id: o.id ?? 'r', name: 'n', enabled: o.enabled ?? true,
  match: { url: o.url ?? 'github.com/*' },
  group: { title: o.title ?? 'GH', color: 'blue', ...(o.group ?? {}) },
  ...(o.sortGroups ? { sortGroups: o.sortGroups } : {}),
  ...(o.strict !== undefined ? { strict: o.strict } : {}),
  ...(o.merge !== undefined ? { merge: o.merge } : {}),
});
/** The M1 rules, migrated and compiled (the engine's input since T6). */
const p = (...rules: GroupRule[]) => programFromGroupRules(rules);
const v2 = (rules: Rule[], tables: Record<string, Record<string, string>> = {}) => programOf({ ...defaultConfig(), rules, tables });

describe('evaluateGroupRules', () => {
  it('first match wins by priority; ruleId is the rule key, ruleIndex its priority', () => {
    const r = evaluateGroupRules(tab(), p(rule({ id: 'a', title: 'A' }), rule({ id: 'b', title: 'B' })));
    expect(r).toMatchObject({ ruleId: 'user/a', key: 'user/a', ruleIndex: 0, title: 'A', color: 'blue', anchors: [] });
  });
  it('skips disabled rules', () => {
    const r = evaluateGroupRules(tab(), p(rule({ id: 'a', enabled: false }), rule({ id: 'b' })));
    expect(r?.ruleId).toBe('user/b');
    expect(r?.ruleIndex).toBe(0);
  });
  it('renders {repo} from captures', () => {
    const r = evaluateGroupRules(tab(), p(rule({ url: 'github.com/:org/:repo/*', title: '{org}/{repo|upper}' })));
    expect(r?.title).toBe('acme/WIDGETS');
  });
  it('returns null for pinned tabs', () => {
    expect(evaluateGroupRules(tab({ pinned: true }), p(rule()))).toBeNull();
  });
  it('returns null for exempt urls', () => {
    expect(evaluateGroupRules(tab({ url: 'chrome://settings' }), p(rule({ url: '*' })))).toBeNull();
  });
  it('returns null when nothing matches', () => {
    expect(evaluateGroupRules(tab(), p(rule({ url: 'example.com/*' })))).toBeNull();
  });
  it('accepts an array of patterns; first matching pattern supplies captures', () => {
    // Since M2 every pattern must capture the title's vars (compileProgram rejects the rule otherwise).
    const rules = [rule({ url: ['example.com/:repo/*', 'github.com/:org/:repo/*'], title: '{repo}' })];
    expect(evaluateGroupRules(tab(), p(...rules))?.title).toBe('widgets');
    expect(evaluateGroupRules(tab({ url: 'https://example.com/ex/1' }), p(...rules))?.title).toBe('ex');
  });
  it('a title that renders empty is no match; the next rule is tried (I1)', () => {
    const rules = [rule({ id: 'gh', url: ['/example\\.com\\/(?<repo>z)?/', 'github.com/:org/:repo/*'], title: '{repo}' })];
    expect(evaluateGroupRules(tab({ url: 'https://example.com/x' }), p(...rules))).toBeNull();
    const withFallback = [...rules, rule({ id: 'any', url: 'example.com/*', title: 'Ex' })];
    expect(evaluateGroupRules(tab({ url: 'https://example.com/x' }), p(...withFallback))).toMatchObject({ ruleId: 'user/any', title: 'Ex' });
    // A literal empty title is a compile error since M2 (tests/core/lang/compile.test.ts); renders-empty is the case left.
  });
  it('uses pendingUrl when non-empty, else url', () => {
    const rules = p(rule({ url: 'example.com/*' }));
    expect(evaluateGroupRules(tab({ pendingUrl: 'https://example.com/a' }), rules)).not.toBeNull();
    expect(evaluateGroupRules(tab({ pendingUrl: '' }), rules)).toBeNull();
  });
  it('exempt pendingUrl wins over url', () => {
    expect(evaluateGroupRules(tab({ pendingUrl: 'chrome://newtab' }), p(rule()))).toBeNull();
  });
  it('applies defaults', () => {
    expect(evaluateGroupRules(tab(), p(rule()))).toMatchObject({
      collapsed: false, sortGroups: 'creation', strict: true, merge: false, anchors: [], dryRun: false,
    });
  });
  it('honours explicit values', () => {
    const r = rule({ sortGroups: 'alphabetical', strict: false, merge: true, group: { title: 'GH', color: 'red', collapsed: true } });
    expect(evaluateGroupRules(tab(), p(r))).toMatchObject({
      collapsed: true, sortGroups: 'alphabetical', strict: false, merge: true, color: 'red',
    });
  });
  it('renders titles and colors through program tables (map: filter)', () => {
    const r: Rule = {
      id: 't', name: 't', enabled: true, match: { url: 'github.com/:org/*' },
      actions: [{ group: { title: '{org|map:teams}', color: '{org|map:colors}' } }],
    };
    expect(evaluateGroupRules(tab(), v2([r], { teams: { acme: 'Acme Inc' }, colors: { acme: 'green' } }))).toMatchObject({ title: 'Acme Inc', color: 'green' });
  });
  it('flags an invalid rendered color (grey fallback)', () => {
    const r: Rule = { id: 'c', name: 'c', enabled: true, match: { url: 'github.com/:org/*' }, actions: [{ group: { title: 'x', color: '{org}' } }] };
    expect(evaluateGroupRules(tab(), v2([r]))).toMatchObject({ color: 'grey', invalidColor: true });
  });
  it('passes facts through (opener condition)', () => {
    const r: Rule = { id: 'o', name: 'o', enabled: true, match: { opener: { url: 'a.com/*' } }, actions: [{ group: { title: 'From A', color: 'blue' } }] };
    expect(evaluateGroupRules(tab(), v2([r]))).toBeNull();
    expect(evaluateGroupRules(tab(), v2([r]), { opener: tab({ id: 9, url: 'https://a.com/x' }) })?.title).toBe('From A');
  });
});
