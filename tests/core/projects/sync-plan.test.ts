// M4 T14: Project ↔ SyncedProject mapping (M4-R22) and the pure sync plan (M4-R19, M4-R23).
import { describe, expect, it } from 'vitest';
import type { SyncedProject } from '../../../src/core/projects/bookmark-format';
import { applySynced, planSync, toSynced } from '../../../src/core/projects/sync-plan';
import type { Project } from '../../../src/core/projects/types';

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

  it('onto a local project: keeps the local pinned flag by normalized URL, local-only fields and the frozen flag', () => {
    const local = project({
      color: 'red', archivedAt: 5, closedAt: 7, closedIds: ['rc'], summary: 's', manual: [{ url: A, windowId: 1, tabId: 3 }], syncExtra: { old: 1 },
      saved: { tabs: [{ url: `${A}#frag`, title: 'A', pinned: true }], at: 1, closed: true },
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
  });

  it('rootMissing: no folder at all removes nothing here; kept projects are written again', () => {
    const r = planSync({ stored: [project()], open: new Set(), remote: new Map(), base: { [ID]: synced() }, rootMissing: true });
    expect(r).toMatchObject({ put: [], remove: [] });
    expect(r.write.get(ID)).toMatchObject({ title: 'Taxes' });
    expect(r.base[ID]).toEqual(toSynced(project()));
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
