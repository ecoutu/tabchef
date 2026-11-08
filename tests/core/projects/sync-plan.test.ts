// M4 T14: Project ↔ SyncedProject mapping (M4-R22) and the pure sync plan (M4-R19, M4-R23).
import { describe, expect, it } from 'vitest';
import type { SyncedProject } from '../../../src/core/projects/bookmark-format';
import { applySynced, planSync, toSynced } from '../../../src/core/projects/sync-plan';
import { projectGroupTitle } from '../../../src/core/projects/resolve';
import type { Project, ProjectDef } from '../../../src/core/projects/types';

const A = 'https://a.test/1';
const B = 'https://b.test/2';
const C = 'https://c.test/3';
const project = (over: Partial<Project> = {}): Project => ({
  id: 'manual-project:taxes', recipeId: 'manual-project', key: 'taxes', name: 'Taxes', keep: true, createdAt: 10, updatedAt: 100,
  manual: [], excluded: [], linked: [],
  saved: { tabs: [{ url: A, title: 'A', group: 'G' }, { url: B, title: 'B' }], at: 100 },
  ...over,
});
const synced = (over: Partial<SyncedProject> = {}): SyncedProject => ({
  id: 'manual-project:taxes', recipeId: 'manual-project', key: 'taxes', name: 'Taxes', updatedAt: 100,
  groups: [{ title: 'G', tabs: [{ url: A, title: 'A' }] }, { title: '', tabs: [{ url: B, title: 'B' }] }],
  ...over,
});
const ID = 'manual-project:taxes';
const plan = (o: { stored?: Project[]; open?: string[]; remote?: SyncedProject[]; base?: SyncedProject[] }) => planSync({
  stored: o.stored ?? [], open: new Set(o.open ?? []),
  remote: new Map((o.remote ?? []).map((p) => [p.id, p])), base: Object.fromEntries((o.base ?? []).map((p) => [p.id, p])),
});

describe('toSynced', () => {
  it('groups by SavedTab.group in first-appearance order, ungrouped last; pinned and tombstone fields stay local', () => {
    const p = project({
      color: 'blue', archivedAt: 50, closedAt: 60, closedIds: ['x'], syncExtra: { tint: 1 },
      saved: { at: 1, tabs: [{ url: A, title: 'A', pinned: true }, { url: B, title: 'B', group: 'Two' }, { url: C, title: 'C', group: 'One' }, { url: 'https://d.test/', title: 'D', group: 'Two' }] },
    });
    expect(toSynced(p)).toEqual({
      id: ID, recipeId: 'manual-project', key: 'taxes', name: 'Taxes', color: 'blue', updatedAt: 100, archivedAt: 50, extra: { tint: 1 },
      groups: [
        { title: 'Two', tabs: [{ url: B, title: 'B' }, { url: 'https://d.test/', title: 'D' }] },
        { title: 'One', tabs: [{ url: C, title: 'C' }] },
        { title: '', tabs: [{ url: A, title: 'A' }] },
      ],
    });
  });

  it('a kept project with no saved list syncs with no groups', () => {
    expect(toSynced(project({ saved: undefined, name: undefined })).groups).toEqual([]);
    expect(toSynced(project({ saved: undefined, name: undefined }))).not.toHaveProperty('name');
  });
});

