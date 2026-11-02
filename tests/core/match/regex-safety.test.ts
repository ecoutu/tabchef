import { describe, it, expect } from 'vitest';
import { slowRegexProblem, SLOW_REGEX_MSG } from '../../../src/core/match/regex-safety';
import { compilePattern, compileTextPattern, PatternError } from '../../../src/core/match/pattern';
import { regexProblem } from '../../../src/core/config/schema';

describe('slowRegexProblem: nested unbounded quantifiers (R67)', () => {
  it.each([
    '(a+)+', '(a+)+$', '(a*)*', '(?:a+)*', '(a+)*b', '(a{2,})+', '(a+){1,}', '((a+)b)+', '(?<x>\\w+\\s?)+', '(?:[^/]+/?)+',
    '(a|aa)+', '(?:ab|abab)*', '(x|x)+', '^(?:a|b|aa)+$', '(a+?)+', '(a+)+?',
  ])('flags %s', (re) => {
    expect(slowRegexProblem(re)).toBe(SLOW_REGEX_MSG);
  });

  it.each([
    'a+', '(a+)', '(a+)?', '(a+){2}', '(a+){1,3}', '(a{1,3})+', '(\\+)+', '([+])+', '([*+]x)+', '(a\\*)+', '(?:ab)+',
    '(a|b)+', '(a|ab)+', '\\(a+\\)+', '[(]a+[)]+', '(?:\\d{1,3}\\.){3}\\d{1,3}', '/(?<r>[^/]+)$', '^https://github\\.com/([^/]+)/([^/]+)/pull/\\d+',
    '(a)+b*', '\\p{L}+', '\\u{61}+', '(?=a+)b', 'x{2,}', '([\\]+])+', '(?:a)+(?:b+)', '[^\\]]+(a)+',
  ])('allows %s', (re) => {
    expect(slowRegexProblem(re)).toBeUndefined();
  });
});

describe('the heuristic applies wherever regexes are validated', () => {
  it('regexProblem (rule extract/title regexes, urlTransforms, show matches) reports it', () => {
    expect(regexProblem('(a+)+$')).toBe(SLOW_REGEX_MSG);
    expect(regexProblem('(a+)+$', undefined, true)).toBe(SLOW_REGEX_MSG);
    expect(regexProblem('[a-z]+$')).toBeUndefined();
  });
  it('compilePattern / compileTextPattern refuse /regex/ patterns that trip it (url patterns, title regexes, dedupe overrides)', () => {
    expect(() => compilePattern('/(a+)+$/')).toThrow(PatternError);
    expect(() => compileTextPattern('/(a+)+$/')).toThrow(SLOW_REGEX_MSG);
    expect(compileTextPattern('/(?<n>a+)$/')('aaa')).toEqual({ n: 'aaa' });
  });
});
