import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOAD_HOLD_MS, LoadHold, TITLE_WAIT_MS } from '../../src/engine/load-hold';
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

  // GitHub's in-page navigation (a PR opened from the PR list), recorded in Chromium 156: status loading, complete
  // 11 ms later, then the URL as a placeholder title and the real title (with the ticket key) ~530 ms after complete.
  describe('in-page navigations: the title lands after complete', () => {
    const PR = 'https://github.com/apache/kafka/pull/24113';

    it('keeps holding after complete until a real title arrives, then re-plans', async () => {
      const onExpired = vi.fn();
      const h = new LoadHold({ onExpired });
      h.onLoading(1);
      h.onComplete(1);
      expect(h.held(tab(1, 'complete'))).toBe(true);
      expect(h.onTitle(1, 'github.com/apache/kafka/pull/24113', PR)).toBe(false); // Chrome's URL placeholder
      expect(h.held(tab(1, 'complete'))).toBe(true);
      expect(h.onTitle(1, 'KAFKA-21409: Switching to a subscription regex by x · Pull Request #24113', PR)).toBe(true);
      expect(h.held(tab(1, 'complete'))).toBe(false);
      await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
      expect(onExpired).not.toHaveBeenCalled();
    });

    it('a title that arrived while loading (a full page load) ends the hold at complete', () => {
      const h = new LoadHold({ onExpired: () => {} });
      h.onLoading(1);
      h.onTitle(1, 'Switch to using scala 2.9.2 · Pull Request #1', PR);
      h.onComplete(1);
      expect(h.held(tab(1, 'complete'))).toBe(false);
    });

    it('a page whose title never arrives is held TITLE_WAIT_MS after complete at most', async () => {
      const onExpired = vi.fn();
      const h = new LoadHold({ onExpired });
      h.onLoading(1);
      h.onComplete(1);
      expect(h.held(tab(1, 'complete'))).toBe(true);
      await vi.advanceTimersByTimeAsync(TITLE_WAIT_MS);
      expect(onExpired).toHaveBeenCalledTimes(1);
      expect(h.held(tab(1, 'complete'))).toBe(false);
    });

    it('a snapshot that already says complete before the complete event still waits for the title', () => {
      const h = new LoadHold({ onExpired: () => {} });
      h.onLoading(1);
      expect(h.held(tab(1, 'complete'))).toBe(true);
      h.onComplete(1);
      expect(h.held(tab(1, 'complete'))).toBe(true);
    });

    it('a tab that never started loading is not held, and a removed tab drops every hold', () => {
      const h = new LoadHold({ onExpired: () => {} });
      h.onComplete(2);
      expect(h.held(tab(2, 'complete'))).toBe(false);
      h.onLoading(1);
      h.onComplete(1);
      h.onDone(1);
      expect(h.held(tab(1, 'complete'))).toBe(false);
    });
  });
});
