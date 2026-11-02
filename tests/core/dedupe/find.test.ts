import { describe, expect, it } from 'vitest';
import { findDuplicate, findDuplicateSets } from '../../../src/core/dedupe/find';
import { defaultConfig } from '../../../src/core/config/defaults';
import type { DedupeSettings, TabSnap } from '../../../src/core/types';
import { programOf } from '../../helpers/config';

// Effective settings of the default program: the github-prs recipe supplies the PR urlTransform.
const s = (o: Partial<DedupeSettings> = {}): DedupeSettings => ({ ...programOf(defaultConfig()).dedupe, ...o });
const tab = (id: number, url: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id, windowId: 1, index: id, url, title: `t${id}`, pinned: false, groupId: -1, incognito: false,
  discarded: false, active: false, audible: false, ...o,
});
const PR = 'https://github.com/acme/api/pull/123';

describe('findDuplicate', () => {
  it('/pull/123/files matches an existing /pull/123 tab', () => {
    const existing = tab(1, PR);
    const r = findDuplicate(tab(2, `${PR}/files`), [existing, tab(2, `${PR}/files`)], s());
    expect(r?.existing.id).toBe(1);
    expect(r?.fragment).toBe('');
  });

  it('a #discussion_r1 variant sets fragment', () => {
    const r = findDuplicate(tab(2, `${PR}#discussion_r1`), [tab(1, PR)], s());
    expect(r?.existing.id).toBe(1);
    expect(r?.fragment).toBe('discussion_r1');
  });

  // Review Focus #4
  it.each(['chrome://newtab', 'chrome://newtab/', 'about:blank'])('exempt URL %s -> null', (u) => {
    expect(findDuplicate(tab(2, u), [tab(1, u), tab(2, u)], s())).toBeNull();
  });

  it('a pinned candidate -> null', () => {
    expect(findDuplicate(tab(2, PR, { pinned: true }), [tab(1, PR)], s())).toBeNull();
  });

  it('a pinned tab can be the existing tab', () => {
    expect(findDuplicate(tab(2, PR), [tab(1, PR, { pinned: true })], s())?.existing.id).toBe(1);
  });

  it('an allowDuplicates match -> null', () => {
    expect(findDuplicate(tab(2, PR), [tab(1, PR)], s({ allowDuplicates: ['github.com/acme/**'] }))).toBeNull();
  });

  it('invalid allowDuplicates pattern is ignored', () => {
    expect(findDuplicate(tab(2, PR), [tab(1, PR)], s({ allowDuplicates: ['/(/'] }))?.existing.id).toBe(1);
  });

  it('excludes the candidate itself', () => {
    expect(findDuplicate(tab(2, PR), [tab(2, PR)], s())).toBeNull();
  });

  it('picks the oldest (lowest id) existing tab', () => {
    expect(findDuplicate(tab(9, PR), [tab(5, PR), tab(3, PR), tab(9, PR)], s())?.existing.id).toBe(3);
  });

  it('matches an existing tab by its pendingUrl', () => {
    expect(findDuplicate(tab(2, PR), [tab(1, 'about:blank', { pendingUrl: PR })], s())?.existing.id).toBe(1);
  });

  it('incognito excluded unless includeIncognito', () => {
    expect(findDuplicate(tab(2, PR), [tab(1, PR, { incognito: true })], s())).toBeNull();
    expect(findDuplicate(tab(2, PR, { incognito: true }), [tab(1, PR)], s())).toBeNull();
    expect(findDuplicate(tab(2, PR), [tab(1, PR, { incognito: true })], s({ includeIncognito: true }))?.existing.id)
      .toBe(1);
  });

  it('scope same-window only considers the candidate window', () => {
    const other = tab(1, PR, { windowId: 7 });
    expect(findDuplicate(tab(2, PR), [other], s({ scope: 'same-window' }))).toBeNull();
    expect(findDuplicate(tab(2, PR), [other], s({ scope: 'all-windows' }))?.existing.id).toBe(1);
  });

  it('override mode off overrides s.mode; override always-switch overrides s.mode off', () => {
    expect(findDuplicate(tab(2, PR), [tab(1, PR)], s(), { mode: 'off' })).toBeNull();
    expect(findDuplicate(tab(2, PR), [tab(1, PR)], s({ mode: 'off' }))).toBeNull();
    expect(findDuplicate(tab(2, PR), [tab(1, PR)], s({ mode: 'off' }), { mode: 'always-switch' })?.existing.id).toBe(1);
  });

  it('override keepFragment keys both tabs with their fragment (R25)', () => {
    expect(findDuplicate(tab(2, `${PR}#a`), [tab(1, `${PR}#b`)], s(), { keepFragment: true })).toBeNull();
    expect(findDuplicate(tab(2, `${PR}#a`), [tab(1, `${PR}#a`)], s(), { keepFragment: true })?.existing.id).toBe(1);
    expect(findDuplicate(tab(2, `${PR}#a`), [tab(1, `${PR}#b`)], s())?.existing.id).toBe(1);
  });

  it('a protected candidate -> null', () => {
    expect(findDuplicate(tab(2, PR), [tab(1, PR)], s(), undefined, new Set([2]))).toBeNull();
  });
});

