import { describe, it, expect, vi } from 'vitest';
import { ChromePort } from '../../src/platform/chrome-port';
import type { Snapshot } from '../../src/core/types';

const base = { index: 0, pinned: false, incognito: false, discarded: false, active: false, groupId: -1 };

describe('ChromePort', () => {
  it('snapshot only includes normal windows and their tabs/groups', async () => {
    const api = {
      windows: { getAll: async () => [{ id: 1, type: 'normal', focused: true }, { id: 2, type: 'popup', focused: false }] },
      tabs: { query: async () => [{ ...base, id: 10, windowId: 1, url: 'https://a' }, { ...base, id: 11, windowId: 2, url: 'https://b' }] },
      tabGroups: { query: async () => [{ id: 5, windowId: 1, title: 'G', color: 'red', collapsed: false }, { id: 6, windowId: 2, title: 'P', color: 'blue', collapsed: false }] },
    } as unknown as ConstructorParameters<typeof ChromePort>[0];
    const s = await new ChromePort(api).snapshot();
    expect(s.windows.map((w) => w.id)).toEqual([1]);
    expect(s.tabs.map((t) => t.id)).toEqual([10]);
    expect(s.tabs[0]!.frozen).toBe(false);
    expect(s.groups.map((g) => g.id)).toEqual([5]);
  });

  it('snapshot keeps only http(s)/data favicons', async () => {
    const api = {
      windows: { getAll: async () => [{ id: 1, type: 'normal', focused: true }] },
      tabs: { query: async () => [
        { ...base, id: 1, windowId: 1, url: 'https://a', favIconUrl: 'https://a/f.ico' },
        { ...base, id: 2, windowId: 1, url: 'https://b', favIconUrl: 'chrome://favicon/x' },
        { ...base, id: 3, windowId: 1, url: 'https://c', favIconUrl: 'data:image/png;base64,AA' },
        { ...base, id: 4, windowId: 1, url: 'https://d' },
      ] },
      tabGroups: { query: async () => [] },
    } as unknown as ConstructorParameters<typeof ChromePort>[0];
    const s = await new ChromePort(api).snapshot();
    expect(s.tabs.map((t) => t.favIconUrl)).toEqual(['https://a/f.ico', undefined, 'data:image/png;base64,AA', undefined]);
  });

  it('snapshot maps openerTabId (D5)', async () => {
    const api = {
      windows: { getAll: async () => [{ id: 1, type: 'normal', focused: true }] },
      tabs: { query: async () => [{ ...base, id: 1, windowId: 1, url: 'https://a' }, { ...base, id: 2, windowId: 1, url: 'https://b', openerTabId: 1 }] },
      tabGroups: { query: async () => [] },
    } as unknown as ConstructorParameters<typeof ChromePort>[0];
    const s = await new ChromePort(api).snapshot();
    expect(s.tabs.map((t) => t.openerTabId)).toEqual([undefined, 1]);
    expect('openerTabId' in s.tabs[0]!).toBe(false);
  });

  it('snapshot applies the optional annotate hook to its output (TabAges, M3-R2)', async () => {
    const api = {
      windows: { getAll: async () => [{ id: 1, type: 'normal', focused: true }] },
      tabs: { query: async () => [{ ...base, id: 1, windowId: 1, url: 'https://a' }] },
      tabGroups: { query: async () => [] },
    } as unknown as ConstructorParameters<typeof ChromePort>[0];
    const plain = await new ChromePort(api).snapshot();
    expect('created' in plain.tabs[0]!).toBe(false);
    const annotate = vi.fn(async (s: Snapshot) => ({ ...s, tabs: s.tabs.map((t) => ({ ...t, created: { at: 5, exact: true } })) }));
    const s = await new ChromePort(api, undefined, annotate).snapshot();
    expect(annotate).toHaveBeenCalledWith(plain);
    expect(s).toEqual({ ...plain, tabs: [{ ...plain.tabs[0], created: { at: 5, exact: true } }] });
  });

  it('mutating calls go through drag retry', async () => {
    vi.useFakeTimers();
    const remove = vi.fn()
      .mockRejectedValueOnce(new Error('Tabs cannot be edited right now (user may be dragging a tab).'))
      .mockResolvedValue(undefined);
    const port = new ChromePort({ tabs: { remove } } as unknown as ConstructorParameters<typeof ChromePort>[0]);
    const p = port.closeTab(3);
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(remove).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it('grantedOrigins lists permissions.getAll().origins (D42)', async () => {
    const mk = (all: { origins?: string[] }) => new ChromePort({ permissions: { getAll: async () => all } } as unknown as ConstructorParameters<typeof ChromePort>[0]);
    expect(await mk({ origins: ['https://meet.google.com/*'] }).grantedOrigins()).toEqual(['https://meet.google.com/*']);
    expect(await mk({}).grantedOrigins()).toEqual([]);
  });
});
