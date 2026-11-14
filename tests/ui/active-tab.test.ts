import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { currentTab, followActiveTab } from '../../src/ui/active-tab';

type Query = {
  mockResolvedValue: (v: unknown) => void; mockRejectedValue: (e: unknown) => void;
  mockImplementation: (f: () => Promise<unknown>) => void; mock: { calls: unknown[][] };
};
const query = () => vi.spyOn(browser.tabs, 'query') as unknown as Query;
const activate = (tabId: number, windowId: number) =>
  (fakeBrowser.tabs.onActivated as unknown as { trigger: (i: unknown) => Promise<unknown> }).trigger({ tabId, windowId });
const listening = () => (fakeBrowser.tabs.onActivated as unknown as { hasListeners: () => boolean }).hasListeners();
/** tabs.query answers only when `answer` is called, with the tabs given then: the oldest waiting query, or the `i`th. */
function heldQuery(): { answer: (tabs: unknown[], i?: number) => void } {
  const waiting: ((tabs: unknown[]) => void)[] = [];
  query().mockImplementation(() => new Promise((resolve) => waiting.push(resolve)));
  return { answer: (tabs, i = 0) => waiting.splice(i, 1)[0]!(tabs) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

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

describe('followActiveTab', () => {
  it('reports the current tab, then each tab activated in the same window only, until stopped', async () => {
    query().mockResolvedValue([{ id: 5, windowId: 3 }]);
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    await vi.waitFor(() => expect(seen).toEqual([5]));
    await activate(6, 3);
    await activate(7, 4); // another window
    expect(seen).toEqual([5, 6]);
    f.stop();
    expect(listening()).toBe(false);
    await activate(8, 3);
    expect(seen).toEqual([5, 6]);
  });

  it('no current tab: nothing reported', async () => {
    query().mockResolvedValue([]);
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    await flush();
    await activate(6, 3);
    expect(seen).toEqual([]);
    f.stop();
  });

  it('stopped before the first query answers: nothing reported', async () => {
    const q = heldQuery();
    const seen: number[] = [];
    followActiveTab((id) => seen.push(id)).stop();
    q.answer([{ id: 5, windowId: 3 }]);
    await flush();
    expect(seen).toEqual([]);
  });

  it('a switch in the window while the first query runs wins over its answer; another window\'s does not', async () => {
    const q = heldQuery();
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    await activate(6, 3);
    await activate(9, 4);
    q.answer([{ id: 5, windowId: 3 }]);
    await vi.waitFor(() => expect(seen).toEqual([6]));
    f.stop();
  });

  it('only another window switched while the first query ran: the query answer is reported', async () => {
    const q = heldQuery();
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    await activate(9, 4);
    q.answer([{ id: 5, windowId: 3 }]);
    await vi.waitFor(() => expect(seen).toEqual([5]));
    f.stop();
  });

  it('sync() reports a changed active tab id (tabs.onReplaced), and nothing when it is the same', async () => {
    const q = query();
    q.mockResolvedValue([{ id: 5, windowId: 3 }]);
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    await vi.waitFor(() => expect(seen).toEqual([5]));
    await f.sync();
    expect(seen).toEqual([5]);
    q.mockResolvedValue([{ id: 50, windowId: 3 }]);
    await f.sync();
    expect(seen).toEqual([5, 50]);
    f.stop();
  });

  it('a sync() answer that a switch overtook is dropped', async () => {
    query().mockResolvedValue([{ id: 5, windowId: 3 }]);
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    await vi.waitFor(() => expect(seen).toEqual([5]));
    const q = heldQuery();
    const done = f.sync();
    await activate(6, 3);
    q.answer([{ id: 5, windowId: 3 }]); // read before the switch
    await done;
    expect(seen).toEqual([5, 6]);
    f.stop();
  });

  it.each([['first query', 0], ['sync()', 1]])('a switch while the first query and a sync() both run wins over both answers (%s answers first)', async (_, first) => {
    const q = heldQuery();
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    const done = f.sync(); // the side panel's first load
    await activate(6, 3);
    q.answer([{ id: 5, windowId: 3 }], first); // both read before the switch
    q.answer([{ id: 5, windowId: 3 }]);
    await done;
    await flush();
    expect(seen).toEqual([6]);
    f.stop();
  });

  it('a switch before the window is known loses to a query started after it', async () => {
    const q = heldQuery();
    const seen: number[] = [];
    const f = followActiveTab((id) => seen.push(id));
    await activate(6, 3);
    const done = f.sync(); // started after the switch
    q.answer([{ id: 60, windowId: 3 }], 1); // e.g. tab 6 replaced by 60 since
    await done;
    q.answer([{ id: 5, windowId: 3 }]); // the first query, read before the switch
    await flush();
    expect(seen).toEqual([60]);
    f.stop();
  });
});