describe('findDuplicate: Tab Deduper parity (T18)', () => {
  const APP = 'https://app.example.com/';
  it('fragmentOverrides: app.example.com keeps its #/route, other sites still strip', () => {
    const fo = s({ fragmentOverrides: [{ pattern: 'app.example.com/*', keepFragment: true }] });
    expect(findDuplicate(tab(2, `${APP}#/b`), [tab(1, `${APP}#/a`)], fo)).toBeNull();
    expect(findDuplicate(tab(2, `${APP}#/a`), [tab(1, `${APP}#/a`)], fo)?.existing.id).toBe(1);
    expect(findDuplicate(tab(2, 'https://other.com/x#b'), [tab(1, 'https://other.com/x#a')], fo)?.existing.id).toBe(1);
  });

  it('matchTitle: true makes the same URL with different titles not duplicates', () => {
    const u = 'https://a.com/x';
    expect(findDuplicate(tab(2, u, { title: 'B' }), [tab(1, u, { title: 'A' })], s({ matchTitle: true }))).toBeNull();
    expect(findDuplicate(tab(2, u, { title: 'A' }), [tab(1, u, { title: 'A' })], s({ matchTitle: true }))?.existing.id).toBe(1);
    expect(findDuplicate(tab(2, u, { title: 'B' }), [tab(1, u, { title: 'A' })], s())?.existing.id).toBe(1);
  });

  it('matchTitle: an empty title on either side is never a duplicate (R18)', () => {
    const u = 'https://a.com/x';
    expect(findDuplicate(tab(2, u, { title: '' }), [tab(1, u, { title: '' })], s({ matchTitle: true }))).toBeNull();
    expect(findDuplicate(tab(2, u, { title: 'A' }), [tab(1, u, { title: '' })], s({ matchTitle: true }))).toBeNull();
  });

  it('matchTitle precedence (brief): first matching titleOverrides entry > per-rule matchTitle > global', () => {
    const u = 'https://github.com/acme/x';
    const diff = (st: DedupeSettings, o?: { matchTitle?: boolean }) =>
      findDuplicate(tab(2, u, { title: 'B' }), [tab(1, u, { title: 'A' })], st, o)?.existing.id ?? null;
    const ov = s({ matchTitle: true, titleOverrides: [{ pattern: 'github.com/acme*', matchTitle: false }, { pattern: 'github.com/*', matchTitle: true }] });
    expect(diff(ov)).toBe(1); // override beats the global setting
    expect(diff(ov, { matchTitle: true })).toBe(1); // ...and the per-rule setting
    expect(diff(s({ matchTitle: false }), { matchTitle: true })).toBeNull(); // per-rule beats global
    expect(diff(s({ matchTitle: true }), { matchTitle: false })).toBe(1);
    expect(diff(s({ matchTitle: true, titleOverrides: [{ pattern: '/(/', matchTitle: false }] }))).toBeNull(); // invalid pattern skipped
  });
});

