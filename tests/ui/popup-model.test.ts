import { describe, it, expect } from 'vitest';
import { buildPopupModel, TAB_REGISTRY } from '../../src/ui/popup-model';

const set = (key: string) => ({ key, tabs: [] });
const ask = { newTabId: 2, existingTabId: 1, key: 'k', at: 0 };
const base = { dupes: [], pending: [], paused: false, recentCount: 0 };

describe('buildPopupModel', () => {
  it('registry has only duplicates in M1', () => {
    expect(TAB_REGISTRY.map((t) => t.id)).toEqual(['duplicates']);
  });
  it('marks zero-count tabs faded', () => {
    expect(buildPopupModel(base).tabs[0]).toMatchObject({ id: 'duplicates', count: 0, faded: true });
    expect(buildPopupModel({ ...base, dupes: [set('a')] }).tabs[0]).toMatchObject({ count: 1, faded: false });
  });
  it('counts pending asks with sets', () => {
    expect(buildPopupModel({ ...base, dupes: [set('a')], pending: [ask] }).tabs[0]!.count).toBe(2);
  });
  it('falls back to the first tab when lastTab is unknown or absent', () => {
    expect(buildPopupModel({ ...base, lastTab: 'nope' }).activeTab).toBe('duplicates');
    expect(buildPopupModel(base).activeTab).toBe('duplicates');
    expect(buildPopupModel({ ...base, lastTab: 'duplicates' }).activeTab).toBe('duplicates');
  });
  it('total is the sum of counts; header carries paused and recentCount', () => {
    const m = buildPopupModel({ ...base, dupes: [set('a'), set('b')], paused: true, recentCount: 4 });
    expect(m.header).toEqual({ paused: true, total: 2, recentCount: 4 });
  });
});
