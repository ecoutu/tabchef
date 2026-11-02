import { describe, it, expect } from 'vitest';
import { reorderRules, addRule, updateRule, removeRule, previewMatches, patternError, configPatternErrors, errorsForPath, orderedUserRules, formRule } from '../../src/ui/rules-model';
import { defaultConfig } from '../../src/core/config/defaults';
import { validateConfig } from '../../src/core/config/schema';
import type { Config, GroupRule, TabSnap } from '../../src/core/types';
import { withGroupRules } from '../helpers/config';

const rule = (id: string, url: string | string[] = 'a.com/*'): GroupRule => ({ id, name: id, enabled: true, match: { url }, group: { title: id, color: 'blue' } });
const cfg = (...ids: string[]): Config => withGroupRules(ids.map((i) => rule(i)));
const shownIds = (c: Config) => orderedUserRules(c).map((x) => x.id);
const tab = (id: number, url: string): TabSnap => ({ id, windowId: 1, index: id, url, title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false });

describe('rules-model', () => {
  it('reorderRules moves a rule by editing order only, keeps ids, does not mutate', () => {
    const c = cfg('a', 'b', 'c');
    const r = reorderRules(c, 0, 2);
    expect(r.order).toEqual(['user/b', 'user/c', 'user/a']);
    expect(shownIds(r)).toEqual(['b', 'c', 'a']);
    expect(r.rules).toBe(c.rules);
    expect(c.order).toEqual(['user/a', 'user/b', 'user/c']);
    expect(reorderRules(c, 1, 9)).toBe(c);
    expect(reorderRules(c, 1, 1)).toBe(c);
  });

  it('reorderRules keeps recipe keys in place and appends user rules missing from order', () => {
    const c = { ...cfg('a', 'b', 'c'), order: ['user/a', 'github-prs/pr', 'user/b'] };
    expect(shownIds(c)).toEqual(['a', 'b', 'c']);
    expect(reorderRules(c, 2, 0).order).toEqual(['user/c', 'github-prs/pr', 'user/a', 'user/b']);
    expect(validateConfig(reorderRules(c, 2, 0)).ok).toBe(true);
  });

  it('addRule produces a valid config with a generated id', () => {
    const r = addRule(defaultConfig());
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]!.id).toMatch(/\S/);
    expect(r.order).toEqual([`user/${r.rules[0]!.id}`]);
    expect(validateConfig(r).ok).toBe(true);
    const r2 = addRule(r, { name: 'X' });
    expect(r2.rules[1]!.name).toBe('X');
    expect(r2.rules[1]!.id).not.toBe(r2.rules[0]!.id);
    expect(validateConfig(r2).ok).toBe(true);
  });

  it('updateRule patches by id and removeRule deletes', () => {
    const c = cfg('a', 'b');
    expect(updateRule(c, 'b', { enabled: false }).rules[1]!.enabled).toBe(false);
    expect(formRule(updateRule(c, 'b', { strict: false, dedupe: 'ask' }).rules[1]!)).toMatchObject({ strict: false, dedupe: 'ask' });
    expect(formRule(updateRule(updateRule(c, 'b', { dedupe: 'ask' }), 'b', { dedupe: undefined }).rules[1]!)!.dedupe).toBeUndefined();
    expect(updateRule(c, 'zz', { enabled: false })).toBe(c);
    const removed = removeRule(c, 'a');
    expect(removed.rules.map((x) => x.id)).toEqual(['b']);
    expect(removed.order).toEqual(['user/b']);
  });

  it('rules the form cannot express are not editable through updateRule', () => {
    const c = { ...defaultConfig(), rules: [{ id: 'x', name: 'X', enabled: true, match: { title: '*a*' }, actions: [{ close: {} }] }], order: ['user/x'] } as Config;
    expect(formRule(c.rules[0]!)).toBeNull();
    expect(updateRule(c, 'x', { enabled: false })).toBe(c);
  });

  it('previewMatches returns only matching tabs', () => {
    const tabs = [tab(1, 'https://github.com/acme/x'), tab(2, 'https://github.com/other/y'), tab(3, 'https://github.com/acme/z')];
    expect(previewMatches(rule('r', 'github.com/acme/*'), tabs).map((t) => t.id)).toEqual([1, 3]);
    expect(previewMatches(rule('r', ['github.com/other/*', 'nomatch.test/*']), tabs).map((t) => t.id)).toEqual([2]);
  });

  it('previewMatches tolerates invalid patterns', () => {
    expect(previewMatches(rule('r', '/(/'), [tab(1, 'https://a.com/')])).toEqual([]);
  });

  it('patternError reports compile errors', () => {
    expect(patternError('/(/')).toMatch(/invalid regex/);
    expect(patternError('a.com/*')).toBeUndefined();
  });

  it('configPatternErrors covers rules and dedupe lists', () => {
    const c = cfg('a');
    expect(configPatternErrors(c)).toEqual([]);
    c.rules[0]!.match = { url: ['ok.com/*', '/(/'] };
    c.dedupe.allowDuplicates = ['/(/'];
    expect(configPatternErrors(c).map((e) => e.path)).toEqual(['/rules/0/match/url/1', '/dedupe/allowDuplicates/0']);
  });

  it('errorsForPath matches server errors by path prefix', () => {
    const errs = ['/rules/2/actions/0/group/color must be equal', '/dedupe/mode bad', 'duplicate rule id: x'];
    expect(errorsForPath(errs, '/rules/2/actions/0/group/color')).toEqual(['must be equal']);
    expect(errorsForPath(errs, '/rules/2')).toEqual(['actions/0/group/color must be equal']);
    expect(errorsForPath(errs, '/rules/1')).toEqual([]);
  });
});

describe('unclaimedErrors', () => {
  it('keeps only errors no field shows', async () => {
    const { unclaimedErrors } = await import('../../src/ui/rules-model');
    expect(unclaimedErrors(['/rules/2/actions/0/group/color bad', '/rules/0/actions/1/dedupe/mode bad', '/ must have x', '/rules/1/id duplicate rule id: x', '/dedupe/mode bad']))
      .toEqual(['/ must have x', '/rules/1/id duplicate rule id: x']);
  });
});