describe('applySynced', () => {
  it('a project first seen from remote is created kept, empty, with createdAt = updatedAt = the remote updatedAt', () => {
    expect(applySynced(undefined, synced({ updatedAt: 500, extra: { tint: 1 } }))).toEqual({
      id: ID, recipeId: 'manual-project', key: 'taxes', name: 'Taxes', keep: true, createdAt: 500, updatedAt: 500,
      manual: [], excluded: [], linked: [], syncExtra: { tint: 1 },
      saved: { tabs: [{ url: A, title: 'A', group: 'G' }, { url: B, title: 'B' }], at: 500 },
    });
  });

  it('onto a local project: keeps the local pinned flag by URL, local-only fields and the frozen flag', () => {
    const local = project({
      color: 'red', archivedAt: 5, closedAt: 7, closedIds: ['rc'], summary: 's', manual: [{ url: A, windowId: 1, tabId: 3 }], syncExtra: { old: 1 },
      saved: { tabs: [{ url: A, title: 'A', pinned: true }], at: 1, closed: true },
    });
    const p = applySynced(local, synced({ name: undefined, updatedAt: 700 }));
    expect(p).toMatchObject({ closedAt: 7, closedIds: ['rc'], summary: 's', manual: [{ url: A, windowId: 1, tabId: 3 }], createdAt: 10, updatedAt: 700, keep: true });
    expect(p).not.toHaveProperty('name');
    expect(p).not.toHaveProperty('color');
    expect(p).not.toHaveProperty('archivedAt');
    expect(p).not.toHaveProperty('syncExtra');
    expect(p.saved).toEqual({ tabs: [{ url: A, title: 'A', group: 'G', pinned: true }, { url: B, title: 'B' }], at: 700, closed: true });
    expect(local.saved?.tabs).toHaveLength(1); // not mutated
  });

  it('no groups onto a project without a saved list leaves it without one', () => {
    const local = project();
    delete local.saved;
    expect(applySynced(local, synced({ groups: [] }))).not.toHaveProperty('saved');
  });
});