describe('findDuplicateSets', () => {
  it('groups 3 copies into one set, oldest first, sorted by size', () => {
    const tabs = [
      tab(7, `${PR}/files`), tab(3, PR), tab(5, `${PR}#x`),
      tab(1, 'https://a.com/'), tab(2, 'https://a.com'),
      tab(4, 'https://solo.com/'), tab(6, 'chrome://newtab'), tab(8, 'chrome://newtab'),
    ];
    const sets = findDuplicateSets(tabs, s());
    expect(sets.map((x) => x.tabs.map((t) => t.id))).toEqual([[3, 5, 7], [1, 2]]);
    expect(sets[0]!.key).toBe(PR);
  });

  it('skips allowDuplicates and incognito', () => {
    const tabs = [tab(1, PR), tab(2, PR, { incognito: true })];
    expect(findDuplicateSets(tabs, s())).toEqual([]);
    expect(findDuplicateSets([tab(1, PR), tab(2, PR)], s({ allowDuplicates: ['github.com/**'] }))).toEqual([]);
  });

  it('per-tab dedupe overrides (R25, T17): mode off leaves the tab out; keepFragment keys that tab with its fragment', () => {
    const tabs = [tab(1, 'https://a.com/x'), tab(2, 'https://a.com/x'), tab(3, 'https://a.com/x#f'), tab(4, 'https://a.com/x#f')];
    const off = findDuplicateSets(tabs, s(), (t) => (t.id === 2 ? { mode: 'off' } : undefined));
    expect(off.map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 3, 4]]);
    const frag = findDuplicateSets(tabs, s(), (t) => (t.id >= 3 ? { keepFragment: true } : undefined));
    expect(frag.map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 2], [3, 4]]);
  });

  it('title-aware (T18): same URL with different titles splits into separate sets with distinct keys', () => {
    const u = 'https://a.com/x';
    const tabs = [tab(1, u, { title: 'A' }), tab(2, u, { title: 'B' }), tab(3, u, { title: 'A' }), tab(4, u, { title: 'B' }), tab(5, u, { title: '' })];
    const sets = findDuplicateSets(tabs, s({ matchTitle: true }));
    expect(sets.map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 3], [2, 4]]);
    expect(new Set(sets.map((x) => x.key)).size).toBe(2);
    expect(findDuplicateSets(tabs, s(), () => ({ matchTitle: true })).map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 3], [2, 4]]);
  });

  /** Every extra of every set is a findDuplicate of the set's KEPT tab (tabs[0]) under the extra's own override. */
  const expectExtrasMatchKept = (sets: { tabs: TabSnap[] }[], st: DedupeSettings, ov: (t: TabSnap) => { keepFragment?: boolean; matchTitle?: boolean } | undefined) => {
    for (const x of sets) {
      for (const t of x.tabs.slice(1)) expect([t.id, findDuplicate(t, [x.tabs[0]!], st, ov(t))?.existing.id]).toEqual([t.id, x.tabs[0]!.id]);
    }
  };

  it('agrees with findDuplicate pairwise: every extra is a findDuplicate of the kept tab, with its own override', () => {
    const u = 'https://a.com/x';
    const tabs = [
      tab(1, `${u}#a`, { title: 'A' }), tab(2, `${u}#b`, { title: 'A' }), tab(3, `${u}#a`, { title: 'A' }),
      tab(4, u, { title: 'C' }), tab(5, u, { title: 'A' }), tab(6, `${u}#b`, { title: 'Z' }),
    ];
    const st = s({ titleOverrides: [{ pattern: 'a.com/*', matchTitle: true }] });
    const ov = (t: TabSnap) => (t.id % 2 === 0 ? { keepFragment: true } : undefined);
    const sets = findDuplicateSets(tabs, st, ov);
    expectExtrasMatchKept(sets, st, ov);
    expect(sets.map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 3, 5]]);
  });

  it('mixed overrides are not transitive (fix round 1): a tab matching only an extra is not put in that set', () => {
    // Fragment: C (keepFragment) duplicates B but not A; B (no override) duplicates A.
    const frag = [tab(1, 'https://a.com/x#1'), tab(2, 'https://a.com/x#2'), tab(3, 'https://a.com/x#2')];
    const fov = (t: TabSnap) => (t.id === 3 ? { keepFragment: true } : undefined);
    expect(findDuplicate(frag[2]!, [frag[0]!], s(), fov(frag[2]!))).toBeNull();
    const fs = findDuplicateSets(frag, s(), fov);
    expectExtrasMatchKept(fs, s(), fov);
    expect(fs.map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 2]]);
    // Title: C (matchTitle rule, global off) duplicates B ("Two") but not A ("One"); B (no title check) duplicates A.
    const u = 'https://a.com/y';
    const titled = [tab(1, u, { title: 'One' }), tab(2, u, { title: 'Two' }), tab(3, u, { title: 'Two' })];
    const tov = (t: TabSnap) => (t.id === 3 ? { matchTitle: true } : undefined);
    const ts = findDuplicateSets(titled, s(), tov);
    expectExtrasMatchKept(ts, s(), tov);
    expect(ts.map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 2]]);
  });

  it('an unlinked tab can still keep its own set for later tabs', () => {
    const u = 'https://a.com/y';
    const tabs = [tab(1, u, { title: 'One' }), tab(2, u, { title: 'Two' }), tab(3, u, { title: 'Two' }), tab(4, u, { title: 'Two' })];
    const ov = (t: TabSnap) => (t.id >= 2 ? { matchTitle: true } : undefined);
    const sets = findDuplicateSets(tabs, s(), ov);
    expectExtrasMatchKept(sets, s(), ov);
    expect(sets.map((x) => x.tabs.map((t) => t.id))).toEqual([[2, 3, 4]]);
  });

  it('same-window scope: sets with the same URL in two windows get distinct keys', () => {
    const tabs = [tab(1, PR), tab(2, PR), tab(3, PR, { windowId: 2 }), tab(4, PR, { windowId: 2 })];
    const sets = findDuplicateSets(tabs, s({ scope: 'same-window' }));
    expect(sets.map((x) => x.tabs.map((t) => t.id))).toEqual([[1, 2], [3, 4]]);
    expect(new Set(sets.map((x) => x.key)).size).toBe(2);
  });
});
