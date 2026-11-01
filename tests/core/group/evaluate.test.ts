import { describe, expect, it } from 'vitest';
import { evaluateGroupRules } from '../../../src/core/group/evaluate';
import type { GroupRule, TabSnap } from '../../../src/core/types';

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

describe('evaluateGroupRules', () => {
  it('first match wins by array order', () => {
    const r = evaluateGroupRules(tab(), [rule({ id: 'a', title: 'A' }), rule({ id: 'b', title: 'B' })]);
    expect(r).toMatchObject({ ruleId: 'a', ruleIndex: 0, title: 'A', color: 'blue' });
  });
  it('skips disabled rules', () => {
    const r = evaluateGroupRules(tab(), [rule({ id: 'a', enabled: false }), rule({ id: 'b' })]);
    expect(r?.ruleId).toBe('b');
    expect(r?.ruleIndex).toBe(1);
  });
  it('renders {repo} from captures', () => {
    const r = evaluateGroupRules(tab(), [rule({ url: 'github.com/:org/:repo/*', title: '{org}/{repo|upper}' })]);
    expect(r?.title).toBe('acme/WIDGETS');
  });
  it('returns null for pinned tabs', () => {
    expect(evaluateGroupRules(tab({ pinned: true }), [rule()])).toBeNull();
  });
  it('returns null for exempt urls', () => {
    expect(evaluateGroupRules(tab({ url: 'chrome://settings' }), [rule({ url: '*' })])).toBeNull();
  });
  it('returns null when nothing matches', () => {
    expect(evaluateGroupRules(tab(), [rule({ url: 'example.com/*' })])).toBeNull();
  });
  it('accepts an array of patterns; first matching pattern supplies captures', () => {
    const rules = [rule({ url: ['example.com/*', 'github.com/:org/:repo/*'], title: '{repo}' })];
    expect(evaluateGroupRules(tab(), rules)?.title).toBe('widgets');
  });
  it('a title that renders empty is no match; the next rule is tried (I1)', () => {
    const rules = [rule({ id: 'gh', url: ['example.com/*', 'github.com/:org/:repo/*'], title: '{repo}' })];
    expect(evaluateGroupRules(tab({ url: 'https://example.com/x' }), rules)).toBeNull();
    const withFallback = [...rules, rule({ id: 'any', url: 'example.com/*', title: 'Ex' })];
    expect(evaluateGroupRules(tab({ url: 'https://example.com/x' }), withFallback)).toMatchObject({ ruleId: 'any', title: 'Ex' });
    expect(evaluateGroupRules(tab(), [rule({ title: '' })])).toBeNull();
  });
  it('uses pendingUrl when non-empty, else url', () => {
    const rules = [rule({ url: 'example.com/*' })];
    expect(evaluateGroupRules(tab({ pendingUrl: 'https://example.com/a' }), rules)).not.toBeNull();
    expect(evaluateGroupRules(tab({ pendingUrl: '' }), rules)).toBeNull();
  });
  it('exempt pendingUrl wins over url', () => {
    expect(evaluateGroupRules(tab({ pendingUrl: 'chrome://newtab' }), [rule()])).toBeNull();
  });
  it('applies defaults', () => {
    expect(evaluateGroupRules(tab(), [rule()])).toMatchObject({
      collapsed: false, sortGroups: 'creation', strict: true, merge: false,
    });
  });
  it('honours explicit values', () => {
    const r = rule({ sortGroups: 'alphabetical', strict: false, merge: true, group: { title: 'GH', color: 'red', collapsed: true } });
    expect(evaluateGroupRules(tab(), [r])).toMatchObject({
      collapsed: true, sortGroups: 'alphabetical', strict: false, merge: true, color: 'red',
    });
  });
  it('treats rules with invalid patterns as non-matching', () => {
    const rules = [rule({ id: 'bad', url: '/(unclosed/' }), rule({ id: 'ok' })];
    expect(evaluateGroupRules(tab(), rules)?.ruleId).toBe('ok');
  });
});