describe('planSync', () => {
  it('a new local kept project is written and becomes the base; an unkept one is not synced', () => {
    const other = project({ id: 'jira:X-1', recipeId: 'jira', key: 'X-1', keep: undefined });
    const r = plan({ stored: [project(), other] });
    expect([...r.write.keys()]).toEqual([ID]);
    expect(r.write.get(ID)).toMatchObject({ title: 'Taxes' });
    expect(r.base[ID]).toEqual(toSynced(project()));
    expect(r).toMatchObject({ put: [], remove: [], conflicts: [], ignored: [], merged: 1 });
  });

  it('a new remote project is stored here; nothing is written', () => {
    const r = plan({ remote: [synced()] });
    expect(r.put).toEqual([applySynced(undefined, synced())]);
    expect(r.write.size).toBe(0);
    expect(r.base[ID]).toEqual(synced());
  });

  it('unchanged on both sides: nothing to do; an order-only difference is not a change either', () => {
    expect(plan({ stored: [project()], remote: [synced()], base: [synced()] })).toMatchObject({ put: [], remove: [], write: new Map() });
    // This device's tab bar has C, A where the folder has A, C (another device's order), and a later updatedAt.
    const local = project({ updatedAt: 200, saved: { at: 200, tabs: [{ url: C, title: 'C', group: 'G' }, { url: A, title: 'A', group: 'G' }, { url: B, title: 'B' }] } });
    const remote = synced({ groups: [{ title: 'G', tabs: [{ url: A, title: 'A' }, { url: C, title: 'C' }] }, { title: '', tabs: [{ url: B, title: 'B' }] }] });
    const r = plan({ stored: [local], remote: [remote], base: [remote] });
    expect(r).toMatchObject({ put: [], remove: [], write: new Map() });
  });

  it('a remote edit is applied here, a local edit is written', () => {
    const remote = synced({ name: 'Renamed', updatedAt: 300 });
    let r = plan({ stored: [project()], remote: [remote], base: [synced()] });
    expect(r.put).toEqual([expect.objectContaining({ name: 'Renamed', updatedAt: 300 })]);
    expect(r.write.size).toBe(0);
    r = plan({ stored: [project({ name: 'Mine', updatedAt: 300 })], remote: [synced()], base: [synced()] });
    expect(r.put).toEqual([]);
    expect(r.write.get(ID)).toMatchObject({ title: 'Mine' });
    expect(r.base[ID]?.name).toBe('Mine');
  });

  it('M4-R19: deleted here (base present) → its folder goes, and the base entry with it', () => {
    const r = plan({ remote: [synced()], base: [synced()] });
    expect(r.write.get(ID)).toBeNull();
    expect(r.base).toEqual({});
  });

  it('M4-R23: deleted remotely and unchanged here → removed; with open member tabs only un-kept', () => {
    let r = plan({ stored: [project()], base: [synced()] });
    expect(r.remove).toEqual([ID]);
    expect(r.base).toEqual({});
    r = plan({ stored: [project()], base: [synced()], open: [ID] });
    expect(r.remove).toEqual([]);
    expect(r.put).toHaveLength(1);
    expect(r.put[0]).not.toHaveProperty('keep');
    expect(r.put[0]?.saved).toEqual(project().saved);
    expect(r.notes).toEqual(['Project “Taxes” was removed from the Tabchef bookmark folder. Its tabs are open here, so it stays until you close them, but it is no longer kept.']);
    expect(plan({ stored: [project()], base: [synced()] }).notes).toEqual([]); // removed here: nothing to tell
  });

  it('rootMissing: no folder at all removes nothing here; kept projects are written again', () => {
    const r = planSync({ stored: [project()], open: new Set(), remote: new Map(), base: { [ID]: synced() }, rootMissing: true });
    expect(r).toMatchObject({ put: [], remove: [] });
    expect(r.write.get(ID)).toMatchObject({ title: 'Taxes' });
    expect(r.base[ID]).toEqual(toSynced(project()));
  });

  it('C1: a project reopened (updatedAt bumped, nothing synced changed) and then deleted here stays deleted', () => {
    const first = plan({ stored: [project()] });
    expect(first.write.has(ID)).toBe(true);
    const remote = [synced()]; // the folder it wrote
    const reopened = plan({ stored: [project({ updatedAt: 200, saved: { ...project().saved!, at: 200 } })], remote, base: Object.values(first.base) });
    expect(reopened.write.size).toBe(0);
    const r = plan({ stored: [], remote, base: Object.values(reopened.base) });
    expect(r.conflicts).toEqual([]);
    expect(r.put).toEqual([]);
    expect(r.write.get(ID)).toBeNull();
    expect(r.base).toEqual({});
  });

  it('C1: a remote delete still applies when the copy here differs from the base only in tab order and updatedAt', () => {
    const reordered = project({ updatedAt: 300, saved: { tabs: [{ url: B, title: 'B' }, { url: A, title: 'A', group: 'G' }], at: 300 } });
    const r = plan({ stored: [reordered], base: [synced()] });
    expect(r.conflicts).toEqual([]);
    expect(r.remove).toEqual([ID]);
    expect(r.write.size).toBe(0);
  });

  it('I2: unreadable folders this sync: a kept project missing from them is held: no write, no delete, base unchanged, reported', () => {
    const base = { [ID]: synced({ name: 'Old' }) };
    const r = planSync({ stored: [project()], open: new Set(), remote: new Map(), base, unreadable: true });
    expect(r).toMatchObject({ put: [], remove: [], write: new Map(), base, merged: 0, conflicts: [] });
    expect(r.ignored).toEqual([expect.stringContaining(ID)]);
  });

  it('M4-R35: unreadable folders: a new kept project (no base) still gets its folder written; a based one missing from them is held', () => {
    const NEW = 'manual-project:trip';
    const fresh = project({ id: NEW, key: 'trip', name: 'Trip' });
    const r = planSync({ stored: [project(), fresh], open: new Set(), remote: new Map(), base: { [ID]: synced() }, unreadable: true });
    expect(r.write.get(NEW)).toMatchObject({ title: 'Trip' });
    expect(r.write.has(ID)).toBe(false);
    expect(r).toMatchObject({ put: [], remove: [], merged: 1, base: { [ID]: synced(), [NEW]: toSynced(fresh) } });
    expect(r.ignored).toEqual([expect.stringContaining(ID)]);
  });

  it('I2: unreadable folders: a project deleted here and missing from them keeps its base, so its folder goes once it can be read', () => {
    const held = planSync({ stored: [], open: new Set(), remote: new Map(), base: { [ID]: synced() }, unreadable: true });
    expect(held).toMatchObject({ put: [], remove: [], write: new Map(), base: { [ID]: synced() } });
    const r = plan({ stored: [], remote: [synced()], base: Object.values(held.base) });
    expect(r.write.get(ID)).toBeNull();
    expect(r).toMatchObject({ conflicts: [], base: {} });
  });

  it('I2: once the folders can be read again, a delete on another device held meanwhile applies with no conflict', () => {
    const held = planSync({ stored: [project()], open: new Set(), remote: new Map(), base: { [ID]: synced() }, unreadable: true });
    const r = plan({ stored: [project()], base: Object.values(held.base) });
    expect(r).toMatchObject({ remove: [ID], put: [], write: new Map(), conflicts: [], base: {} });
  });

  it('rootMissing wins over unreadable: the kept project is written again', () => {
    const r = planSync({ stored: [project()], open: new Set(), remote: new Map(), base: { [ID]: synced() }, rootMissing: true, unreadable: true });
    expect(r.write.get(ID)).toMatchObject({ title: 'Taxes' });
  });

  it('a project in `unsynced` (its saved list was unreadable) is left out: no put, no write, base kept, reported', () => {
    const r = planSync({ stored: [project({ saved: undefined })], open: new Set(), remote: new Map([[ID, synced()]]), base: { [ID]: synced() }, unsynced: new Set([ID]) });
    expect(r).toMatchObject({ put: [], remove: [], write: new Map(), base: { [ID]: synced() }, merged: 0 });
    expect(r.ignored).toEqual([expect.stringContaining(ID)]);
  });

  it('deleted remotely but edited here: kept, rewritten, reported', () => {
    const r = plan({ stored: [project({ name: 'Edited', updatedAt: 300 })], base: [synced()] });
    expect(r.remove).toEqual([]);
    expect(r.write.get(ID)).toMatchObject({ title: 'Edited' });
    expect(r.conflicts).toEqual([expect.stringContaining(ID)]);
  });

  it('M4-R23: un-kept here → its folder goes and its base entry is dropped; nothing local changes', () => {
    const r = plan({ stored: [project({ keep: undefined })], remote: [synced()], base: [synced()] });
    expect(r.write.get(ID)).toBeNull();
    expect(r).toMatchObject({ put: [], remove: [], base: {} });
  });

  it('a project whose metadata would exceed 8 KB is skipped and reported; the others sync', () => {
    const big = project({ id: 'manual-project:big', key: 'big', syncExtra: { blob: 'x'.repeat(9000) } });
    let r = plan({ stored: [big, project()] });
    expect(r.ignored).toEqual([expect.stringContaining('manual-project:big')]);
    expect([...r.write.keys()]).toEqual([ID]);
    expect(r.base).not.toHaveProperty('manual-project:big');
    expect(r.put).toEqual([]);
    // Grown too big after it synced: its folder and base entry stay as they were.
    const was = toSynced({ ...big, syncExtra: { blob: 'small' } });
    r = plan({ stored: [big], remote: [was], base: [was] });
    expect(r).toMatchObject({ put: [], remove: [], write: new Map(), base: { 'manual-project:big': was } });
  });

  it('tombstoned kept projects sync their saved list, never the tombstone', () => {
    const r = plan({ stored: [project({ closedAt: 5, closedIds: ['rc'] })] });
    expect(r.base[ID]).not.toHaveProperty('closedAt');
    expect(r.write.has(ID)).toBe(true);
  });
});

