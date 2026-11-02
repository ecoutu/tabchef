import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORED_PREFIXES, DEFAULT_KEY_PATTERN, extractJiraKeys } from '../../../src/core/keys/jira-key';

describe('extractJiraKeys', () => {
  it('exports the defaults', () => {
    expect(DEFAULT_KEY_PATTERN).toBe('[A-Z][A-Z0-9]+-\\d+');
    expect(DEFAULT_IGNORED_PREFIXES).toContain('UTF');
  });
  it('finds a key and skips ignored prefixes', () => {
    expect(extractJiraKeys('Fix UTF-8 decoding (ABC-12)')).toEqual(['ABC-12']);
    expect(extractJiraKeys('Bump SHA-256 and ISO-8859-1 handling')).toEqual([]);
    expect(extractJiraKeys('COVID-19 dashboard')).toEqual([]);
    expect(extractJiraKeys('GPT-4 eval')).toEqual([]);
  });
  it('requires word boundaries (M3-R22)', () => {
    expect(extractJiraKeys('xABC-12')).toEqual([]);
    expect(extractJiraKeys('ABC-12x')).toEqual([]);
    expect(extractJiraKeys('XABC-12')).toEqual(['XABC-12']);
    expect(extractJiraKeys('abc-12_x')).toEqual([]);
    expect(extractJiraKeys('ABC-12_x')).toEqual([]);
  });
  it('handles brackets and trailing text', () => {
    expect(extractJiraKeys('[ABC-12] Login fails - Jira')).toEqual(['ABC-12']);
  });
  it('allow keeps only those prefixes, and ignore does not apply to them', () => {
    expect(extractJiraKeys('DEF-1 ABC-2', { allow: ['ABC'] })).toEqual(['ABC-2']);
    expect(extractJiraKeys('UTF-8', { allow: ['UTF'] })).toEqual(['UTF-8']);
  });
  it('a custom ignore list replaces the default', () => {
    expect(extractJiraKeys('UTF-8 ABC-1', { ignore: ['ABC'] })).toEqual(['UTF-8']);
  });
  it('prefer puts known keys first; keys are unique, in text order', () => {
    expect(extractJiraKeys('ABC-2 DEF-1', { prefer: new Set(['DEF-1']) })).toEqual(['DEF-1', 'ABC-2']);
    expect(extractJiraKeys('ABC-2 DEF-1 ABC-2')).toEqual(['ABC-2', 'DEF-1']);
  });
  it('branch mode is case-insensitive, uppercases, and treats _ as a separator (M3-R23)', () => {
    expect(extractJiraKeys('feature/abc-12_login', { branch: true })).toEqual(['ABC-12']);
    expect(extractJiraKeys('feat/abc-12-login', { branch: true })).toEqual(['ABC-12']);
    expect(extractJiraKeys('feature/abc-12_login')).toEqual([]);
  });
  it('M3-R105: in branch mode a key may follow -, / or _; title mode is unchanged', () => {
    expect(extractJiraKeys('feature-abc-12-login', { branch: true })).toEqual(['ABC-12']);
    expect(extractJiraKeys('feature/scrum-1-login', { branch: true })).toEqual(['SCRUM-1']);
    expect(extractJiraKeys('fix_abc-3', { branch: true })).toEqual(['ABC-3']);
    expect(extractJiraKeys('feature-xabc-12', { branch: true })).toEqual(['XABC-12']);
    expect(extractJiraKeys('bump-utf-8-sha-256', { branch: true })).toEqual([]);
    expect(extractJiraKeys('9abc-12', { branch: true })).toEqual([]);
    expect(extractJiraKeys('feature-ABC-12')).toEqual([]);
    expect(extractJiraKeys('fix_ABC-12')).toEqual([]);
  });
  it('a custom pattern is used; an unsafe, too long or invalid one yields nothing', () => {
    expect(extractJiraKeys('see PROJ_7 now', { pattern: 'PROJ_\\d+' })).toEqual(['PROJ_7']);
    expect(extractJiraKeys('aaaa-1', { pattern: '(a+)+-\\d+' })).toEqual([]);
    expect(extractJiraKeys('ABC-1', { pattern: '(' })).toEqual([]);
    expect(extractJiraKeys('ABC-1', { pattern: 'A'.repeat(501) })).toEqual([]);
  });
  it('caps the input at 2,048 characters (M3-R24)', () => {
    expect(extractJiraKeys(`${' '.repeat(2048)}ABC-1`)).toEqual([]);
    expect(extractJiraKeys(`${' '.repeat(2000)}ABC-1`)).toEqual(['ABC-1']);
  });
  it('a 10 KB input is quick', () => {
    const t0 = performance.now();
    extractJiraKeys('AB-C1 '.repeat(2000));
    expect(performance.now() - t0).toBeLessThanOrEqual(50);
  });
});
