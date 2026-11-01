import { describe, it, expect } from 'vitest';
import { reorderRules, addRule, updateRule, removeRule, previewMatches, patternError, configPatternErrors, errorsForPath } from '../../src/ui/rules-model';
import { defaultConfig } from '../../src/core/config/defaults';
import { validateConfig } from '../../src/core/config/schema';
import type { Config, GroupRule, TabSnap } from '../../src/core/types';

const rule = (id: string, url: string | string[] = 'a.com/*'): GroupRule => ({ id, name: id, enabled: true, match: { url }, group: { title: id, color: 'blue' } });
const cfg = (...ids: string[]): Config => ({ ...defaultConfig(), groupRules: ids.map((i) => rule(i)) });
const tab = (id: number, url: string): TabSnap => ({ id, windowId: 1, index: id, url, title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false });

describe('rules-model', () => {
  it('reorderRules moves a rule, keeps ids, does not mutate', () => {
    const c = cfg('a', 'b', 'c');
    const r = reorderRules(c, 0, 2);
    expect(r.groupRules.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(c.groupRules.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(reorderRules(c, 1, 9)).toBe(c);
    expect(reorderRules(c, 1, 1)).toBe(c);
  });

  it('addRule produces a valid config with a generated id', () => {
    const r = addRule(defaultConfig());
    expect(r.groupRules).toHaveLength(1);
    expect(r.groupRules[0]!.id).toMatch(/\S/);
    expect(validateConfig(r).ok).toBe(true);
    const r2 = addRule(r, { name: 'X' });
    expect(r2.groupRules[1]!.name).toBe('X');
    expect(r2.groupRules[1]!.id).not.toBe(r2.groupRules[0]!.id);
    expect(validateConfig(r2).ok).toBe(true);
  });

  it('updateRule patches by id and removeRule deletes', () => {
    const c = cfg('a', 'b');
    expect(updateRule(c, 'b', { enabled: false }).groupRules[1]!.enabled).toBe(false);
    expect(updateRule(c, 'zz', { enabled: false })).toBe(c);
    expect(removeRule(c, 'a').groupRules.map((x) => x.id)).toEqual(['b']);
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
    c.groupRules[0]!.match.url = ['ok.com/*', '/(/'];
    c.dedupe.allowDuplicates = ['/(/'];
    expect(configPatternErrors(c).map((e) => e.path)).toEqual(['/groupRules/0/match/url/1', '/dedupe/allowDuplicates/0']);
  });

  it('errorsForPath matches server errors by path prefix', () => {
    const errs = ['/groupRules/2/group/color must be equal', '/dedupe/mode bad', 'duplicate rule id: x'];
    expect(errorsForPath(errs, '/groupRules/2/group/color')).toEqual(['must be equal']);
    expect(errorsForPath(errs, '/groupRules/2')).toEqual(['group/color must be equal']);
    expect(errorsForPath(errs, '/groupRules/1')).toEqual([]);
  });
});

describe('unclaimedErrors', () => {
  it('keeps only errors no field shows', async () => {
    const { unclaimedErrors } = await import('../../src/ui/rules-model');
    expect(unclaimedErrors(['/groupRules/2/group/color bad', '/ must have x', 'duplicate rule id: x', '/dedupe/mode bad']))
      .toEqual(['/ must have x', 'duplicate rule id: x']);
  });
});
