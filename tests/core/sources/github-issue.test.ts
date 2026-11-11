import { describe, expect, it } from 'vitest';
import fixture from '../../../fixtures/m3/github-issue.synthetic.json?raw';
import { buildIssueQuery, parseIssueResponse } from '../../../src/core/sources/github-issue';
import { SOURCE_QUERIES } from '../../../src/core/sources/registry';

const ref = (owner: string, repo: string, number: number) => ({ owner, repo, number });

describe('buildIssueQuery', () => {
  it('keeps owner, repo and number in variables; one repo alias per repo', () => {
    const b = buildIssueQuery([ref('acme', 'web', 179), ref('acme', 'web', 180), ref('acme', 'api', 3)]);
    expect(b.query.match(/r\d+: repository/g)).toHaveLength(2);
    expect(b.query.match(/i\d+: issue/g)).toHaveLength(3);
    expect(Object.values(b.variables)).toEqual(expect.arrayContaining(['acme', 'web', 'api', 179, 180, 3]));
    expect(b.query).toContain('closedByPullRequestsReferences(first: 10, includeClosedPrs: true)');
    expect(b.query).toContain('rateLimit { cost remaining limit resetAt }');
    expect(b.aliases.get('i2')).toBe('acme/api#3');
    expect(b.aliases.get('r0')).toBe('acme/web');
  });
  it('never puts an injected owner in the query text', () => {
    const b = buildIssueQuery([ref('a") { x }', 'r', 1)]);
    expect(b.query).not.toContain('a")');
    expect(Object.values(b.variables)).toContain('a") { x }');
  });
  it('a mixed-case owner/repo is found under its lower-cased key', () => {
    const b = buildIssueQuery([ref('Acme', 'Web', 5)]);
    const body = { data: { r0: { i0: { title: 'T', state: 'OPEN', url: 'https://github.com/Acme/Web/issues/5' } } } };
    const out = parseIssueResponse(body, b.aliases);
    expect(out.errors).toEqual([]);
    expect(out.issues.get('acme/web#5')).toMatchObject({ owner: 'acme', repo: 'web', number: 5, state: 'open' });
  });
  it('throws over the batch size, accepts it', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ref('o', 'r', i + 1));
    const max = SOURCE_QUERIES['github.issue'].batch;
    expect(() => buildIssueQuery(many(max + 1))).toThrow();
    expect(() => buildIssueQuery(many(max))).not.toThrow();
  });
});

describe('parseIssueResponse', () => {
  const aliases = new Map([
    ['r0', 'acme/web'], ['i0', 'acme/web#179'], ['i1', 'acme/web#180'], ['i2', 'acme/web#999'],
    ['r1', 'acme/sso'], ['i3', 'acme/sso#1'],
    ['r2', 'acme/nope'], ['i4', 'acme/nope#2'],
  ]);
  const out = parseIssueResponse(JSON.parse(fixture), aliases);
  it('maps an open issue and its linked PRs', () => {
    const i = out.issues.get('acme/web#179')!;
    expect(i).toMatchObject({ owner: 'acme', repo: 'web', number: 179, state: 'open', status: 'Open', statusCategory: 'new', summary: 'Dark mode', url: 'https://github.com/acme/web/issues/179' });
    expect(i.linkedPrs!.map((p) => [p.number, p.state, p.headRefName])).toEqual([[10, 'open', 'feat/179-dark-mode'], [11, 'merged', 'feat/179-tokens'], [12, 'draft', 'wip'], [13, 'closed', 'old']]);
    expect(i.linkedPrs![0]).toMatchObject({ owner: 'Acme', repo: 'Web' });
    expect(i.linkedPrs![1]!.mergedAt).toBe('2026-11-03T10:00:00Z');
  });
  it('treats a closed issue as done, whatever the reason', () => {
    expect(out.issues.get('acme/web#180')).toMatchObject({ state: 'closed', stateReason: 'NOT_PLANNED', status: 'Closed', statusCategory: 'done' });
  });
  it('reports not-found and SAML per issue', () => {
    expect(out.issues.get('acme/web#999')).toMatchObject({ state: 'unknown', url: 'https://github.com/acme/web/issues/999' });
    expect(out.issues.get('acme/sso#1')).toMatchObject({ state: 'unknown', ssoRequired: { org: 'acme', url: 'https://github.com/orgs/acme/sso' } });
    expect(out.errors).toEqual([
      { key: 'acme/web#999', kind: 'not-found' },
      { key: 'acme/sso#1', kind: 'sso-required', sso: { org: 'acme', url: 'https://github.com/orgs/acme/sso' } },
      { key: 'acme/nope#2', kind: 'not-found' },
    ]);
  });
  it('flags the missing Issues permission: a non-SAML "not accessible by integration" FORBIDDEN on an issue', () => {
    const a = new Map([['r0', 'acme/web'], ['i0', 'acme/web#5']]);
    const body = (e: Record<string, unknown>) => ({ data: { r0: { i0: null } }, errors: [e] });
    const r = parseIssueResponse(body({ type: 'FORBIDDEN', path: ['r0', 'i0'], message: 'Resource not accessible by integration' }), a);
    expect(r.issuesForbidden).toBe(true);
    expect(r.errors).toEqual([{ key: 'acme/web#5', kind: 'not-found' }]);
    expect(parseIssueResponse(body({ type: 'FORBIDDEN', path: ['r0', 'i0'], message: 'Resource protected by organization SAML enforcement.' }), a).issuesForbidden).toBeFalsy();
    expect(parseIssueResponse(body({ type: 'NOT_FOUND', path: ['r0', 'i0'], message: 'Could not resolve to an Issue' }), a).issuesForbidden).toBeFalsy();
    expect(out.issuesForbidden).toBeFalsy();
  });
  it('a FORBIDDEN on a field of an issue that was read (closedByPullRequestsReferences) is no missing Issues permission', () => {
    const a = new Map([['r0', 'acme/web'], ['i0', 'acme/web#5']]);
    const body = { data: { r0: { i0: { title: 'T', state: 'OPEN', url: 'u', closedByPullRequestsReferences: null } } }, errors: [{ type: 'FORBIDDEN', path: ['r0', 'i0', 'closedByPullRequestsReferences'], message: 'Resource not accessible by integration' }] };
    const r = parseIssueResponse(body, a);
    expect(r.issuesForbidden).toBeFalsy();
    expect(r.issues.get('acme/web#5')).toMatchObject({ state: 'open', summary: 'T' });
    expect(r.errors).toEqual([]);
  });
  it('reads the rate limit', () => {
    expect(out.rate).toEqual({ remaining: 4990, limit: 5000, resetAt: '2026-11-10T01:00:00Z' });
  });
});
