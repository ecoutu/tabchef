import { describe, it, expect } from 'vitest';
import { compilePattern, PatternError, patternCaptures } from '../../../src/core/match/pattern';

const m = (p: string, u: string) => compilePattern(p)(u);

describe('compilePattern', () => {
  it('glob matches with no captures', () => {
    expect(m('github.com/*', 'https://github.com/acme/api/pull/1')).toEqual({});
    expect(m('github.com/*', 'http://github.com/x')).toEqual({});
  });
  it('glob non-match', () => {
    expect(m('github.com/*', 'https://gitlab.com/x')).toBeNull();
  });
  it('is anchored', () => {
    expect(m('github.com/acme', 'https://github.com/acme/api')).toBeNull();
    expect(m('github.com/acme', 'https://github.com/acme')).toEqual({});
  });
  it('param captures', () => {
    expect(m('github.com/:owner/:repo*', 'https://github.com/acme/api/pull/1')).toEqual({ owner: 'acme', repo: 'api' });
    expect(m('github.com/:owner/:repo', 'https://github.com/acme/api/pull/1')).toBeNull();
    expect(m('github.com/:owner/:repo', 'https://github.com/acme/api')).toEqual({ owner: 'acme', repo: 'api' });
  });
  it('*.host matches subdomains and apex', () => {
    expect(m('*.atlassian.net/browse/*', 'https://acme.atlassian.net/browse/ABC-1')).toEqual({});
    expect(m('*.example.com/*', 'https://example.com/x')).toEqual({});
    expect(m('*.example.com/*', 'https://a.b.example.com/x')).toEqual({});
    expect(m('*.example.com/*', 'https://notexample.com/x')).toBeNull();
  });
  it('regex with named groups against full URL', () => {
    expect(m('/github\\.com\\/(?<owner>[^/]+)/', 'https://github.com/acme')).toEqual({ owner: 'acme' });
    expect(m('/^https:\\/\\/a\\.com$/', 'https://a.com')).toEqual({});
    expect(m('/GITHUB/i', 'https://github.com/x')).toEqual({});
    expect(m('/zzz/', 'https://github.com/x')).toBeNull();
  });
  it('regex is stateless with g flag', () => {
    const f = compilePattern('/a/g');
    expect(f('https://a.com')).toEqual({});
    expect(f('https://a.com')).toEqual({});
  });
  it('explicit scheme must match', () => {
    expect(m('https://github.com*', 'https://github.com/x')).toEqual({});
    expect(m('https://github.com/acme/api*', 'http://github.com/acme/api')).toBeNull();
    expect(m('*://github.com/*', 'http://github.com/x')).toEqual({});
    expect(m('*://github.com/*', 'https://github.com/x')).toEqual({});
    expect(m('*://github.com/*', 'ftp://github.com/x')).toBeNull();
  });
  it('Auto-Group Tabs imported rules', () => {
    expect(m('https://github.com/acme/repo-1*', 'https://github.com/acme/repo-1/pull/3')).toEqual({});
    expect(m('https://github.com*', 'https://github.com/x')).toEqual({});
    expect(m('https://console.cloud.google.com/*', 'https://console.cloud.google.com/run?project=p')).toEqual({});
  });
  it('scheme-less does not match other schemes', () => {
    expect(m('github.com/*', 'ftp://github.com/x')).toBeNull();
  });
  it('malformed regex throws PatternError', () => {
    expect(() => compilePattern('/(/')).toThrow(PatternError);
    expect(() => compilePattern('/(/')).toThrow(/invalid regex/);
    expect(() => compilePattern('/a/zz')).toThrow(/invalid regex/);
  });
  it('too-long regex throws', () => {
    expect(() => compilePattern('/' + 'a'.repeat(500) + '/')).toThrow('pattern too long');
  });
  it('duplicate param names throw', () => {
    expect(() => compilePattern('a.com/:x/:x')).toThrow(PatternError);
  });
  it('caches compiled patterns', () => {
    expect(compilePattern('cache.test/*')).toBe(compilePattern('cache.test/*'));
  });
});

describe('compilePattern: *.host prefix stays in the host (T4)', () => {
  it('does not match the host suffix inside the path, query or userinfo', () => {
    expect(m('*.example.com/*', 'https://evil.com/x.example.com/')).toBeNull();
    expect(m('https://*.example.com/*', 'https://evil.com/x.example.com/')).toBeNull();
    expect(m('*.example.com/*', 'https://evil.com?x.example.com/')).toBeNull();
    expect(m('*.example.com/*', 'https://evil.com#x.example.com/')).toBeNull();
    expect(m('*.example.com/*', 'https://x@evil.com/.example.com/')).toBeNull();
    expect(m('*.example.com/*', 'https://a.b.example.com/x')).toEqual({});
  });
});

describe('patternCaptures', () => {
  it('lists :params and regex named groups; null for invalid patterns', () => {
    expect([...patternCaptures('github.com/:org/:repo/*')!].sort()).toEqual(['org', 'repo']);
    expect([...patternCaptures('/github\\.com\\/(?<owner>[^/]+)/')!]).toEqual(['owner']);
    expect([...patternCaptures('a.com/*')!]).toEqual([]);
    expect(patternCaptures('/(/')).toBeNull();
  });
});

describe('pattern length cap', () => {
  it('rejects a 501-character glob and regex', () => {
    expect(() => compilePattern('a'.repeat(501))).toThrow('pattern too long');
    expect(() => compilePattern('/' + 'a'.repeat(499) + '/')).toThrow('pattern too long');
    expect(() => compilePattern('a'.repeat(500))).not.toThrow();
  });
});
