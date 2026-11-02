import { describe, it, expect } from 'vitest';
import { compilePattern, PatternError, patternCaptures } from '../../../src/core/match/pattern';

const m = (p: string, u: string) => compilePattern(p)(u);

describe('URL globs on URLPattern (R31)', () => {
  it(':name* captures one segment, then anything', () => {
    expect(m('github.com/:owner/:repo*', 'https://github.com/acme/repo-1/pull/5')).toEqual({ owner: 'acme', repo: 'repo-1' });
    expect(m('github.com/:owner/:repo*', 'https://github.com/acme/repo-1?tab=x#y')).toEqual({ owner: 'acme', repo: 'repo-1' });
  });
  it('params capture greedily within one segment', () => {
    expect(m('a.com/:x-*', 'https://a.com/p-q-r')).toEqual({ x: 'p-q' });
  });
  it('a literal ? or # in the pattern is literal and must be present', () => {
    expect(m('github.com/pulls?q=*', 'https://github.com/pulls?q=is%3Aopen')).toEqual({});
    expect(m('github.com/pulls?*', 'https://github.com/pulls')).toBeNull();
    expect(m('github.com/pulls?*', 'https://github.com/pulls?')).toEqual({});
    expect(m('a.com/x#*', 'https://a.com/x')).toBeNull();
    expect(m('a.com/x#*', 'https://a.com/x#')).toEqual({});
    expect(m('a.com/x', 'https://a.com/x?')).toBeNull();
    expect(m('a.com/x', 'https://a.com/x#')).toBeNull();
  });
  it('* crosses into the query and fragment', () => {
    expect(m('a.com/*/b', 'https://a.com/x?y=/b')).toEqual({});
    expect(m('a.com/*/b', 'https://a.com/x#/b')).toEqual({});
    expect(m('a.com/*/:id', 'https://a.com/p?r/s')).toEqual({ id: 's' });
  });
  it('hosts: ports, userinfo, trailing *', () => {
    expect(m('localhost:3000/*', 'http://localhost:3000/x')).toEqual({});
    expect(m('localhost:3000/*', 'http://localhost/x')).toBeNull();
    expect(m('github.com/*', 'https://github.com:8443/x')).toBeNull();
    expect(m('github.com/*', 'https://u@github.com/x')).toBeNull();
    expect(m('https://github.com*', 'https://github.com.evil.com/')).toEqual({});
    expect(m('https://github.com*', 'https://github.com:8080/')).toEqual({});
    expect(m('github.com*', 'https://evilgithub.com/')).toBeNull();
    expect(m('*', 'https://anything.example/x?y#z')).toEqual({});
    expect(m('*', 'chrome://newtab/')).toBeNull();
    expect(m('*/login*', 'https://a.com/x/login?next=1')).toEqual({});
  });
  it('explicit non-http schemes', () => {
    expect(m('chrome://settings/*', 'chrome://settings/privacy')).toEqual({});
    expect(m('file:///home/*', 'file:///home/me/a.txt')).toEqual({});
  });
  it('globs with no host or no path keep matching nothing over http(s)', () => {
    expect(m('github.com', 'https://github.com/')).toBeNull();
    expect(m('github.com?x', 'https://github.com/?x')).toBeNull();
    expect(m('/foo*', 'https://a.com/foo')).toBeNull();
    expect(m('file:///home/*', 'file:///home/x')).toEqual({});
  });
  it('exact hosts no canonical URL can have compile to a matcher that never matches (as before)', () => {
    expect(m('123/*', 'http://0.0.0.123/x')).toBeNull();
    expect(m('a.com:0080/*', 'http://a.com:80/x')).toBeNull();
    expect(m('localhost:/x', 'http://localhost/x')).toBeNull();
    expect(m('Foo Bar!.example/*', 'https://foo%20bar!.example/')).toBeNull();
    expect(m('[::1]:8080/*', 'http://[::1]:8080/x')).toEqual({});
  });
  it('non-URLs never match', () => {
    expect(m('*', 'not a url')).toBeNull();
    expect(m('*://*', '')).toBeNull();
  });
});

describe('URL globs fail closed (R31)', () => {
  const bad = (p: string, re: RegExp) => {
    expect(() => compilePattern(p)).toThrow(PatternError);
    expect(() => compilePattern(p)).toThrow(re);
    expect(patternCaptures(p)).toBeNull();
  };
  it('rejects URLPattern-only group syntax', () => {
    bad('github.com/(foo|bar)/*', /group/);
    bad('github.com/{foo}?/*', /group/);
    bad('github.com/:id(\\d+)', /group/);
  });
  it('rejects patterns it cannot express faithfully', () => {
    bad('jira.*.com/*', /host/);
    bad('github.com*/pulls', /host/);
    bad('*.github.com*', /host/);
    bad(':sub.example.com/*', /host/);
    bad('user@github.com/*', /host/);
    bad('http*://a.com/*', /scheme/);
    bad('a.com/./x', /canonical/);
    bad('a.com/.*', /canonical/);
    bad('a.com/café', /canonical/);
  });
  it('rejects too many wildcards', () => {
    bad('a.com/' + '*/'.repeat(40), /wildcards/);
  });
});

describe('URL globs are backed by URLPattern', () => {
  it('compiling a glob constructs URLPattern objects', async () => {
    const { vi } = await import('vitest');
    const Real = globalThis.URLPattern;
    let n = 0;
    vi.stubGlobal('URLPattern', class extends Real { constructor(...a: ConstructorParameters<typeof Real>) { super(...a); n++; } });
    try {
      compilePattern('backed.by.urlpattern.test/*');
      expect(n).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('compilePattern matchers cap input length', () => {
  it('truncates URLs to 2048 characters before matching, for globs and regexes', () => {
    const long = 'https://a.com/' + 'x'.repeat(3000);
    expect(compilePattern('/^.{2048}$/s')(long)).toEqual({});
    expect(compilePattern('a.com/*y')(long + 'y')).toBeNull();
    expect(compilePattern('a.com/*')(long + 'y')).toEqual({});
  });
});
