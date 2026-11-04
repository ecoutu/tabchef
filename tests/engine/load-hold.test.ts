import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAD_HOLD_MS, LoadHold } from '../../src/engine/load-hold';
import type { TabSnap } from '../../src/core/types';

const tab = (id: number, status?: TabSnap['status']): TabSnap => ({
  id, windowId: 1, index: 0, url: 'https://a.com/', title: '', pinned: false, groupId: -1, incognito: false,
  discarded: false, active: false, audible: false, ...(status && { status }),
});

describe('LoadHold', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('holds a loading tab, never a loaded, unloaded or status-less one', () => {
    const h = new LoadHold({ onExpired: () => {} });
    expect(h.held(tab(1, 'loading'))).toBe(true);
    expect(h.held(tab(2, 'complete'))).toBe(false);
    expect(h.held(tab(3, 'unloaded'))).toBe(false);
    expect(h.held(tab(4))).toBe(false);
  });

  it('a page that never finishes loading is held for LOAD_HOLD_MS, then re-planned (onExpired) and no longer held', async () => {
    const onExpired = vi.fn();
    const h = new LoadHold({ onExpired });
    h.onLoading(1);
    await vi.advanceTimersByTimeAsync(LOAD_HOLD_MS - 1000);
    expect(h.held(tab(1, 'loading'))).toBe(true);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(h.held(tab(1, 'loading'))).toBe(false);
  });

  it('the timer is armed only while the planner holds the tab, once per hold', async () => {
    const onExpired = vi.fn();
    const h = new LoadHold({ onExpired });
    h.onLoading(1);
    await vi.advanceTimersByTimeAsync(LOAD_HOLD_MS * 2);
    expect(onExpired).not.toHaveBeenCalled(); // never asked: nothing to re-plan
    h.onLoading(2);
    h.held(tab(2, 'loading'));
    h.held(tab(2, 'loading'));
    await vi.advanceTimersByTimeAsync(LOAD_HOLD_MS);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('a finished load ends the hold and its timer; the next navigation holds again', async () => {
    const onExpired = vi.fn();
    const h = new LoadHold({ onExpired });
    h.onLoading(1);
    h.held(tab(1, 'loading'));
    h.onDone(1);
    await vi.advanceTimersByTimeAsync(LOAD_HOLD_MS);
    expect(onExpired).not.toHaveBeenCalled();
    h.onLoading(1);
    expect(h.held(tab(1, 'loading'))).toBe(true);
  });

  it('a navigation after an expired hold (the page never completed) starts a new hold', async () => {
    const h = new LoadHold({ onExpired: () => {} });
    h.onLoading(1);
    await vi.advanceTimersByTimeAsync(LOAD_HOLD_MS);
    expect(h.held(tab(1, 'loading'))).toBe(false);
    h.onLoading(1);
    expect(h.held(tab(1, 'loading'))).toBe(true);
  });

  it('a loading tab first seen in a snapshot (worker restart) is held from then on', async () => {
    const h = new LoadHold({ onExpired: () => {} });
    expect(h.held(tab(1, 'loading'))).toBe(true);
    await vi.advanceTimersByTimeAsync(LOAD_HOLD_MS);
    expect(h.held(tab(1, 'loading'))).toBe(false);
  });
});
