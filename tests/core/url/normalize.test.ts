import { describe, expect, it } from 'vitest';
import { isExemptUrl, normalizeUrl } from '../../../src/core/url/normalize';

const base = {
  stripParams: ['utm_*', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
  stripFragment: true,
  ignoreTrailingSlash: true,
  canonicalizers: ['githubPr'],
  urlTransforms: [] as { pattern: string; replacement: string; flags?: string }[],
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
  it('github PR variants share a key', () => {
    const k = key('https://github.com/o/r/pull/123');
    expect(k).toBe('https://github.com/o/r/pull/123');
    expect(key('https://github.com/o/r/pull/123/files')).toBe(k);
    expect(key('https://github.com/o/r/pull/123/files/abc')).toBe(k);
    expect(key('https://github.com/o/r/pull/123/commits?w=1', { ...base, stripParams: ['w'] })).toBe(k);
    expect(key('https://github.com/o/r/pull/123/checks')).toBe(k);
    expect(key('https://github.com/o/r/pull/123#discussion_r456')).toBe(k);
    expect(normalizeUrl('https://github.com/o/r/pull/123#discussion_r456', base)?.fragment).toBe('discussion_r456');
  });
  it('does not canonicalize non-PR github paths or other hosts', () => {
    expect(key('https://github.com/o/r/pull/123/other')).toBe('https://github.com/o/r/pull/123/other');
    expect(key('https://example.com/o/r/pull/123/files')).toBe('https://example.com/o/r/pull/123/files');
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
  it('returns null and never throws', () => {
    expect(normalizeUrl('chrome://newtab', base)).toBeNull();
    expect(normalizeUrl('not a url', base)).toBeNull();
    expect(normalizeUrl('', base)).toBeNull();
  });
});
