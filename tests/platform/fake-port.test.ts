import { describe, it, expect } from 'vitest';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { TabSnap } from '../../src/core/types';

const tab = (id: number, windowId = 1, over: Partial<TabSnap> = {}): Omit<TabSnap, 'index' | 'groupId'> & Partial<TabSnap> => ({
  id, windowId, url: `https://x/${id}`, title: `t${id}`, pinned: false, incognito: false,
  discarded: false, active: false, audible: false, ...over,
});
const mk = (ids: number[], windowId = 1) => {
  const f = new FakeBrowserPort();
  f.addWindow(windowId);
  for (const id of ids) f.addTab(tab(id, windowId));
  return f;
};
const order = (f: FakeBrowserPort, w = 1) => {
  f.assertInvariants();
  return f.state.tabs.filter((t) => t.windowId === w).sort((a, b) => a.index - b.index).map((t) => t.id);
};

describe('FakeBrowserPort', () => {
  it('addTab assigns contiguous indices and groupId -1', () => {
    const f = mk([10, 11, 12]);
    expect(f.state.tabs.map((t) => [t.id, t.index, t.groupId])).toEqual([[10, 0, -1], [11, 1, -1], [12, 2, -1]]);
  });

  it('group assigns new groupId, sets groupId and makes tabs contiguous', async () => {
    const f = mk([1, 2, 3, 4]);
    const gid = await f.group([1, 3], { windowId: 1 });
    expect(f.state.tabs.filter((t) => t.groupId === gid).map((t) => t.id).sort()).toEqual([1, 3]);
    expect(order(f)).toEqual([1, 3, 2, 4]);
    expect(f.state.groups.map((g) => g.id)).toEqual([gid]);
    const gid2 = await f.group([4], { windowId: 1 });
    expect(gid2).not.toBe(gid);
  });

  it('group into existing group places tabs after its tabs', async () => {
    const f = mk([1, 2, 3, 4]);
    const gid = await f.group([1, 2], { windowId: 1 });
    expect(await f.group([4], { groupId: gid, windowId: 1 })).toBe(gid);
    expect(order(f)).toEqual([1, 2, 4, 3]);
    expect(f.state.tabs.map((t) => t.index).sort()).toEqual([0, 1, 2, 3]);
  });

  it('ungroup sets groupId -1', async () => {
    const f = mk([1, 2]);
    await f.group([1, 2], { windowId: 1 });
    await f.ungroup([1]);
    expect(f.state.tabs.find((t) => t.id === 1)!.groupId).toBe(-1);
  });

  it('moveGroup reorders tab indices', async () => {
    const f = mk([1, 2, 3, 4, 5]);
    const g = await f.group([2, 3], { windowId: 1 });
    await f.moveGroup(g, 3);
    expect(order(f)).toEqual([1, 4, 5, 2, 3]);
    await f.moveGroup(g, 0);
    expect(order(f)).toEqual([2, 3, 1, 4, 5]);
    await f.moveGroup(g, -1);
    expect(order(f)).toEqual([1, 4, 5, 2, 3]);
  });

  it('moveTabs moves between windows and reindexes both', async () => {
    const f = mk([1, 2, 3]);
    f.addWindow(2);
    f.addTab(tab(9, 2));
    await f.moveTabs([2], 2, 0);
    expect(order(f, 1)).toEqual([1, 3]);
    expect(order(f, 2)).toEqual([2, 9]);
    await f.moveTabs([1], 2, -1);
    expect(order(f, 2)).toEqual([2, 9, 1]);
    order(f, 1);
    expect(f.state.tabs.find((t) => t.id === 1)!.windowId).toBe(2);
    expect(f.state.tabs.find((t) => t.id === 3)!.index).toBe(0);
  });

  it('updateGroup, closeTab, createTab', async () => {
    const f = mk([1, 2]);
    const g = await f.group([1], { windowId: 1 });
    await f.updateGroup(g, { title: 'A', color: 'red', collapsed: true });
    expect(f.state.groups[0]).toMatchObject({ title: 'A', color: 'red', collapsed: true });
    await f.closeTab(1);
    expect(order(f)).toEqual([2]);
    expect(f.state.tabs[0]!.index).toBe(0);
    const id = await f.createTab({ url: 'https://n', windowId: 1 });
    expect(order(f)).toEqual([2, id]);
    const id2 = await f.createTab({ url: 'https://m', windowId: 1, index: 0 });
    expect(order(f)).toEqual([id2, 2, id]);
  });

  it('focusTab, setBadge, hasPermission', async () => {
    const f = mk([1, 2]);
    await f.focusTab(2, 1, 'https://new');
    expect(f.state.tabs.find((t) => t.id === 2)).toMatchObject({ active: true, url: 'https://new' });
    expect(f.state.tabs.find((t) => t.id === 1)!.active).toBe(false);
    await f.setBadge('3');
    expect(f.badge).toBe('3');
    expect(await f.hasPermission({ permissions: ['x'] })).toBe(false);
    f.granted.add('x');
    expect(await f.hasPermission({ permissions: ['x'] })).toBe(true);
  });

  it('records calls and failNext rejects then succeeds', async () => {
    const f = mk([1]);
    f.failNext('closeTab', 'nope', 2);
    await expect(f.closeTab(1)).rejects.toThrow('nope');
    await expect(f.closeTab(1)).rejects.toThrow('nope');
    await f.closeTab(1);
    expect(f.state.tabs).toHaveLength(0);
    expect(f.calls.filter((c) => c.method === 'closeTab')).toHaveLength(3);
    expect(f.calls[0]).toEqual({ method: 'closeTab', args: [1] });
  });

  it('snapshot returns a copy', async () => {
    const f = mk([1]);
    const s = await f.snapshot();
    s.tabs[0]!.url = 'mutated';
    expect(f.state.tabs[0]!.url).not.toBe('mutated');
  });

  it('moveTabs ungroups moved tabs; group({groupId}) regroups them contiguously', async () => {
    const f = mk([1, 2, 3]);
    f.addWindow(2);
    f.addTab(tab(8, 2));
    f.addTab(tab(9, 2));
    const g = await f.group([8, 9], { windowId: 2 });
    await f.group([1, 2], { windowId: 1 });
    await f.moveTabs([3], 2, 1); // snapped out of the middle of the group
    expect(f.state.tabs.find((t) => t.id === 3)!.groupId).toBe(-1);
    expect(order(f, 2)).toEqual([8, 9, 3]);
    await f.moveTabs([1], 2, 0);
    expect(f.state.tabs.find((t) => t.id === 1)!.groupId).toBe(-1);
    await f.group([1], { groupId: g, windowId: 2 });
    expect(order(f, 2)).toEqual([8, 9, 1, 3]);
    expect(f.state.tabs.filter((t) => t.groupId === g).map((t) => t.id).sort()).toEqual([1, 8, 9]);
  });

  it('group rejects pinned tabs', async () => {
    const f = mk([1, 2]);
    f.addTab(tab(3, 1, { pinned: true }));
    await expect(f.group([3, 1], { windowId: 1 })).rejects.toThrow('Cannot group pinned tabs');
    f.assertInvariants();
  });

  it('keeps pinned tabs left when moving/creating/moving groups', async () => {
    const f = mk([1, 2, 3]);
    f.addTab(tab(4, 1, { pinned: true }));
    f.addTab(tab(5, 1, { pinned: true }));
    expect(order(f)).toEqual([4, 5, 1, 2, 3]);
    const g = await f.group([2, 3], { windowId: 1 });
    await f.moveGroup(g, 0);
    expect(order(f)).toEqual([4, 5, 2, 3, 1]);
    const n = await f.createTab({ url: 'https://n', windowId: 1, index: 0 });
    expect(order(f)).toEqual([4, 5, n, 2, 3, 1]);
    f.addWindow(2);
    f.addTab(tab(9, 2));
    await f.moveTabs([1], 2, 0);
    await f.moveTabs([9], 1, 0);
    expect(order(f)).toEqual([4, 5, 9, n, 2, 3]);
  });

  it('snaps insertion indices inside a group block to just after it', async () => {
    const f = mk([1, 2, 3, 4]);
    const g = await f.group([1, 2], { windowId: 1 });
    const n = await f.createTab({ url: 'https://n', windowId: 1, index: 1 });
    expect(order(f)).toEqual([1, 2, n, 3, 4]);
    const g2 = await f.group([3, 4], { windowId: 1 });
    await f.moveGroup(g2, 1);
    expect(order(f)).toEqual([1, 2, 3, 4, n]);
    expect(g).not.toBe(g2);
  });

  it('failNext queues across calls', async () => {
    const f = mk([1]);
    f.failNext('closeTab', 'a', 1);
    f.failNext('closeTab', 'b', 1);
    await expect(f.closeTab(1)).rejects.toThrow('a');
    await expect(f.closeTab(1)).rejects.toThrow('b');
    await f.closeTab(1);
  });

  it('createTab throws without windows', async () => {
    await expect(new FakeBrowserPort().createTab({ url: 'https://x' })).rejects.toThrow('No window');
  });
});
