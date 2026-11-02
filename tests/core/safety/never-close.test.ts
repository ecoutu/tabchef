import { describe, expect, it } from 'vitest';
import { neverCloseReason } from '../../../src/core/safety/never-close';

describe('neverCloseReason', () => {
  const tab = (id: number, pinned = false) => ({ id, pinned });
  const d = { isLocked: (id: number) => id === 2, isAnchor: (id: number) => id === 3 };

  it('names why a tab is never closed: pinned, then locked, then anchor', () => {
    expect(neverCloseReason(tab(1, true), d)).toBe('pinned');
    expect(neverCloseReason(tab(2), d)).toBe('locked');
    expect(neverCloseReason(tab(2, true), d)).toBe('pinned');
    expect(neverCloseReason(tab(3), d)).toBe('anchor');
    expect(neverCloseReason(tab(4), d)).toBeUndefined();
  });

  it('without an anchor lookup, no tab is an anchor', () => {
    expect(neverCloseReason(tab(3), { isLocked: () => false })).toBeUndefined();
  });
});
