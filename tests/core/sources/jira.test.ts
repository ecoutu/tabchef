import { describe, expect, it } from 'vitest';
import page1 from '../../../fixtures/m3/jira-projects-page1.synthetic.json?raw';
import page2 from '../../../fixtures/m3/jira-projects-page2.synthetic.json?raw';
import search from '../../../fixtures/m3/jira-search.synthetic.json?raw';
import { buildIssueSearch, buildProjectKeysRequest, parseIssueSearch, parseProjectKeys, resolveInHalves, splitOnBadRequest, type IssueExec } from '../../../src/core/sources/jira';
import { SOURCE_QUERIES } from '../../../src/core/sources/registry';
import type { JiraIssue } from '../../../src/core/sources/types';

describe('buildIssueSearch', () => {
  it('builds the exact JQL request', () => {
    expect(buildIssueSearch(['ABC-1', 'DEF-22'])).toEqual({
      method: 'GET', path: '/rest/api/3/search/jql',
      query: { jql: 'key in (ABC-1,DEF-22)', fields: 'summary,status', maxResults: '2' },
    });
  });
  it('rejects injection and non-keys', () => {
    expect(() => buildIssueSearch(['ABC-1) OR (1=1'])).toThrow();
    expect(() => buildIssueSearch(['abc-1'])).toThrow();
    expect(() => buildIssueSearch(['ABC-1\nABC-2'])).toThrow();
  });
  it('accepts the registry batch size and throws over it', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `ABC-${i + 1}`);
    const max = SOURCE_QUERIES['jira.issue'].batch;
    expect(() => buildIssueSearch(many(max))).not.toThrow();
    expect(() => buildIssueSearch(many(max + 1))).toThrow();
  });
});

describe('parseIssueSearch', () => {
  const m = parseIssueSearch(JSON.parse(search), 'acme.atlassian.net');
  it('maps summary, status, category and browse url', () => {
    expect(m.get('ABC-1')).toEqual({ key: 'ABC-1', summary: 'Fix the login redirect', status: 'Done', statusCategory: 'done', url: 'https://acme.atlassian.net/browse/ABC-1' });
    expect(m.get('ABC-2')?.statusCategory).toBe('indeterminate');
  });
  it('leaves an unknown category unset (M3-R32)', () => {
    const i = m.get('ABC-3')!;
    expect(i.status).toBe('Weird');
    expect('statusCategory' in i).toBe(false);
  });
  it('tolerates garbage', () => {
    expect(parseIssueSearch(null, 'x').size).toBe(0);
    expect(parseIssueSearch({ issues: [null, { key: 5 }, { fields: {} }] }, 'x').size).toBe(0);
  });
});

describe('splitOnBadRequest', () => {
  it('halves', () => {
    expect(splitOnBadRequest(['A-1', 'B-2', 'C-3'])).toEqual([['A-1', 'B-2'], ['C-3']]);
    expect(splitOnBadRequest(['A-1', 'B-2'])).toEqual([['A-1'], ['B-2']]);
  });
});

describe('resolveInHalves', () => {
  const issue = (key: string): JiraIssue => ({ key, url: `https://s/browse/${key}` });
  it('isolates UTF-8 within 3 levels and still resolves the others', async () => {
    const calls: string[][] = [];
    const exec: IssueExec = async (keys) => {
      calls.push(keys);
      if (keys.includes('UTF-8')) return { ok: false, kind: 'bad-request' };
      return { ok: true, issues: new Map(keys.map((k) => [k, issue(k)])) };
    };
    const r = await resolveInHalves(['UTF-8', 'ABC-1', 'ABC-2'], exec);
    expect([...r.issues.keys()].sort()).toEqual(['ABC-1', 'ABC-2']);
    expect(r.errors.get('UTF-8')).toBe('not-found');
    expect(calls.length).toBeLessThanOrEqual(7);
  });
  it('marks keys absent from a 200 as not-found', async () => {
    const r = await resolveInHalves(['ABC-1', 'ABC-9'], async () => ({ ok: true, issues: new Map([['ABC-1', issue('ABC-1')]]) }));
    expect(r.errors.get('ABC-9')).toBe('not-found');
    expect(r.issues.has('ABC-1')).toBe(true);
  });
  it('does not bisect other errors; every key gets the kind', async () => {
    let n = 0;
    const r = await resolveInHalves(['ABC-1', 'ABC-2'], async () => { n++; return { ok: false, kind: 'rate-limited' }; });
    expect(n).toBe(1);
    expect(r.errors.get('ABC-1')).toBe('rate-limited');
    expect(r.errors.get('ABC-2')).toBe('rate-limited');
  });
  it('makes no call for no keys', async () => {
    const r = await resolveInHalves([], async () => { throw new Error('called'); });
    expect(r.issues.size + r.errors.size).toBe(0);
  });
});

describe('project keys', () => {
  it('builds the request with startAt', () => {
    expect(buildProjectKeysRequest()).toEqual({ method: 'GET', path: '/rest/api/3/project/search', query: { maxResults: '100', startAt: '0' } });
    expect(buildProjectKeysRequest(100).query?.startAt).toBe('100');
  });
  it('paginates via next', () => {
    expect(parseProjectKeys(JSON.parse(page1))).toEqual({ keys: ['ABC', 'DEF'], next: 2 });
    expect(parseProjectKeys(JSON.parse(page2))).toEqual({ keys: ['GHI'] });
  });
  it('stops on an empty non-last page and on garbage', () => {
    expect(parseProjectKeys({ isLast: false, startAt: 5, values: [] })).toEqual({ keys: [] });
    expect(parseProjectKeys(undefined)).toEqual({ keys: [] });
  });
});
