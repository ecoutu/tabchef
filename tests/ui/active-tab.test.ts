import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { currentTab } from '../../src/ui/active-tab';

type Query = { mockResolvedValue: (v: unknown) => void; mockRejectedValue: (e: unknown) => void; mock: { calls: unknown[][] } };
const query = () => vi.spyOn(browser.tabs, 'query') as unknown as Query;

beforeEach(() => { fakeBrowser.reset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('currentTab', () => {
  it('the active tab of the current window', async () => {
    const q = query();
    q.mockResolvedValue([{ id: 5, windowId: 3 }]);
    expect(await currentTab()).toEqual({ tabId: 5, windowId: 3 });
    expect(q.mock.calls[0]![0]).toEqual({ active: true, currentWindow: true });
  });

  it('a tab without an id keeps its window', async () => {
    query().mockResolvedValue([{ windowId: 3 }]);
    expect(await currentTab()).toEqual({ tabId: undefined, windowId: 3 });
  });

  it('none: no tab, or a failed query', async () => {
    const q = query();
    q.mockResolvedValue([]);
    expect(await currentTab()).toBeUndefined();
    q.mockRejectedValue(new Error('no window'));
    expect(await currentTab()).toBeUndefined();
  });
});
