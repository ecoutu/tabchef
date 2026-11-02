import { describe, expect, it } from 'vitest';
import { importTabDeduper } from '../../../src/core/import/tab-deduper';
import empty from '../../../fixtures/tab-deduper.json?raw';
import synthetic from '../../../fixtures/tab-deduper.synthetic.json?raw';
import { compilePattern } from '../../../src/core/match/pattern';

const load = (n: string) => JSON.parse(n === 'tab-deduper.json' ? empty : synthetic);

describe('importTabDeduper', () => {
  it('empty export means defaults: nothing to import', () => {
    expect(importTabDeduper(load('tab-deduper.json'))).toEqual({ dedupe: {}, warnings: ['Tab Deduper had default settings; nothing to import.'] });
    expect(importTabDeduper({})).toEqual({ dedupe: {}, warnings: ['Tab Deduper had default settings; nothing to import.'] });
  });

  it('maps every key of the synthetic export', () => {
    const r = importTabDeduper(load('tab-deduper.synthetic.json'));
    expect(r.dedupe.scope).toBe('same-window');
    expect(r.dedupe.stripFragment).toBe(true);
    expect(r.dedupe.allowDuplicates).toEqual(['mail.google.com*', '/^[a-z][a-z0-9+.-]*:\\/\\/docs\\.google\\.com\\/spreadsheets/']);
    for (const p of r.dedupe.allowDuplicates!) expect(() => compilePattern(p)).not.toThrow();
    expect(r.dedupe.urlTransforms).toEqual([
      { pattern: '\\?.*$', replacement: '' },
      { pattern: '(github\\.com/[^/]+/[^/]+/pull/\\d+).*', replacement: '$1' },
    ]);
    expect(r.dedupe.matchTitle).toBe(true);
    expect(r.dedupe.titleOverrides).toEqual([{ pattern: 'github.com/acme*', matchTitle: false }]);
    expect(r.dedupe.fragmentOverrides).toEqual([{ pattern: 'app.example.com/#/*', keepFragment: true }]);
    expect(r.dedupe).toEqual({
      scope: 'same-window', stripFragment: true, matchTitle: true,
      titleOverrides: [{ pattern: 'github.com/acme*', matchTitle: false }],
      fragmentOverrides: [{ pattern: 'app.example.com/#/*', keepFragment: true }],
      allowDuplicates: r.dedupe.allowDuplicates, urlTransforms: r.dedupe.urlTransforms,
    });
    expect(r.warnings).toEqual([]);
    for (const p of [...r.dedupe.titleOverrides!, ...r.dedupe.fragmentOverrides!]) expect(() => compilePattern(p.pattern)).not.toThrow();
    const frag = compilePattern(r.dedupe.fragmentOverrides![0]!.pattern);
    expect(frag('https://app.example.com/#/inbox')).not.toBeNull();
    expect(compilePattern('github.com/acme*')('https://github.com/acme/api/pull/1')).not.toBeNull();
  });

  it('override lines (TD semantics): a plain line turns the feature on for that prefix, a `-` line turns it off; /regex/ kept', () => {
    const r = importTabDeduper({ local: {
      useTitleDefault: false, ignoreFragmentDefault: false,
      titleOverrides: 'news.example.com\n-quiet.example.com\n/^x\\.com\\/t/\n/(/',
      fragmentOverrides: 'strip.example.com/\n-keep.example.com/\n-/^y\\.com/i',
    } });
    expect(r.dedupe.matchTitle).toBe(false);
    expect(r.dedupe.titleOverrides).toEqual([
      { pattern: 'news.example.com*', matchTitle: true },
      { pattern: 'quiet.example.com*', matchTitle: false },
      { pattern: '/^[a-z][a-z0-9+.-]*:\\/\\/x\\.com\\/t/', matchTitle: true },
    ]);
    expect(r.dedupe.fragmentOverrides).toEqual([
      { pattern: 'strip.example.com/*', keepFragment: false },
      { pattern: 'keep.example.com/*', keepFragment: true },
      { pattern: '/^[a-z][a-z0-9+.-]*:\\/\\/y\\.com/i', keepFragment: true },
    ]);
    expect(r.warnings.join('\n')).toMatch(/\/\(\//);
  });

  it('maps explicit booleans, flags, and warns on negated exempts and bad transforms', () => {
    const r = importTabDeduper({ local: {
      dedupAllWindows: true, useTitleDefault: false, ignoreFragmentDefault: false,
      urlExempts: '-keep.example.com\n\nok.example.com',
      urlTranforms: 'a`b`gi\nbroken\n(`x`',
    } });
    expect(r.dedupe).toEqual({
      scope: 'all-windows', stripFragment: false, matchTitle: false, allowDuplicates: ['ok.example.com*'],
      urlTransforms: [{ pattern: 'a', replacement: 'b', flags: 'gi' }],
    });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/keep\.example\.com/);
    expect(w).toMatch(/broken/);
    expect(w).not.toMatch(/page titles/);
  });

  it('regex exempts and transforms match against the URL with its scheme', () => {
    const r = importTabDeduper(load('tab-deduper.synthetic.json'));
    const re = r.dedupe.allowDuplicates![1]!;
    expect(re.startsWith('/^[a-z][a-z0-9+.-]*:\\/\\/docs')).toBe(true);
    const m = compilePattern(re);
    expect(m('https://docs.google.com/spreadsheets/d/1')).not.toBeNull();
    expect(m('https://evil.com/docs.google.com/spreadsheets')).toBeNull();
    const g = compilePattern(r.dedupe.allowDuplicates![0]!);
    expect(g('https://mail.google.com/mail/u/0')).not.toBeNull();
    const t = importTabDeduper({ local: { urlExempts: '/foo/i', urlTranforms: '^example\\.com/(.*)`$1`' } });
    expect(t.dedupe.allowDuplicates).toEqual(['/foo/i']);
    const tr = t.dedupe.urlTransforms![0]!;
    expect('https://example.com/a'.replace(new RegExp(tr.pattern, tr.flags), tr.replacement)).toBe('a');
    expect('https://other.com/example.com/a'.replace(new RegExp(tr.pattern, tr.flags), tr.replacement)).toBe('https://other.com/example.com/a');
  });

  it('garbage input yields Unrecognized format', () => {
    for (const bad of [null, 5, 'x', [], { local: 5 }]) {
      expect(importTabDeduper(bad)).toEqual({ dedupe: {}, warnings: ['Unrecognized format'] });
    }
  });
});
