import { describe, expect, it } from 'vitest';
import batch from '../../../fixtures/m3/gh-pr-batch.synthetic.json?raw';
import saml from '../../../fixtures/m3/gh-pr-batch-saml.synthetic.json?raw';
import notFound from '../../../fixtures/m3/gh-pr-batch-notfound.synthetic.json?raw';
import search from '../../../fixtures/m3/gh-search.synthetic.json?raw';
import schema from '../../../src/core/lang/rule.schema.json';
import { buildKeySearchQuery, buildPrStateQuery, parseKeySearchResponse, parsePrStateResponse } from '../../../src/core/sources/github';
import { SOURCE_QUERIES, pickFields } from '../../../src/core/sources/registry';

const pr = (owner: string, repo: string, number: number) => ({ owner, repo, number });

describe('buildPrStateQuery', () => {
  it('groups 3 PRs in 2 repos into 2 repository aliases, data in variables', () => {
    const b = buildPrStateQuery([pr('acme', 'web', 10), pr('acme', 'api', 3), pr('acme', 'web', 11)]);
    expect(b.query.match(/r\d+: repository/g)).toHaveLength(2);
    expect(b.query.match(/p\d+: pullRequest/g)).toHaveLength(3);
    expect(Object.values(b.variables)).toEqual(expect.arrayContaining(['acme', 'web', 'api', 10, 3, 11]));
    expect(b.query).toContain('rateLimit { cost remaining limit resetAt }');
    for (const f of ['state', 'merged', 'mergedAt', 'isDraft', 'title', 'headRefName', 'reviewDecision', 'url']) expect(b.query).toContain(f);
    expect(b.aliases.get('p2')).toBe('acme/web#11');
  });
  it('never puts an injected owner in the query text', () => {
    const b = buildPrStateQuery([pr('a") { x }', 'r', 1)]);
    expect(b.query).not.toContain('a")');
    expect(Object.values(b.variables)).toContain('a") { x }');
  });
  it('throws over 50 PRs, accepts 50', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => pr('o', 'r', i + 1));
    expect(() => buildPrStateQuery(many(51))).toThrow();
    expect(() => buildPrStateQuery(many(50))).not.toThrow();
  });
});

describe('parsePrStateResponse', () => {
  const aliases3 = buildPrStateQuery([pr('acme', 'web', 10), pr('acme', 'web', 11), pr('acme', 'api', 3)]).aliases;
  it('maps merged, draft and closed, and parses rateLimit', () => {
    const r = parsePrStateResponse(JSON.parse(batch), aliases3);
    expect(r.prs.get('acme/web#10')).toMatchObject({ state: 'merged', mergedAt: '2026-10-30T12:00:00Z', reviewDecision: 'APPROVED' });
    expect(r.prs.get('acme/web#11')?.state).toBe('draft');
    expect(r.prs.get('acme/api#3')?.state).toBe('closed');
    expect(r.rate).toEqual({ remaining: 4990, limit: 5000, resetAt: '2026-11-02T01:00:00Z' });
    expect(r.errors).toEqual([]);
  });
  it('SAML on r1 leaves r0 parsed and r1 unknown with sso', () => {
    const a = buildPrStateQuery([pr('acme', 'web', 10), pr('corp', 'api', 3)]).aliases;
    const r = parsePrStateResponse(JSON.parse(saml), a);
    expect(r.prs.get('acme/web#10')?.state).toBe('open');
    const bad = r.prs.get('corp/api#3');
    expect(bad).toMatchObject({ state: 'unknown', ssoRequired: { org: 'corp', url: 'https://github.com/orgs/corp/sso' } });
    expect(r.errors).toEqual([{ key: 'corp/api#3', kind: 'sso-required', sso: { org: 'corp', url: 'https://github.com/orgs/corp/sso' } }]);
  });
  it('a FORBIDDEN without SAML is a per-item not-found, never unauthorized or sso', () => {
    const a = buildPrStateQuery([pr('corp', 'api', 3)]).aliases;
    const r = parsePrStateResponse({ data: { r0: null }, errors: [{ type: 'FORBIDDEN', path: ['r0'], message: 'nope' }] }, a);
    expect(r.errors[0]).toMatchObject({ key: 'corp/api#3', kind: 'not-found' });
    expect(r.errors[0]?.sso).toBeUndefined();
    expect(r.prs.get('corp/api#3')?.state).toBe('unknown');
  });
  it('NOT_FOUND on one PR leaves its sibling alone', () => {
    const a = buildPrStateQuery([pr('acme', 'web', 1), pr('acme', 'web', 99)]).aliases;
    const r = parsePrStateResponse(JSON.parse(notFound), a);
    expect(r.prs.get('acme/web#1')?.state).toBe('open');
    expect(r.prs.get('acme/web#99')?.state).toBe('unknown');
    expect(r.errors).toEqual([{ key: 'acme/web#99', kind: 'not-found' }]);
  });
  it('a path-less RATE_LIMITED applies rate-limited to every missing node, other path-less errors are server', () => {
    const a = buildPrStateQuery([pr('acme', 'web', 1), pr('acme', 'api', 2)]).aliases;
    for (const body of [{ errors: [{ type: 'RATE_LIMITED', message: 'x' }] }, { data: null, errors: [{ type: 'RATE_LIMITED', message: 'x' }] }]) {
      const r = parsePrStateResponse(body, a);
      expect(r.errors.map((e) => e.kind)).toEqual(['rate-limited', 'rate-limited']);
      expect([...r.prs.values()].every((p) => p.state === 'unknown')).toBe(true);
    }
    expect(parsePrStateResponse({ errors: [{ message: 'boom' }] }, a).errors.map((e) => e.kind)).toEqual(['server', 'server']);
  });
  it('survives garbage bodies', () => {
    expect(parsePrStateResponse(null, aliases3).prs.size).toBe(3);
  });
});

