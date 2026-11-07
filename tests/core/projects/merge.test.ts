import { describe, expect, it } from 'vitest';
import type { SyncedProject } from '../../../src/core/projects/bookmark-format';
import { fromFolder, toFolder } from '../../../src/core/projects/bookmark-format';
import { mergeProject } from '../../../src/core/projects/merge';

const t = (url: string, title = url) => ({ url, title });
const proj = (over: Partial<SyncedProject> = {}): SyncedProject => ({
  id: 'jira:ABC-1', recipeId: 'jira', key: 'ABC-1', name: 'Fix login', color: 'blue', updatedAt: 100,
  groups: [{ title: 'Code', tabs: [t('https://a.test/1')] }, { title: '', tabs: [t('https://a.test/loose')] }],
  ...over,
});
const urls = (p: SyncedProject | undefined) => p!.groups.flatMap((g) => g.tabs.map((x) => x.url));

describe('mergeProject', () => {
  it('keeps both sides additions after a concurrent edit', () => {
    const base = proj();
    const local = proj({ updatedAt: 200, groups: [{ title: 'Code', tabs: [t('https://a.test/1'), t('https://a.test/x')] }, { title: '', tabs: [t('https://a.test/loose')] }] });
    const remote = proj({ updatedAt: 300, groups: [{ title: 'Code', tabs: [t('https://a.test/1'), t('https://a.test/y')] }, { title: '', tabs: [t('https://a.test/loose')] }] });
    const { result, conflicts } = mergeProject(base, local, remote);
    expect(mergeProject(base, remote, local)).toEqual({ result, conflicts });
    expect(urls(result).sort()).toEqual(['https://a.test/1', 'https://a.test/loose', 'https://a.test/x', 'https://a.test/y']);
    expect(conflicts).toEqual([]);
  });

  it('applies a tab delete on one side and a rename on the other', () => {
    const base = proj();
    const local = proj({ updatedAt: 200, groups: [{ title: 'Code', tabs: [] }, { title: '', tabs: [t('https://a.test/loose')] }] });
    const remote = proj({ updatedAt: 300, name: 'Renamed' });
    const { result } = mergeProject(base, local, remote);
    expect(mergeProject(base, remote, local).result).toEqual(result);
    expect(urls(result)).toEqual(['https://a.test/loose']);
    expect(result!.name).toBe('Renamed');
    // The rename survives as the older side too: only one side changed the name.
    const renamedFirst = proj({ updatedAt: 200, name: 'Renamed' });
    const deletedLater = proj({ updatedAt: 300, groups: [{ title: 'Code', tabs: [] }, { title: '', tabs: [t('https://a.test/loose')] }] });
    for (const [l, r] of [[renamedFirst, deletedLater], [deletedLater, renamedFirst]] as const) {
      const swapped = mergeProject(base, l, r).result;
      expect(urls(swapped)).toEqual(['https://a.test/loose']);
      expect(swapped!.name).toBe('Renamed');
    }
  });

  it('keeps a project deleted on one side and edited on the other, and reports it', () => {
    const base = proj();
    const edited = proj({ updatedAt: 200, name: 'Edited' });
    for (const [l, r] of [[edited, undefined], [undefined, edited]] as const) {
      const { result, conflicts } = mergeProject(base, l, r);
      expect(result).toEqual(edited);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toContain('jira:ABC-1');
    }
  });

  it('deletes a project removed on one side and unchanged on the other', () => {
    const base = proj();
    expect(mergeProject(base, base, undefined)).toEqual({ result: undefined, conflicts: [] });
    expect(mergeProject(base, undefined, proj())).toEqual({ result: undefined, conflicts: [] });
    expect(mergeProject(base, undefined, undefined)).toEqual({ result: undefined, conflicts: [] });
    expect(mergeProject(undefined, undefined, undefined)).toEqual({ result: undefined, conflicts: [] });
  });

  it('counts a tab reorder as a change when deciding delete vs edit', () => {
    const base = proj({ groups: [{ title: 'Code', tabs: [t('https://a.test/1'), t('https://a.test/2')] }] });
    const reordered = proj({ groups: [{ title: 'Code', tabs: [t('https://a.test/2'), t('https://a.test/1')] }] });
    expect(mergeProject(base, reordered, undefined).conflicts).toHaveLength(1);
  });

  it('unions the sides on a first sync without a base', () => {
    const local = proj({ updatedAt: 200, groups: [{ title: 'Code', tabs: [t('https://a.test/x')] }] });
    const remote = proj({ updatedAt: 100, groups: [{ title: 'Code', tabs: [t('https://a.test/y')] }] });
    const { result } = mergeProject(undefined, local, remote);
    expect(mergeProject(undefined, remote, local).result).toEqual(result);
    expect(urls(result)).toEqual(['https://a.test/x', 'https://a.test/y']);
    expect(mergeProject(undefined, local, undefined).result).toEqual(local);
    expect(mergeProject(undefined, undefined, remote).result).toEqual(remote);
  });

  it('is idempotent', () => {
    const m = proj({ extra: { future: 1 } });
    expect(mergeProject(m, m, m)).toEqual({ result: m, conflicts: [] });
    expect(mergeProject(undefined, m, m).result).toEqual(m);
  });

  it('keeps saved tabs that differ only by tracking params or #fragment as separate tabs', () => {
    const local = proj({ updatedAt: 100, groups: [{ title: 'Code', tabs: [t('https://a.test/p?utm_source=x', 'old'), t('https://a.test/p#a', 'a')] }] });
    const remote = proj({ updatedAt: 200, groups: [{ title: 'Code', tabs: [t('https://a.test/p', 'new')] }] });
    const { result } = mergeProject(undefined, local, remote);
    expect(mergeProject(undefined, remote, local).result).toEqual(result);
    expect(result!.groups).toEqual([{ title: 'Code', tabs: [t('https://a.test/p', 'new'), t('https://a.test/p?utm_source=x', 'old'), t('https://a.test/p#a', 'a')] }]);
  });

  it('matches tabs by URL as parsed, keeping the winning side URL and title', () => {
    const local = proj({ updatedAt: 100, groups: [{ title: 'Code', tabs: [t('HTTPS://A.test/p', 'old')] }] });
    const remote = proj({ updatedAt: 200, groups: [{ title: 'Code', tabs: [t('https://a.test/p', 'new')] }] });
    const { result } = mergeProject(undefined, local, remote);
    expect(mergeProject(undefined, remote, local).result).toEqual(result);
    expect(result!.groups).toEqual([{ title: 'Code', tabs: [t('https://a.test/p', 'new')] }]);
  });

  it('takes group membership, order, fields and extra from the newer side', () => {
    const local = proj({ updatedAt: 100, color: 'red', extra: { a: 1 }, groups: [
      { title: 'Docs', tabs: [t('https://a.test/d')] }, { title: 'Code', tabs: [t('https://a.test/1')] }, { title: 'Old', tabs: [t('https://a.test/o')] }] });
    const remote = proj({ updatedAt: 200, color: 'green', extra: { b: 2 }, groups: [
      { title: 'Code', tabs: [t('https://a.test/1'), t('https://a.test/d')] }] });
    const { result } = mergeProject(undefined, local, remote);
    expect(mergeProject(undefined, remote, local).result).toEqual(result);
    expect(result!.color).toBe('green');
    expect(result!.extra).toEqual({ b: 2 });
    expect(result!.updatedAt).toBe(200);
    expect(result!.groups.map((g) => [g.title, g.tabs.map((x) => x.url)])).toEqual([
      ['Code', ['https://a.test/1', 'https://a.test/d']], ['Old', ['https://a.test/o']]]);
  });

  it('drops empty groups, puts ungrouped last and merges duplicate group titles', () => {
    const messy = proj({ groups: [{ title: '', tabs: [t('https://a.test/l')] }, { title: 'A', tabs: [] }, { title: 'B', tabs: [t('https://a.test/b')] }, { title: 'B', tabs: [t('https://a.test/c')] }, { title: '', tabs: [t('https://a.test/m')] }] });
    const { result } = mergeProject(undefined, messy, messy);
    expect(result!.groups.map((g) => [g.title, g.tabs.length])).toEqual([['B', 2], ['', 2]]);
  });

  it('converges on a timestamp tie whichever device runs the merge', () => {
    const base = proj();
    const a = proj({ updatedAt: 200, name: 'A name', groups: [{ title: 'Code', tabs: [t('https://a.test/x')] }] });
    const b = proj({ updatedAt: 200, name: 'B name', groups: [{ title: 'Code', tabs: [t('https://a.test/y')] }] });
    expect(mergeProject(base, a, b)).toEqual(mergeProject(base, b, a));
    expect(mergeProject(undefined, a, b)).toEqual(mergeProject(undefined, b, a));
  });

  describe('M4-R38: a field changed only on the older side survives a newer side that changed nothing that syncs', () => {
    const base = proj();
    const bumped = proj({ updatedAt: 300 }); // reopen / Close group / Undo / rule revive: updatedAt only
    for (const [what, edit, check] of [
      ['rename', { name: 'Fix login 2' }, (r: SyncedProject) => expect(r.name).toBe('Fix login 2')],
      ['colour change', { color: 'red' }, (r: SyncedProject) => expect(r.color).toBe('red')],
      ['archive', { archivedAt: 200 }, (r: SyncedProject) => expect(r.archivedAt).toBe(200)],
      ['extra', { extra: { future: 1 } }, (r: SyncedProject) => expect(r.extra).toEqual({ future: 1 })],
    ] as const) {
      it(`keeps an older-side ${what}`, () => {
        const older = proj({ updatedAt: 200, ...edit });
        for (const [l, r] of [[older, bumped], [bumped, older]] as const) {
          const { result, conflicts } = mergeProject(base, l, r);
          check(result!);
          expect(conflicts).toEqual([]);
        }
      });
    }

    it('still lets the newer side win a field both sides changed (D1)', () => {
      const a = proj({ updatedAt: 200, name: 'A name' });
      const b = proj({ updatedAt: 300, name: 'B name' });
      expect(mergeProject(base, a, b).result!.name).toBe('B name');
      expect(mergeProject(base, b, a).result!.name).toBe('B name');
    });
  });

  describe('M4-R38: other fields changed only on the older side', () => {
    const base = proj();
    it('a rename on the older side survives a colour change on the newer side (different fields)', () => {
      const older = proj({ updatedAt: 200, name: 'Fix login 2' });
      const newer = proj({ updatedAt: 300, color: 'red' });
      const { result } = mergeProject(base, older, newer);
      expect(result!.name).toBe('Fix login 2');
      expect(result!.color).toBe('red');
    });

    it('a rename on the older side survives a tab added on the newer side (close-and-save, add a tab)', () => {
      const older = proj({ updatedAt: 200, name: 'Fix login 2' });
      const newer = proj({ updatedAt: 300, groups: [{ title: 'Code', tabs: [t('https://a.test/1'), t('https://a.test/2')] }, { title: '', tabs: [t('https://a.test/loose')] }] });
      expect(mergeProject(base, older, newer).result!.name).toBe('Fix login 2');
    });

    it('a tab moved to another group on the older side stays moved when the newer side only bumped updatedAt', () => {
      const older = proj({ updatedAt: 200, groups: [{ title: 'Code', tabs: [] }, { title: '', tabs: [t('https://a.test/loose'), t('https://a.test/1')] }] });
      const bumped = proj({ updatedAt: 300 });
      const { result } = mergeProject(base, older, bumped);
      expect(result!.groups.find((g) => g.title === '')!.tabs.map((x) => x.url)).toContain('https://a.test/1');
    });
  });

  describe('key order independence', () => {
    // Same data, keys inserted in a different order (store order vs fromFolder order).
    const reorder = (p: SyncedProject): SyncedProject => ({
      groups: p.groups, updatedAt: p.updatedAt, archivedAt: p.archivedAt, color: p.color, name: p.name, key: p.key, recipeId: p.recipeId, id: p.id,
      ...(p.extra ? { extra: Object.fromEntries(Object.entries(p.extra).reverse()) } : {}),
    } as SyncedProject);
    const viaFolder = (p: SyncedProject): SyncedProject => fromFolder(toFolder(p)) as SyncedProject;

    it('converges on a tie when each device lists its own copy in store order and the other in folder order', () => {
      const a = proj({ updatedAt: 200, color: undefined, name: 'A', extra: { x: { p: 1, q: 2 }, y: 1 } });
      const b = proj({ updatedAt: 200, color: undefined, name: 'B', extra: { x: { p: 1, q: 2 }, y: 1 } });
      const deviceA = mergeProject(undefined, reorder(a), viaFolder(b));
      const deviceB = mergeProject(undefined, reorder(b), viaFolder(a));
      expect(deviceA).toEqual(deviceB);
      expect(mergeProject(proj(), reorder(a), viaFolder(b))).toEqual(mergeProject(proj(), reorder(b), viaFolder(a)));
    });

    it('treats an unchanged project with reordered keys as unchanged against a delete', () => {
      const base = proj({ extra: { x: { p: 1, q: 2 }, y: 1 } });
      for (const same of [reorder(base), viaFolder(base)]) {
        expect(mergeProject(base, same, undefined)).toEqual({ result: undefined, conflicts: [] });
        expect(mergeProject(base, undefined, same)).toEqual({ result: undefined, conflicts: [] });
      }
    });
  });
});

