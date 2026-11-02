import { describe, it, expect } from 'vitest';
import { compileTextPattern, PatternError } from '../../../src/core/match/pattern';

const t = (p: string, s: string) => compileTextPattern(p)(s);

describe('compileTextPattern (R6)', () => {
  it('* is .*, anchored, case-insensitive, no scheme or host handling', () => {
    expect(t('*Pull*', 'Fix · Pull Request #7')).toEqual({});
    expect(t('pull*', 'Pull Request')).toEqual({});
    expect(t('Pull', 'Pull Request')).toBeNull();
    expect(t('github.com/*', 'github.com/acme')).toEqual({});
    expect(t('github.com/*', 'https://github.com/acme')).toBeNull();
    expect(t('a.b', 'axb')).toBeNull();
    expect(t('(x)?[y]+', '(X)?[Y]+')).toEqual({});
    expect(t('*', '')).toEqual({});
  });
  it(':param is literal (use a regex named group)', () => {
    expect(t(':name*', ':name is here')).toEqual({});
    expect(t(':name', 'bob')).toBeNull();
  });
  it('/regex/flags works as in compilePattern', () => {
    expect(t('/#(?<num>\\d+)/', 'Pull Request #7')).toEqual({ num: '7' });
    expect(t('/^pull/', 'Pull')).toBeNull();
    expect(t('/^pull/i', 'Pull')).toEqual({});
    expect(() => compileTextPattern('/(/')).toThrow(PatternError);
  });
  it('length cap', () => {
    expect(() => compileTextPattern('a'.repeat(501))).toThrow('pattern too long');
    expect(() => compileTextPattern('/' + 'a'.repeat(499) + '/')).toThrow('pattern too long');
  });
  it('truncates titles to 2048 characters before matching', () => {
    expect(t('*y', 'x'.repeat(3000) + 'y')).toBeNull();
    expect(t('/^x{2048}$/', 'x'.repeat(3000))).toEqual({});
  });
  it('is cached separately from URL patterns', () => {
    expect(compileTextPattern('cache*')).toBe(compileTextPattern('cache*'));
  });
});