// M4-R41: planSync tells saved tabs apart by exact URL, like the merge.
describe('M4-R41: planSync with saved tabs that differ only after #', () => {
  const G1 = 'https://mail.google.com/mail/u/0/#inbox/AAA';
  const G2 = 'https://mail.google.com/mail/u/0/#inbox/BBB';
  const mail = (over: Partial<Project> = {}) => project({
    saved: { tabs: [{ url: G1, title: '1', group: 'Mail' }, { url: G2, title: '2', group: 'Mail' }], at: 100 }, ...over,
  });
  const tabUrls = (p: SyncedProject | undefined) => (p?.groups ?? []).flatMap((g) => g.tabs.map((x) => x.url));

  it('the first sync writes both threads and keeps both in the base', () => {
    const r = plan({ stored: [mail()] });
    const folder = r.write.get(ID)!;
    const written = folder.children!.flatMap((c) => c.children ?? [c]).map((c) => c.url!).filter((u) => !u.startsWith('https://tabchef.invalid/'));
    expect(written).toEqual([G1, G2]);
    expect(tabUrls(r.base[ID])).toEqual([G1, G2]);
  });

  it('a later rename on the other device keeps the second thread in the local saved list', () => {
    const first = plan({ stored: [mail()] });
    const renamed: SyncedProject = { ...first.base[ID]!, name: 'Renamed', updatedAt: 200 };
    const r = plan({ stored: [mail()], remote: [renamed], base: [first.base[ID]!] });
    const put = r.put.find((p) => p.id === ID);
    expect(put?.name).toBe('Renamed');
    expect(put?.saved?.tabs.map((x) => x.url)).toEqual([G1, G2]);
  });

  it('sibling: a remote delete does not silently remove a project whose local change since the base is a new thread', () => {
    const base = synced({ groups: [{ title: 'Mail', tabs: [{ url: G1, title: '1' }] }] });
    const r = plan({ stored: [mail()], base: [base] });
    expect(r.remove).toEqual([]);
    expect(r.conflicts).toEqual([`project ${ID}: deleted on one device but edited on the other; kept the edit`]);
  });

  it('sibling: applySynced keeps the local pinned flag on the pinned thread only', () => {
    const local = project({ saved: { tabs: [{ url: G1, title: '1', pinned: true }, { url: G2, title: '2' }], at: 1 } });
    const p = applySynced(local, synced({ groups: [{ title: '', tabs: [{ url: G1, title: '1' }, { url: G2, title: '2' }] }] }));
    expect(p.saved!.tabs).toEqual([{ url: G1, title: '1', pinned: true }, { url: G2, title: '2' }]);
  });
});