// M4-R41: the sync merge must not dedupe saved tabs more aggressively than the device that saved them.
describe('M4-R41: saved tabs that differ only after #', () => {
  const G1 = 'https://mail.google.com/mail/u/0/#inbox/AAA';
  const G2 = 'https://mail.google.com/mail/u/0/#inbox/BBB';
  const mail = (over: Partial<SyncedProject> = {}) => proj({ groups: [{ title: 'Mail', tabs: [t(G1), t(G2)] }], ...over });

  it('a first sync (one side, no base) keeps both', () => {
    expect(urls(mergeProject(undefined, mail(), undefined).result)).toEqual([G1, G2]);
  });

  it('a rename on the other side keeps both', () => {
    const { result } = mergeProject(mail(), mail(), mail({ updatedAt: 200, name: 'Renamed' }));
    expect(urls(result)).toEqual([G1, G2]);
    expect(result!.name).toBe('Renamed');
  });

  it('a thread added on each device is kept from both', () => {
    const base = proj({ groups: [{ title: 'Mail', tabs: [t(G1)] }] });
    const G3 = 'https://mail.google.com/mail/u/0/#inbox/CCC';
    const local = proj({ updatedAt: 200, groups: [{ title: 'Mail', tabs: [t(G1), t(G2)] }] });
    const remote = proj({ updatedAt: 300, groups: [{ title: 'Mail', tabs: [t(G1), t(G3)] }] });
    const { result } = mergeProject(base, local, remote);
    expect(mergeProject(base, remote, local).result).toEqual(result);
    expect(urls(result).sort()).toEqual([G1, G2, G3]);
  });

  it('control (passes today): the bookmark format round-trips URLs with a fragment', () => {
    expect(fromFolder(toFolder(mail()))).toMatchObject({ groups: [{ title: 'Mail', tabs: [t(G1), t(G2)] }] });
  });
});
