import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabHolds } from '../../src/engine/tab-holds';

describe('TabHolds', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('holds from start until ms later; expiry calls onExpired once, and only for a hold the planner asked about', async () => {
    const onExpired = vi.fn();
    const h = new TabHolds(1000, onExpired);
    expect(h.held(1)).toBe(false);
    h.start(1);
    h.start(2);
    expect(h.held(1)).toBe(true);
    expect(h.held(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(h.held(1)).toBe(false);
    expect(h.held(2)).toBe(false);
  });

  it('an expired hold stays known until it ends; start restarts it', async () => {
    const h = new TabHolds(1000, () => {});
    h.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.has(1)).toBe(true);
    expect(h.live(1)).toBe(false);
    h.start(1);
    expect(h.live(1)).toBe(true);
    h.end(1);
    expect(h.has(1)).toBe(false);
  });

  it('end cancels the expiry timer; live arms none', async () => {
    const onExpired = vi.fn();
    const h = new TabHolds(1000, onExpired);
    h.start(1);
    h.held(1);
    h.end(1);
    h.start(2);
    expect(h.live(2)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
