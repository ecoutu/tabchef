import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANCH_PATTERN, extractGithubIssue, issueKey, parseIssueKey } from '../../../src/core/keys/github-issue';

describe('extractGithubIssue', () => {
  it('reads an issue URL', () => {
    expect(extractGithubIssue('https://github.com/Acme/Web/issues/12')).toBe('acme/web#12');
    expect(extractGithubIssue('https://github.com/acme/web/issues/12?x=1#c')).toBe('acme/web#12');
  });
  it('rejects non-issue paths', () => {
    for (const u of ['https://github.com/acme/web/issues/new', 'https://github.com/acme/web/issues?q=is%3Aopen',
      'https://github.com/acme/web/issues/0', 'https://github.com/acme/web/pull/12', 'https://gitlab.com/acme/web/issues/12'])
      expect(extractGithubIssue(u)).toBeUndefined();
  });
  it('reads an owner/repo#N reference', () => expect(extractGithubIssue('Acme/API#7')).toBe('acme/api#7'));
  it('branch: number from the pattern, repo from the tab URL', () => {
    const o = { pattern: DEFAULT_BRANCH_PATTERN, tabUrl: 'https://github.com/acme/web/pull/40' };
    expect(extractGithubIssue('fix/179', o)).toBe('acme/web#179');
    expect(extractGithubIssue('feat/179-dark-mode', o)).toBe('acme/web#179');
    expect(extractGithubIssue('FIX/#179', o)).toBe('acme/web#179');
    for (const b of ['release/2026', 'fix/179x', 'main', 'fix/0', 'feature/12']) expect(extractGithubIssue(b, o)).toBeUndefined();
  });
  it('branch without a repo in the tab URL → undefined', () =>
    expect(extractGithubIssue('fix/1', { pattern: DEFAULT_BRANCH_PATTERN, tabUrl: 'https://example.com/' })).toBeUndefined());
  it('allow and ignore globs', () => {
    expect(extractGithubIssue('acme/web#1', { allow: ['acme/*'] })).toBe('acme/web#1');
    expect(extractGithubIssue('other/web#1', { allow: ['acme/*'] })).toBeUndefined();
    expect(extractGithubIssue('acme/web#1', { allow: ['acme/*'], ignore: ['ACME/web'] })).toBeUndefined();
  });
  it('a glob with many stars matches in linear time', () => {
    const glob = '*a*a*a*a*a*a*a*a*b/x';
    const t0 = performance.now();
    expect(extractGithubIssue(`${'a'.repeat(38)}/x#1`, { allow: [glob] })).toBeUndefined();
    expect(extractGithubIssue(`${'a'.repeat(37)}b/x#1`, { allow: [glob] })).toBe(`${'a'.repeat(37)}b/x#1`);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(extractGithubIssue('acme/web#1', { allow: ['**/w*b'] })).toBe('acme/web#1');
    expect(extractGithubIssue('acme/web#1', { allow: ['*'] })).toBeUndefined();
    expect(extractGithubIssue('acme/web#1', { allow: ['a.me/*'] })).toBeUndefined();
  });
  it('an unsafe or broken pattern gives undefined, never throws', () => {
    expect(extractGithubIssue('fix/1', { pattern: '(a+)+$' })).toBeUndefined();
    expect(extractGithubIssue('fix/1', { pattern: '(' })).toBeUndefined();
  });
});
describe('issue keys', () => {
  it('round-trips', () => expect(parseIssueKey(issueKey({ owner: 'Acme', repo: 'Web', number: 3 }))).toEqual({ owner: 'acme', repo: 'web', number: 3 }));
  it('rejects non-keys', () => { for (const k of ['ABC-1', 'acme/web#0', 'acme#1', 'a/b/c#1']) expect(parseIssueKey(k)).toBeUndefined(); });
});
