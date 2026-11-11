import { describe, expect, it } from 'vitest';
import { isExemptUrl, normalizeUrl } from '../../../src/core/url/normalize';

const base = {
  stripParams: ['utm_*', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
  stripFragment: true,
  ignoreTrailingSlash: true,
  canonicalizers: [] as string[],
  urlTransforms: [] as { pattern: string; replacement: string; flags?: string }[],
  fragmentOverrides: [] as { pattern: string; keepFragment: boolean }[],
};
const key = (u: string, s = base) => normalizeUrl(u, s)?.key;

describe('isExemptUrl', () => {
  it.each([
    '', undefined, 'not a url', 'chrome://newtab', 'chrome-extension://x/a.html', 'about:blank',
    'devtools://x', 'view-source:http://a.com', 'file:///a', 'edge://x', 'data:text/plain,a',
    'blob:http://a.com/x', 'javascript:void(0)',
  ])('exempt %s', (u) => expect(isExemptUrl(u)).toBe(true));
  it('not exempt', () => {
    expect(isExemptUrl('https://a.com')).toBe(false);
    expect(isExemptUrl('http://localhost:3000/x')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  // The M1 githubPr canonicalizer is now the github-prs recipe's urlTransform (tests/recipes/github-prs.test.ts).
  it('github PR sub-pages are plain URLs without the github-prs transform; the fragment is still split off', () => {
    const k = key('https://github.com/o/r/pull/123');
    expect(k).toBe('https://github.com/o/r/pull/123');
    expect(key('https://github.com/o/r/pull/123/files')).toBe('https://github.com/o/r/pull/123/files');
    expect(key('https://github.com/o/r/pull/123#discussion_r456')).toBe(k);
    expect(normalizeUrl('https://github.com/o/r/pull/123#discussion_r456', base)?.fragment).toBe('discussion_r456');
  });
  it('the M1 githubPr id is ignored like any unknown id', () => {
    expect(key('https://github.com/o/r/pull/123/files', { ...base, canonicalizers: ['githubPr'] })).toBe('https://github.com/o/r/pull/123/files');
  });
  it('fragmentOverrides (T18): the first matching pattern decides keep/strip for that URL, over stripFragment', () => {
    const s = { ...base, fragmentOverrides: [{ pattern: 'app.example.com/*', keepFragment: true }, { pattern: 'app.example.com/x*', keepFragment: false }] };
    expect(key('https://app.example.com/#/a', s)).toBe('https://app.example.com/#/a');
    expect(key('https://app.example.com/x#/a', s)).toBe('https://app.example.com/x#/a'); // first match wins
    expect(key('https://other.com/x#a', s)).toBe('https://other.com/x');
    const strip = { ...base, stripFragment: false, fragmentOverrides: [{ pattern: 'b.com/*', keepFragment: false }] };
    expect(key('https://b.com/x#a', strip)).toBe('https://b.com/x');
    expect(key('https://c.com/x#a', strip)).toBe('https://c.com/x#a');
  });
  it('fragment precedence (T18↔T6): per-rule keepFragment > first matching fragmentOverride > stripFragment', () => {
    const s = { ...base, stripFragment: true, fragmentOverrides: [{ pattern: 'a.com/*', keepFragment: true }] };
    expect(normalizeUrl('https://a.com/x#f', s, { keepFragment: false })?.key).toBe('https://a.com/x');
    expect(normalizeUrl('https://a.com/x#f', s, {})?.key).toBe('https://a.com/x#f');
    expect(normalizeUrl('https://z.com/x#f', s)?.key).toBe('https://z.com/x');
  });
  it('fragmentOverrides match the ORIGINAL URL (before canonicalizers, params and urlTransforms)', () => {
    const s = {
      ...base, stripFragment: true,
      urlTransforms: [{ pattern: '^https://old\\.com/', replacement: 'https://new.com/' }],
      fragmentOverrides: [{ pattern: 'old.com/*', keepFragment: true }, { pattern: 'https://new.com/*', keepFragment: false }],
    };
    expect(key('https://old.com/p?utm_source=x#f', s)).toBe('https://new.com/p#f');
  });
  it('an invalid fragmentOverrides pattern is skipped', () => {
    expect(key('https://a.com/x#f', { ...base, fragmentOverrides: [{ pattern: '/(/', keepFragment: true }] })).toBe('https://a.com/x');
  });
  it('per-rule override: keepFragment wins over stripFragment (R25)', () => {
    expect(normalizeUrl('https://a.com/x#f', base, { keepFragment: true })).toEqual({ key: 'https://a.com/x#f', fragment: 'f' });
    expect(normalizeUrl('https://a.com/x#f', { ...base, stripFragment: false }, { keepFragment: false })).toEqual({ key: 'https://a.com/x', fragment: 'f' });
    expect(normalizeUrl('https://a.com/x#f', base, {})).toEqual({ key: 'https://a.com/x', fragment: 'f' });
  });
  it('unknown canonicalizer ids ignored', () => {
    expect(key('https://a.com/x', { ...base, canonicalizers: ['nope'] })).toBe('https://a.com/x');
  });
  it('strips params, exact and wildcard', () => {
    expect(key('https://a.com/x?utm_source=x&id=7')).toBe('https://a.com/x?id=7');
    expect(key('https://a.com/x?fbclid=1')).toBe('https://a.com/x');
  });
  it('trailing slash', () => {
    expect(key('https://a.com/x/')).toBe(key('https://a.com/x'));
    expect(key('https://a.com/')).toBe('https://a.com/');
    expect(key('https://a.com/x/', { ...base, ignoreTrailingSlash: false })).toBe('https://a.com/x/');
  });
  it('sorts query params', () => {
    expect(key('https://a.com/x?b=1&a=2')).toBe(key('https://a.com/x?a=2&b=1'));
    expect(key('https://a.com/x?a=2&a=1')).toBe('https://a.com/x?a=2&a=1');
  });
  it('fragment handling', () => {
    expect(normalizeUrl('https://a.com/x', base)?.fragment).toBe('');
    const r = normalizeUrl('https://a.com/x#f', { ...base, stripFragment: false });
    expect(r).toEqual({ key: 'https://a.com/x#f', fragment: 'f' });
  });
  it('http and https differ; host lowercased', () => {
    expect(key('http://a.com/x')).not.toBe(key('https://a.com/x'));
    expect(key('https://A.COM/x')).toBe('https://a.com/x');
  });
  it('urlTransforms', () => {
    const s = { ...base, stripParams: [], urlTransforms: [{ pattern: '\\?.*$', replacement: '' }] };
    expect(key('https://a.com/x?y=1', s)).toBe(key('https://a.com/x', s));
    const bad = { ...base, urlTransforms: [{ pattern: '(', replacement: '' }, { pattern: 'A', replacement: 'b', flags: 'i' }] };
    expect(key('https://a.com/x', bad)).toBe('https://b.com/x');
  });
  it('a urlTransform replacement lower-cases what follows \\L, up to \\E', () => {
    const s = (replacement: string) => ({ ...base, urlTransforms: [{ pattern: '^(https://a\\.com/)([^/]+)/([^/]+)$', replacement }] });
    expect(key('https://a.com/AbC/DeF', s('\\L$1$2/$3'))).toBe('https://a.com/abc/def');
    expect(key('https://a.com/AbC/DeF', s('$1\\L$2\\E/$3'))).toBe('https://a.com/abc/DeF');
    expect(key('https://a.com/AbC/DeF', s('$1$2/$3'))).toBe('https://a.com/AbC/DeF');
    // Only the replaced text: the rest of the key keeps its case.
    const partial = { ...base, urlTransforms: [{ pattern: '^(https://a\\.com/)([^/]+)', replacement: '$1\\L$2' }] };
    expect(key('https://a.com/AbC/DeF', partial)).toBe('https://a.com/abc/DeF');
  });
  it('returns null and never throws', () => {
    expect(normalizeUrl('chrome://newtab', base)).toBeNull();
    expect(normalizeUrl('not a url', base)).toBeNull();
    expect(normalizeUrl('', base)).toBeNull();
  });
});