// M4-R42: a tab opened from the "Tabchef project data" bookmark that joins a kept project is no saved tab to sync.
describe('M4-R42: the metadata bookmark never becomes a synced saved tab', () => {
  it('toSynced skips a saved tab whose URL is a Tabchef metadata URL', () => {
    const meta = 'https://tabchef.invalid/project#eyJpZCI6IngifQ';
    const p = project({ saved: { tabs: [{ url: A, title: 'A', group: 'G' }, { url: meta, title: 'data' }, { url: B, title: 'B' }], at: 100 } });
    expect(toSynced(p)).toEqual(synced());
  });
});

// A saved tab carries its Chrome group's title, and a project's tabs sit in the project's own group: that group is the
// project folder itself, never a subfolder of it (M4-R22). 1.6.0 wrote it as one (Media / Media / tabs).
describe("a project's own group syncs as its ungrouped tabs", () => {
  const media = (over: Partial<Project> = {}): Project => project({
    id: 'manual-project:media', key: 'media', name: 'Media',
    saved: { tabs: [{ url: A, title: 'A', group: 'Media' }, { url: B, title: 'B', group: 'Media' }], at: 100 },
    ...over,
  });
  const flat: SyncedProject = { id: 'manual-project:media', recipeId: 'manual-project', key: 'media', name: 'Media', updatedAt: 100,
    groups: [{ title: '', tabs: [{ url: A, title: 'A' }, { url: B, title: 'B' }] }] };

  it("writes a Manual project's tabs in its own group loose in the project folder", () => {
    expect(toSynced(media())).toEqual(flat);
    const r = plan({ stored: [media()] });
    const folder = r.write.get('manual-project:media')!;
    expect(folder.title).toBe('Media');
    expect(folder.children!.slice(1)).toEqual([{ title: 'A', url: A }, { title: 'B', url: B }]);
    expect(r.base['manual-project:media']).toEqual(flat);
  });

  it('a Manual project with no name: its own group is its key', () => {
    const p = media({ name: undefined, saved: { tabs: [{ url: A, title: 'A', group: 'media' }], at: 100 } });
    expect(toSynced(p).groups).toEqual([{ title: '', tabs: [{ url: A, title: 'A' }] }]);
  });

  it('rewrites a 1.6.0 folder (the project group nested in its own folder) flat once, then leaves it', () => {
    const nested: SyncedProject = { ...flat, groups: [{ title: 'Media', tabs: [{ url: A, title: 'A' }, { url: B, title: 'B' }] }] };
    const first = plan({ stored: [media()], remote: [nested], base: [nested] });
    expect(first.write.get('manual-project:media')!.children!.slice(1)).toEqual([{ title: 'A', url: A }, { title: 'B', url: B }]);
    expect(first.base['manual-project:media']).toEqual(flat);
    // The local copy is unchanged: only the folder's shape moves.
    expect(first.put).toEqual([]);
    expect(first.remove).toEqual([]);
    // Read back as written: nothing more to write.
    const second = plan({ stored: [media()], remote: [flat], base: [first.base['manual-project:media']!] });
    expect(second).toMatchObject({ put: [], remove: [], merged: 0 });
    expect(second.write.size).toBe(0);
  });

  it('a tab from another group keeps its own subfolder', () => {
    const p = media({ saved: { tabs: [{ url: A, title: 'A', group: 'Media' }, { url: B, title: 'B', group: 'Music' }, { url: C, title: 'C' }], at: 100 } });
    expect(toSynced(p).groups).toEqual([
      { title: 'Music', tabs: [{ url: B, title: 'B' }] },
      { title: '', tabs: [{ url: A, title: 'A' }, { url: C, title: 'C' }] },
    ]);
    const folder = plan({ stored: [p] }).write.get('manual-project:media')!;
    expect(folder.children!.slice(1)).toEqual([{ title: 'Music', children: [{ title: 'B', url: B }] }, { title: 'A', url: A }, { title: 'C', url: C }]);
  });

  it("a rule project: its own group is its recipe's title (projectGroupTitle)", () => {
    const def: ProjectDef = { recipeId: 'jira', key: '{key}', title: '{key} · {summary}', color: 'blue', container: 'group', join: ['rules', 'manual'],
      placement: ['existing', 'current'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload', start: 'auto' };
    const own = 'ABC-1 · Login fails';
    const p = project({ id: 'jira:ABC-1', recipeId: 'jira', key: 'ABC-1', name: undefined, summary: 'Login fails',
      saved: { tabs: [{ url: A, title: 'A', group: own }, { url: B, title: 'B', group: 'ABC-1' }], at: 100 } });
    const ownTitle = (q: Project) => projectGroupTitle(def, q);
    expect(toSynced(p, ownTitle(p)).groups).toEqual([{ title: 'ABC-1', tabs: [{ url: B, title: 'B' }] }, { title: '', tabs: [{ url: A, title: 'A' }] }]);
    const r = planSync({ stored: [p], open: new Set(), remote: new Map(), base: {}, ownTitle });
    expect(r.write.get('jira:ABC-1')!.children!.slice(1)).toEqual([{ title: 'ABC-1', children: [{ title: 'B', url: B }] }, { title: 'A', url: A }]);
    const nested: SyncedProject = { ...toSynced(p, ownTitle(p)), groups: [{ title: own, tabs: [{ url: A, title: 'A' }] }, { title: 'ABC-1', tabs: [{ url: B, title: 'B' }] }] };
    const again = planSync({ stored: [p], open: new Set(), remote: new Map([[p.id, nested]]), base: { [p.id]: nested }, ownTitle });
    expect(again.write.has(p.id)).toBe(true);
    expect(again.put).toEqual([]);
    const stable = planSync({ stored: [p], open: new Set(), remote: new Map([[p.id, again.base[p.id]!]]), base: again.base, ownTitle });
    expect(stable.write.size).toBe(0);
  });
});