describe('key search', () => {
  it('builds title and head aliases with terms only in variables, max 10 keys', () => {
    const b = buildKeySearchQuery(['ABC-1'], []);
    expect(b.query.match(/search\(type: ISSUE, first: 20/g)).toHaveLength(2);
    expect(Object.values(b.variables)).toEqual(['"ABC-1" in:title is:pr involves:@me', 'head:ABC-1 is:pr involves:@me']);
    expect(b.query).not.toContain('involves:@me');
    expect(b.query).not.toContain('ABC-1');
    const o = buildKeySearchQuery(['ABC-1'], ['a', 'b']);
    expect(Object.values(o.variables)[0]).toBe('"ABC-1" in:title is:pr org:a org:b');
    expect(() => buildKeySearchQuery(Array.from({ length: 11 }, (_, i) => `ABC-${i}`), [])).toThrow();
  });
  it('filters prefix false positives and dedupes across aliases', () => {
    const { aliases } = buildKeySearchQuery(['ABC-1'], []);
    const { byKey, errors } = parseKeySearchResponse(JSON.parse(search), aliases);
    const r = byKey.get('ABC-1')!;
    expect(r.map((p) => `${p.owner}/${p.repo}#${p.number}`)).toEqual(['acme/web#5', 'acme/api#7']);
    expect(r[1]).toMatchObject({ state: 'merged', headRefName: 'abc-1-branch' });
    expect(errors).toEqual([]);
  });
  it('returns an empty list and no error for a key whose searches succeeded empty', () => {
    const { aliases } = buildKeySearchQuery(['ZZZ-9'], []);
    const r = parseKeySearchResponse({ data: { s0: { nodes: [] }, s1: { nodes: [] } } }, aliases);
    expect(r.byKey.get('ZZZ-9')).toEqual([]);
    expect(r.errors).toEqual([]);
  });
  it('reports a key whose head search failed, keeping the title results', () => {
    const { aliases } = buildKeySearchQuery(['ABC-1'], []);
    const d = JSON.parse(search);
    const r = parseKeySearchResponse({ data: { s0: d.data.s0, s1: null }, errors: [{ type: 'FORBIDDEN', path: ['s1'], message: 'denied' }] }, aliases);
    expect(r.errors).toEqual([{ key: 'ABC-1', kind: 'not-found' }]);
    expect(r.byKey.get('ABC-1')?.map((p) => p.number)).toEqual([5]);
  });
  it('reports a failed title search and carries sso for a single-org scope', () => {
    const { aliases } = buildKeySearchQuery(['ABC-1'], ['corp']);
    const r = parseKeySearchResponse({ data: { s0: null, s1: { nodes: [] } }, errors: [{ type: 'FORBIDDEN', path: ['s0'], extensions: { saml_failure: true }, message: 'SAML' }] }, aliases, {}, ['corp']);
    expect(r.errors).toEqual([{ key: 'ABC-1', kind: 'sso-required', sso: { org: 'corp', url: 'https://github.com/orgs/corp/sso' } }]);
  });
  it('a path-less RATE_LIMITED fails every key', () => {
    const { aliases } = buildKeySearchQuery(['ABC-1', 'ABC-2'], []);
    for (const body of [{ errors: [{ type: 'RATE_LIMITED' }] }, { data: null, errors: [{ type: 'RATE_LIMITED' }] }]) {
      expect(parseKeySearchResponse(body, aliases).errors).toEqual([{ key: 'ABC-1', kind: 'rate-limited' }, { key: 'ABC-2', kind: 'rate-limited' }]);
    }
  });
});

describe('SOURCE_QUERIES and pickFields', () => {
  it('pins the rule schema query enum to the registry keys', () => {
    const e = (schema as unknown as { $defs: Record<string, { properties?: { query?: { enum: string[] } } }> }).$defs;
    const found = Object.values(e).map((d) => d.properties?.query?.enum).find(Boolean);
    expect([...found!].sort()).toEqual(Object.keys(SOURCE_QUERIES).sort());
  });
  it('github.pull_request is final only when merged', () => {
    const f = SOURCE_QUERIES['github.pull_request'].final;
    expect(f({ state: 'merged' })).toBe(true);
    expect(f({ state: 'closed' })).toBe(false);
    expect(SOURCE_QUERIES['jira.issue']).toMatchObject({ batch: 50, ttlMs: 300_000 });
    expect(SOURCE_QUERIES['jira.projects'].ttlMs).toBe(86_400_000);
  });
  it('pickFields projects dot paths and omits missing and unknown state (M3-R45)', () => {
    const d = { state: 'unknown', title: 'T', a: { b: 1 } };
    expect(pickFields(d, { s: 'state', t: 'title', b: 'a.b', x: 'a.zz' })).toEqual({ t: 'T', b: 1 });
    expect(pickFields({ state: 'merged' }, { s: 'state' })).toEqual({ s: 'merged' });
  });
});
