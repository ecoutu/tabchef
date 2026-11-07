import { describe, it, expect, vi } from 'vitest';
import { ChromeBookmarkPort, ChromePort } from '../../src/platform/chrome-port';
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

  it('snapshot maps the tab status (the planner holds loading tabs)', async () => {
    const api = {
      windows: { getAll: async () => [{ id: 1, type: 'normal', focused: true }] },
      tabs: { query: async () => [{ ...base, id: 1, windowId: 1, url: 'https://a', status: 'loading' }, { ...base, id: 2, windowId: 1, url: 'https://b' }] },
      tabGroups: { query: async () => [] },
    } as unknown as ConstructorParameters<typeof ChromePort>[0];
    const s = await new ChromePort(api).snapshot();
    expect(s.tabs.map((t) => t.status)).toEqual(['loading', undefined]);
    expect('status' in s.tabs[1]!).toBe(false);
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

describe('ChromeBookmarkPort', () => {
  const event = () => {
    const ls = new Set<() => void>();
    return { ls, addListener: (f: () => void) => ls.add(f), removeListener: (f: () => void) => ls.delete(f) };
  };
  const mk = (bookmarks: Record<string, unknown> | undefined) =>
    new ChromeBookmarkPort({ bookmarks } as unknown as ConstructorParameters<typeof ChromeBookmarkPort>[0]);

  it("finds Other bookmarks by folderType 'other', else id '2', else the second root child", async () => {
    const kids = (k: unknown[]) => mk({ getChildren: vi.fn(async (id: string) => (id === '0' ? k : [])) });
    expect(await kids([{ id: '1', title: 'Bar', folderType: 'bookmarks-bar' }, { id: '7', title: 'Andere', folderType: 'other' }, { id: '2', title: 'x' }]).otherId()).toBe('7');
    expect(await kids([{ id: '1', title: 'Bar' }, { id: '2', title: 'Other' }]).otherId()).toBe('2');
    expect(await kids([{ id: 'a', title: 'Bar' }, { id: 'b', title: 'Other' }]).otherId()).toBe('b');
    await expect(kids([{ id: 'a', title: 'Bar' }]).otherId()).rejects.toThrow(/Other bookmarks/);
    // Account bookmarks: a local and an account "Other bookmarks"; the syncing (account) one wins, wherever it is.
    expect(await kids([
      { id: '1', title: 'Bar', folderType: 'bookmarks-bar' }, { id: '2', title: 'Other', folderType: 'other', syncing: false },
      { id: '11', title: 'Bar', folderType: 'bookmarks-bar', syncing: true }, { id: '12', title: 'Other', folderType: 'other', syncing: true },
    ]).otherId()).toBe('12');
  });

  it('maps nodes to id/title/url/children and calls the matching chrome.bookmarks methods', async () => {
    const api = {
      getChildren: vi.fn(async () => [{ id: '5', title: 'F', index: 0, dateAdded: 1, syncing: false }]),
      getSubTree: vi.fn(async () => [{ id: '5', title: 'F', children: [{ id: '6', title: 'x', url: 'https://x/', parentId: '5' }] }]),
      create: vi.fn(async () => ({ id: '9' })), update: vi.fn(async () => ({})), move: vi.fn(async () => ({})),
      remove: vi.fn(async () => undefined), removeTree: vi.fn(async () => undefined),
    };
    const b = mk(api);
    expect(await b.children('2')).toEqual([{ id: '5', title: 'F' }]);
    expect(await b.subtree('5')).toEqual({ id: '5', title: 'F', children: [{ id: '6', title: 'x', url: 'https://x/' }] });
    expect(await b.create({ parentId: '5', title: 'y', url: 'https://y/', index: 1 })).toBe('9');
    expect(api.create).toHaveBeenCalledWith({ parentId: '5', title: 'y', url: 'https://y/', index: 1 });
    await b.update('6', { title: 'z' });
    expect(api.update).toHaveBeenCalledWith('6', { title: 'z' });
    await b.move('6', { parentId: '5', index: 0 });
    expect(api.move).toHaveBeenCalledWith('6', { parentId: '5', index: 0 });
    await b.remove('6');
    await b.removeTree('5');
    expect(api.remove).toHaveBeenCalledWith('6');
    expect(api.removeTree).toHaveBeenCalledWith('5');
  });

  it('onChanged listens to every change event and unsubscribes; without the permission it is a no-op and calls throw', async () => {
    const names = ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded'];
    const evs = Object.fromEntries(names.map((n) => [n, event()]));
    const cb = vi.fn();
    const off = mk(evs).onChanged(cb);
    for (const n of names) expect(evs[n]!.ls.size).toBe(1);
    for (const n of names) for (const f of evs[n]!.ls) f();
    expect(cb).toHaveBeenCalledTimes(names.length);
    off();
    for (const n of names) expect(evs[n]!.ls.size).toBe(0);
    const none = mk(undefined);
    expect(() => none.onChanged(cb)()).not.toThrow();
    await expect(none.otherId()).rejects.toThrow(/bookmarks permission/);
  });
});
