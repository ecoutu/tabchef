import { describe, it, expect } from 'vitest';
import { buildPopupModel, DEFAULT_VISIBLE_COUNT, parsePopupPrefs, type PopupModelInput } from '../../src/ui/popup-model';

const v = (id: string, count = 0, o: Partial<PopupModelInput['views'][number]> = {}) => ({ id, tab: id.toUpperCase(), count, ...o });
const base: PopupModelInput = { views: [v('duplicates')], paused: false, recentCount: 0 };
const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => v(id, i));

describe('buildPopupModel (M2 T17: recipe views)', () => {
  it('7 views with visibleCount 5: 5 tabs, the other 2 under More, in tabOrder order', () => {
    const m = buildPopupModel({ ...base, views: seven, visibleCount: 5, tabOrder: ['g', 'f', 'a'] });
    expect(m.tabs.map((t) => t.id)).toEqual(['g', 'f', 'a', 'b', 'c']);
    expect(m.more).toEqual([{ id: 'd', label: 'D', count: 3 }, { id: 'e', label: 'E', count: 4 }]);
  });

  it('defaults to 5 visible tabs in view order; unknown tabOrder ids are ignored', () => {
    expect(DEFAULT_VISIBLE_COUNT).toBe(5);
    const m = buildPopupModel({ ...base, views: seven, tabOrder: ['zz', 'c'] });
    expect(m.tabs.map((t) => t.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(m.more.map((t) => t.id)).toEqual(['f', 'g']);
  });

  it('a bad visibleCount falls back to the default; at least one tab stays visible', () => {
    expect(buildPopupModel({ ...base, views: seven, visibleCount: Number.NaN }).tabs).toHaveLength(5);
    expect(buildPopupModel({ ...base, views: seven, visibleCount: 0 }).tabs).toHaveLength(1);
    expect(buildPopupModel({ ...base, views: seven, visibleCount: 99 }).more).toEqual([]);
  });

  it('a paused view is faded and carries its reason, even with items (R45)', () => {
    const m = buildPopupModel({ ...base, views: [v('finished', 2, { paused: 'Paused: needs access to meet.google.com' })] });
    expect(m.tabs[0]).toMatchObject({ id: 'finished', count: 2, faded: true, paused: 'Paused: needs access to meet.google.com' });
  });

  it("a projects view shows its open projects but stays out of the header total (not badge items); never faded at 0 (M3 T17)", () => {
    expect(buildPopupModel({ ...base, views: [v('projects', 0, { kind: 'projects' })] }).tabs[0]!.faded).toBe(false);
    const m = buildPopupModel({ ...base, views: [v('duplicates', 1), v('projects', 3, { kind: 'projects' })] });
    expect(m.tabs.map((t) => t.count)).toEqual([1, 3]);
    expect(m.header.total).toBe(1);
  });

  it('zero-count views are faded; others are not', () => {
    const m = buildPopupModel({ ...base, views: [v('a', 0), v('b', 1)] });
    expect(m.tabs.map((t) => t.faded)).toEqual([true, false]);
  });

  it('opens the last-used view (also an overflow one), else the first visible', () => {
    expect(buildPopupModel({ ...base, views: seven, lastTab: 'g' }).activeTab).toBe('g');
    expect(buildPopupModel({ ...base, views: seven, lastTab: 'nope' }).activeTab).toBe('a');
    expect(buildPopupModel({ ...base, views: [] }).activeTab).toBe('');
  });

  it('header total is the sum of the visible and overflow view counts', () => {
    const m = buildPopupModel({ ...base, views: seven, visibleCount: 2, paused: true, recentCount: 4 });
    expect(m.header).toEqual({ paused: true, total: 0 + 1 + 2 + 3 + 4 + 5 + 6, recentCount: 4 });
  });
});

describe('parsePopupPrefs (R20: storage.local popup.prefs)', () => {
  it('keeps valid fields and drops the rest', () => {
    expect(parsePopupPrefs({ tabOrder: ['a', 'b'], visibleCount: 3 })).toEqual({ tabOrder: ['a', 'b'], visibleCount: 3 });
    expect(parsePopupPrefs({ tabOrder: ['a', 1], visibleCount: 'x' })).toEqual({});
    expect(parsePopupPrefs(undefined)).toEqual({});
    expect(parsePopupPrefs('junk')).toEqual({});
  });
});
