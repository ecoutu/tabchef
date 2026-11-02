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
});
