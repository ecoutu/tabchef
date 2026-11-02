import { describe, expect, it, vi } from 'vitest';
import { TAB_AGES_KEY, TabAges } from '../../src/engine/tab-ages';
import type { Snapshot, TabSnap } from '../../src/core/types';

function memSession(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: vi.fn(async (k: string) => data[k]),
    set: vi.fn(async (k: string, v: unknown) => { data[k] = structuredClone(v); }),
  };
}
const tab = (id: number, over: Partial<TabSnap> = {}): TabSnap => ({
  id, windowId: 1, index: id, url: `https://a.test/${id}`, title: '', pinned: false, groupId: -1, incognito: false,
  discarded: false, active: false, audible: false, ...over,
});
const snap = (...ids: number[]): Snapshot => ({ tabs: ids.map((id) => tab(id)), groups: [], windows: [{ id: 1, type: 'normal', focused: true }] });
const created = async (ages: TabAges, s: Snapshot) => (await ages.annotate(s)).tabs.map((t) => [t.id, t.created]);

function setup(o: { session?: ReturnType<typeof memSession>; grace?: (at: number) => boolean; graceReady?: Promise<unknown> } = {}) {
  let t = 1000;
  const session = o.session ?? memSession();
  const ages = new TabAges({ session, now: () => t, inStartupGrace: o.grace ?? (() => false), graceReady: o.graceReady });
  return { ages, session, advance: (ms: number) => { t += ms; }, at: () => t };
}

describe('TabAges', () => {
  it('onCreated records an exact creation time', async () => {
    const { ages } = setup();
    ages.onCreated({ id: 1 });
    expect(await created(ages, snap(1))).toEqual([[1, { at: 1000, exact: true }]]);
  });

  it.each([
    ['discarded', { id: 1, discarded: true }],
    ['unloaded', { id: 1, status: 'unloaded' }],
  ])('a %s (restored) tab is a lower bound', async (_label, info) => {
    const { ages } = setup();
    ages.onCreated(info);
    expect(await created(ages, snap(1))).toEqual([[1, { at: 1000, exact: false }]]);
  });

  it('a tab created in the startup grace is a lower bound; the grace is checked for its creation time', async () => {
    const grace = vi.fn((at: number) => at < 2000);
    const { ages, advance } = setup({ grace });
    ages.onCreated({ id: 1 });
    advance(5000);
    ages.onCreated({ id: 2 });
    expect(await created(ages, snap(1, 2))).toEqual([[1, { at: 1000, exact: false }], [2, { at: 6000, exact: true }]]);
    expect(grace.mock.calls.map((c) => c[0])).toEqual([1000, 6000]);
  });

  it('the grace is read only once graceReady settles (the session marker may still be loading)', async () => {
    let open = false;
    let release!: () => void;
    const graceReady = new Promise<void>((r) => { release = r; });
    const { ages } = setup({ grace: () => open, graceReady });
    ages.onCreated({ id: 1 });
    open = true; // the marker read finds a browser start
    release();
    expect(await created(ages, snap(1))).toEqual([[1, { at: 1000, exact: false }]]);
  });

  it('a tab with no entry is first seen as a lower bound from now, and recorded', async () => {
    const { ages, advance, session } = setup();
    expect(await created(ages, snap(4))).toEqual([[4, { at: 1000, exact: false }]]);
    advance(60_000);
    expect(await created(ages, snap(4))).toEqual([[4, { at: 1000, exact: false }]]);
    expect(session.data[TAB_AGES_KEY]).toEqual([[4, 1000, false]]);
  });

  it('onReplaced moves the entry to the new tab id', async () => {
    const { ages, advance } = setup();
    ages.onCreated({ id: 1 });
    advance(500);
    ages.onReplaced(2, 1);
    expect(await created(ages, snap(2))).toEqual([[2, { at: 1000, exact: true }]]);
  });

  it('onRemoved deletes the entry', async () => {
    const { ages, session } = setup();
    ages.onCreated({ id: 1 });
    ages.onCreated({ id: 2 });
    await ages.annotate(snap(1, 2));
    ages.onRemoved(1);
    await ages.annotate(snap(2));
    expect(session.data[TAB_AGES_KEY]).toEqual([[2, 1000, true]]);
  });

  it('a worker restart keeps exact times (a new instance over the same session)', async () => {
    const first = setup();
    first.ages.onCreated({ id: 1 });
    await first.ages.annotate(snap(1));
    const second = setup({ session: first.session });
    second.advance(3_600_000);
    expect(await created(second.ages, snap(1))).toEqual([[1, { at: 1000, exact: true }]]);
  });

  it('a browser restart (empty session) makes every open tab a lower bound', async () => {
    const { ages } = setup({ session: memSession() });
    expect(await created(ages, snap(7, 8))).toEqual([[7, { at: 1000, exact: false }], [8, { at: 1000, exact: false }]]);
  });

  it('ignores malformed stored entries', async () => {
    const session = memSession({ [TAB_AGES_KEY]: [[1, 5, true], ['x', 1, true], [2, 'y', false], [3, 7, 'no'], 'z'] });
    const { ages } = setup({ session });
    expect(await created(ages, snap(1, 2))).toEqual([[1, { at: 5, exact: true }], [2, { at: 1000, exact: false }]]);
  });

  it('prunes stored ids that are not in the snapshot', async () => {
    const session = memSession({ [TAB_AGES_KEY]: [[1, 5, true], [9, 6, true]] });
    const { ages } = setup({ session });
    await ages.annotate(snap(1));
    expect(session.data[TAB_AGES_KEY]).toEqual([[1, 5, true]]);
  });

  it('keeps a tab created by an event that the snapshot missed (taken before onCreated)', async () => {
    const { ages } = setup();
    ages.onCreated({ id: 3 });
    await ages.annotate(snap());
    expect(await created(ages, snap(3))).toEqual([[3, { at: 1000, exact: true }]]);
  });

  it('persists only on change', async () => {
    const session = memSession({ [TAB_AGES_KEY]: [[1, 5, true]] });
    const { ages } = setup({ session });
    await ages.annotate(snap(1));
    await ages.annotate(snap(1));
    expect(session.set).not.toHaveBeenCalled();
  });

  it('a session that fails to load or save never breaks annotate', async () => {
    const session = { get: vi.fn(async () => { throw new Error('x'); }), set: vi.fn(async () => { throw new Error('y'); }) };
    const ages = new TabAges({ session, now: () => 1, inStartupGrace: () => false });
    expect((await ages.annotate(snap(1))).tabs[0]!.created).toEqual({ at: 1, exact: false });
  });

  it('does not mutate the input snapshot', async () => {
    const { ages } = setup();
    const s = snap(1);
    await ages.annotate(s);
    expect(s.tabs[0]!.created).toBeUndefined();
  });
});
