import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withDragRetry, DragRetryExhausted } from '../../src/platform/retry';

const drag = () => new Error('Tabs cannot be edited right now (user may be dragging a tab).');

describe('withDragRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('succeeds on the 3rd try using delays 250, 500', async () => {
    const fn = vi.fn().mockRejectedValueOnce(drag()).mockRejectedValueOnce(drag()).mockResolvedValue('ok');
    const p = withDragRetry(fn);
    await vi.advanceTimersByTimeAsync(249);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws DragRetryExhausted after 5 attempts with cause', async () => {
    const err = drag();
    const fn = vi.fn().mockRejectedValue(err);
    const p = withDragRetry(fn);
    const assertion = expect(p).rejects.toSatisfy((e: unknown) => e instanceof DragRetryExhausted && e.cause === err);
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('rethrows other errors immediately', async () => {
    const e = new Error('boom');
    const fn = vi.fn().mockRejectedValue(e);
    await expect(withDragRetry(fn)).rejects.toBe(e);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
