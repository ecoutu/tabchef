import { describe, it, expect } from 'vitest';
import {
  allCollapsed, collapseIds, COLLAPSED_PROJECTS_KEY, expandIds, parseCollapsed, pruneCollapsed, sameIds,
} from '../../src/ui/collapsed-projects';

describe('collapsed projects (#151)', () => {
  it('is stored in storage.local next to the other per-device project keys', () => {
    expect(COLLAPSED_PROJECTS_KEY).toBe('projects.collapsed');
  });

  it('parseCollapsed keeps a list of ids, deduplicated; anything else is none (every card expanded)', () => {
    expect(parseCollapsed(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(parseCollapsed(undefined)).toEqual([]);
    expect(parseCollapsed('a')).toEqual([]);
    expect(parseCollapsed({ a: true })).toEqual([]);
    expect(parseCollapsed(['a', 1, null, ''])).toEqual(['a']);
  });

  it('collapseIds adds the missing ids, expandIds removes them; other ids keep their state', () => {
    expect(collapseIds([], ['a'])).toEqual(['a']);
    expect(collapseIds(['x', 'a'], ['a', 'b'])).toEqual(['x', 'a', 'b']);
    expect(expandIds(['a', 'b'], ['a'])).toEqual(['b']);
    expect(expandIds(['x', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['x']);
    expect(expandIds([], ['a'])).toEqual([]);
  });

  it('pruneCollapsed drops the ids of projects no longer listed, keeping the order', () => {
    expect(pruneCollapsed(['a', 'gone', 'b'], ['b', 'a', 'c'])).toEqual(['a', 'b']);
    expect(pruneCollapsed(['a'], [])).toEqual([]);
  });

  it('allCollapsed: true only when there are cards and every one is collapsed', () => {
    expect(allCollapsed(['a', 'b', 'x'], ['a', 'b'])).toBe(true);
    expect(allCollapsed(['a'], ['a', 'b'])).toBe(false);
    expect(allCollapsed(['a'], [])).toBe(false);
  });

  it('sameIds compares as sets', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});
