import { describe, it, expect } from 'vitest';
import { suggestPatterns } from '../../../src/core/lang/suggest';
import { compilePattern } from '../../../src/core/match/pattern';

describe('suggestPatterns (M2 T16)', () => {
  it('a PR URL: most specific to broadest, no scheme / query / fragment, id and leaf segments skipped', () => {
    expect(suggestPatterns('https://github.com/acme/api/pull/123/files?x=1')).toEqual([
      'github.com/acme/api/pull/*', 'github.com/acme/api/*', 'github.com/acme/*', 'github.com/*',
    ]);
  });

  it('a Jira issue: the first candidate is the browse folder', () => {
    expect(suggestPatterns('https://acme.atlassian.net/browse/ABC-1')[0]).toBe('acme.atlassian.net/browse/*');
  });

  it('a host-only URL: the host, then *.<registrable-ish domain> when the host has 3+ labels', () => {
    expect(suggestPatterns('https://acme.atlassian.net/')).toEqual(['acme.atlassian.net/*', '*.atlassian.net/*']);
    expect(suggestPatterns('https://github.com/')).toEqual(['github.com/*']);
    expect(suggestPatterns('https://www.bbc.co.uk/')).toEqual(['www.bbc.co.uk/*', '*.bbc.co.uk/*']);
    expect(suggestPatterns('https://bbc.co.uk/')).toEqual(['bbc.co.uk/*']);
  });

  it('exempt and non-web URLs give nothing', () => {
    for (const u of ['chrome://settings', 'chrome-extension://abc/options.html', 'about:blank', 'file:///tmp/x', 'not a url', ''])
      expect(suggestPatterns(u)).toEqual([]);
  });

  it('keeps the port, never builds a wildcard domain from an IP address', () => {
    expect(suggestPatterns('http://localhost:3000/app/page')).toEqual(['localhost:3000/app/*', 'localhost:3000/*']);
    expect(suggestPatterns('http://192.168.1.10/')).toEqual(['192.168.1.10/*']);
  });

  it('every candidate compiles and matches the URL it came from (segments the glob syntax cannot hold are skipped)', () => {
    for (const u of ['https://github.com/acme/api/pull/123/files?x=1', 'https://x.example.org/a/:b/c*d/e/f', 'https://en.wikipedia.org/wiki/Foo_(bar)']) {
      const c = suggestPatterns(u);
      expect(c.length).toBeGreaterThan(0);
      for (const p of c) expect(compilePattern(p)(u)).not.toBeNull();
    }
    expect(suggestPatterns('https://x.example.org/a/:b/c*d/e/f')).not.toContain('x.example.org/a/:b/*');
  });
});
