import { describe, expect, it, vi } from 'vitest';
import { CLOSED_CLOCK_KEY, ProjectClock } from '../../src/engine/project-clock';
import type { Project } from '../../src/core/projects/types';
import type { Snapshot } from '../../src/core/types';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const snap: Snapshot = {
  tabs: [{ id: 1, windowId: 1, index: 0, url: 'https://example.com/', title: 'x', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false }],
  groups: [], windows: [{ id: 1, type: 'normal', focused: true }],
};
const project = (): Project => ({ id: 'r:ZZZ-9', recipeId: 'r', key: 'ZZZ-9', createdAt: NOW, manual: [], excluded: [], linked: [] });
const session = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (k: string) => structuredClone(data.get(k))),
    set: vi.fn(async (k: string, v: unknown) => { data.set(k, structuredClone(v)); }),
  };
};

describe('ProjectClock (T15 follow-up)', () => {
  it('two passes with no time elapsed write storage.session once', async () => {
    const s = session();
    const clock = new ProjectClock(s, () => NOW);
    const ps = [project()];
    await clock.closedTime(snap, ps, new Set(), new Set());
    await clock.closedTime(snap, ps, new Set(), new Set());
    expect(s.set).toHaveBeenCalledTimes(1);
    expect(s.data.get(CLOSED_CLOCK_KEY)).toEqual({ lastTick: NOW, pending: {} });
  });

  it('a failed session read falls back to the in-memory clock, so pending time is not lost on the next write', async () => {
    const s = session();
    let now = NOW;
    const clock = new ProjectClock(s, () => now);
    const ps = [project()];
    await clock.closedTime(snap, ps, new Set(), new Set());
    now += 15 * MIN;
    await clock.closedTime(snap, ps, new Set(), new Set());
    expect(s.data.get(CLOSED_CLOCK_KEY)).toEqual({ lastTick: now, pending: { 'r:ZZZ-9': 15 * MIN } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.get.mockRejectedValueOnce(new Error('session unavailable'));
    now += 15 * MIN;
    await clock.closedTime(snap, ps, new Set(), new Set());
    expect(s.data.get(CLOSED_CLOCK_KEY)).toEqual({ lastTick: now, pending: { 'r:ZZZ-9': 30 * MIN } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a new worker whose session read fails starts from the last clock it read itself (none: from zero)', async () => {
    const s = session();
    s.data.set(CLOSED_CLOCK_KEY, { lastTick: NOW, pending: { 'r:ZZZ-9': 20 * MIN } });
    let now = NOW + 10 * MIN;
    const clock = new ProjectClock(s, () => now);
    const ps = [project()];
    await clock.closedTime(snap, ps, new Set(), new Set()); // read ok: 20 + 10
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.get.mockRejectedValueOnce(new Error('x'));
    now += 5 * MIN;
    await clock.closedTime(snap, ps, new Set(), new Set()); // from memory: 30 + 5
    expect(s.data.get(CLOSED_CLOCK_KEY)).toEqual({ lastTick: now, pending: { 'r:ZZZ-9': 35 * MIN } });
    warn.mockRestore();
  });
});
