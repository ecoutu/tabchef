import { describe, expect, it } from 'vitest';
import { importAutoGroupTabs, decodeGroups } from '../../../src/core/import/auto-group-tabs';
import raw from '../../../fixtures/auto-group-tabs.json?raw';
import { compilePattern } from '../../../src/core/match/pattern';

const fixture = JSON.parse(raw);
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

describe('importAutoGroupTabs', () => {
  it('decodes the unknown-size LZMA header fixture, preserving count and order', async () => {
    const src = (await decodeGroups(fixture.sync.groups)) as { id: string; title: string }[];
    const r = await importAutoGroupTabs(fixture);
    expect(src.length).toBe(13);
    expect(r.rules.length).toBe(src.length);
    expect(r.rules.map((x) => x.id)).toEqual(src.map((x) => x.id));
    expect(r.rules.map((x) => x.group.title)).toEqual(src.map((x) => x.title));
  });

  it('maps fields faithfully and every pattern compiles', async () => {
    const r = await importAutoGroupTabs(fixture);
    for (const rule of r.rules) {
      expect(COLORS).toContain(rule.group.color);
      expect(rule.enabled).toBe(true);
      expect(rule.name).toBe(rule.group.title);
      expect(typeof rule.strict).toBe('boolean');
      expect(typeof rule.merge).toBe('boolean');
      for (const p of [rule.match.url].flat()) expect(() => compilePattern(p)).not.toThrow();
    }
  });

  it('accepts the inner object and an already-decoded array', async () => {
    const a = await importAutoGroupTabs(fixture.sync);
    const decoded = await decodeGroups(fixture.sync.groups);
    const b = await importAutoGroupTabs({ groups: decoded });
    expect(a.rules).toEqual(b.rules);
  });

  it('maps options, missing options default to false', async () => {
    const r = await importAutoGroupTabs({ groups: [
      { id: 'a', title: 'A', color: 'blue', matchers: ['https://a.example/*'], options: { strict: true, merge: true } },
      { id: 'b', title: 'B', color: 'red', matchers: ['/^https:\\/\\/b\\./i'] },
    ] });
    expect(r.rules[0]).toMatchObject({ strict: true, merge: true, match: { url: ['https://a.example/*'] } });
    expect(r.rules[1]).toMatchObject({ strict: false, merge: false });
    expect(r.warnings).toEqual([]);
  });

  it('warns (no throw) on bad color, bad pattern, unknown option, shared title with different colors', async () => {
    const r = await importAutoGroupTabs({ groups: [
      { id: 'a', title: 'A', color: 'mauve', matchers: ['https://a.example/*'], options: { sticky: true } },
      { id: 'b', title: 'A', color: 'red', matchers: ['/(/'] },
      { id: 'c', title: 'A', color: 'blue', matchers: ['https://c.example/*'] },
    ] });
    expect(r.rules.map((x) => x.id)).toEqual(['a', 'c']);
    expect(r.rules[0]!.group.color).toBe('grey');
    const w = r.warnings.join('\n');
    expect(w).toMatch(/mauve/);
    expect(w).toMatch(/sticky/);
    expect(w).toMatch(/pattern/i);
    expect(w).toMatch(/Title "A".*different colors/);
  });

  it('garbage input yields Unrecognized format', async () => {
    for (const bad of [null, 5, 'x', [], {}, { groups: 'not-lzma' }, { sync: { groups: 7 } }]) {
      expect(await importAutoGroupTabs(bad)).toEqual({ rules: [], warnings: ['Unrecognized format'] });
    }
  });

  it('refuses LZMA data that declares a decoded size over 10 MB', async () => {
    const hdr = new Uint8Array(20);
    hdr.set([0x5d, 0, 0, 0x80, 0]);
    new DataView(hdr.buffer).setUint32(5, 20 * 1024 * 1024, true);
    const b64 = btoa(String.fromCharCode(...hdr));
    expect(await importAutoGroupTabs({ groups: b64 })).toEqual({ rules: [], warnings: ['Decoded data too large'] });
  });
});
