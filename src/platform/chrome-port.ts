import type { GroupColor, Snapshot, TabSnap } from '../core/types';
import type { BookmarkNode, BookmarkPort, BrowserPort } from './browser-port';
import { withDragRetry } from './retry';

import { browser } from 'wxt/browser';

type ChromeApi = typeof browser;

export class ChromePort implements BrowserPort {
  constructor(
    private readonly api: ChromeApi = browser,
    private readonly delays?: number[],
    /** Applied to every snapshot (background: TabAges.annotate sets `TabSnap.created`, M3-R2). */
    private readonly annotate?: (s: Snapshot) => Promise<Snapshot>,
  ) {}

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withDragRetry(fn, this.delays);
  }

  async snapshot(): Promise<Snapshot> {
    const [wins, tabs, groups] = await Promise.all([
      this.api.windows.getAll(),
      this.api.tabs.query({}),
      this.api.tabGroups.query({}),
    ]);
    const normal = wins.filter((w) => w.type === 'normal' && w.id !== undefined);
    const ids = new Set(normal.map((w) => w.id as number));
    const result: Snapshot = {
      windows: normal.map((w) => ({ id: w.id as number, type: 'normal', focused: !!w.focused })),
      tabs: tabs.filter((t) => t.id !== undefined && ids.has(t.windowId)).map((t): TabSnap => {
        const snap: TabSnap = {
          id: t.id as number, windowId: t.windowId, index: t.index, url: t.url ?? '', title: t.title ?? '',
          pinned: t.pinned, groupId: t.groupId, incognito: t.incognito, discarded: t.discarded,
          frozen: (t as { frozen?: boolean }).frozen ?? false, active: t.active, audible: !!t.audible,
        };
        if (t.pendingUrl !== undefined) snap.pendingUrl = t.pendingUrl;
        if (t.lastAccessed !== undefined) snap.lastAccessed = t.lastAccessed;
        if (t.openerTabId !== undefined) snap.openerTabId = t.openerTabId;
        if (t.status !== undefined) snap.status = t.status as TabSnap['status'];
        if (t.favIconUrl && /^(https?:|data:)/i.test(t.favIconUrl)) snap.favIconUrl = t.favIconUrl;
        return snap;
      }),
      groups: groups.filter((g) => ids.has(g.windowId)).map((g) => ({
        id: g.id, windowId: g.windowId, title: g.title ?? '', color: g.color as GroupColor, collapsed: g.collapsed,
      })),
    };
    return this.annotate ? this.annotate(result) : result;
  }

  group(tabIds: number[], opts: { groupId?: number; windowId: number }): Promise<number> {
    const ids = tabIds as [number, ...number[]];
    return this.retry(() =>
      this.api.tabs.group(
        opts.groupId !== undefined
          ? { tabIds: ids, groupId: opts.groupId }
          : { tabIds: ids, createProperties: { windowId: opts.windowId } },
      ),
    );
  }

  ungroup(tabIds: number[]): Promise<void> {
    return this.retry(() => this.api.tabs.ungroup(tabIds as [number, ...number[]]));
  }

  async moveTabs(tabIds: number[], windowId: number, index: number): Promise<void> {
    await this.retry(() => this.api.tabs.move(tabIds, { windowId, index }));
  }

  async updateGroup(groupId: number, p: { title?: string; color?: GroupColor; collapsed?: boolean }): Promise<void> {
    await this.retry(() => this.api.tabGroups.update(groupId, p));
  }

  async moveGroup(groupId: number, index: number): Promise<void> {
    await this.retry(() => this.api.tabGroups.move(groupId, { index }));
  }

  closeTab(tabId: number): Promise<void> {
    return this.retry(() => this.api.tabs.remove(tabId));
  }

  async createTab(p: { url: string; windowId?: number; index?: number; active?: boolean }): Promise<number> {
    const t = await this.retry(() => this.api.tabs.create(p));
    return t.id as number;
  }

  async focusTab(tabId: number, windowId: number, url?: string): Promise<void> {
    await this.retry(() => this.api.tabs.update(tabId, url !== undefined ? { active: true, url } : { active: true }));
    await this.retry(() => this.api.windows.update(windowId, { focused: true }));
  }

  async setBadge(text: string): Promise<void> {
    await this.api.action.setBadgeText({ text });
  }

  hasPermission(p: { permissions?: string[]; origins?: string[] }): Promise<boolean> {
    return this.api.permissions.contains(p as Parameters<ChromeApi['permissions']['contains']>[0]);
  }

  async grantedOrigins(): Promise<string[]> {
    return (await this.api.permissions.getAll()).origins ?? [];
  }
}

/** chrome.bookmarks as a BookmarkPort (M4 T14). `bookmarks` is optional: until granted every call throws. */
export class ChromeBookmarkPort implements BookmarkPort {
  constructor(private readonly api: ChromeApi = browser) {}

  private get b(): ChromeApi['bookmarks'] {
    const b = this.api.bookmarks as ChromeApi['bookmarks'] | undefined;
    if (!b) throw new Error('the bookmarks permission is not granted');
    return b;
  }

  async otherId(): Promise<string> {
    // With account bookmarks a profile has a local and an account "Other bookmarks": the syncing one carries the
    // folder to other devices. `syncing` may be missing (older Chrome, typings): read defensively.
    const roots = (await this.b.getChildren('0')) as (BookmarkNode & { folderType?: unknown; syncing?: unknown })[];
    const other = roots.filter((r) => r.folderType === 'other');
    const n = other.find((r) => r.syncing === true) ?? other[0] ?? roots.find((r) => r.id === '2') ?? roots[1];
    if (!n) throw new Error('Other bookmarks not found');
    return n.id;
  }

  async children(id: string): Promise<BookmarkNode[]> {
    return (await this.b.getChildren(id)).map((n) => node(n, false));
  }

  async subtree(id: string): Promise<BookmarkNode> {
    const [n] = await this.b.getSubTree(id);
    if (!n) throw new Error(`no bookmark ${id}`);
    return node(n, true);
  }

  async create(p: { parentId: string; index?: number; title: string; url?: string }): Promise<string> {
    return (await this.b.create(p)).id;
  }

  async update(id: string, p: { title?: string; url?: string }): Promise<void> {
    await this.b.update(id, p);
  }

  async move(id: string, p: { parentId: string; index?: number }): Promise<void> {
    await this.b.move(id, p);
  }

  async remove(id: string): Promise<void> {
    await this.b.remove(id);
  }

  async removeTree(id: string): Promise<void> {
    await this.b.removeTree(id);
  }

  onChanged(cb: () => void): () => void {
    const b = this.api.bookmarks as ChromeApi['bookmarks'] | undefined;
    if (!b) return () => {};
    const evs = [b.onCreated, b.onRemoved, b.onChanged, b.onMoved, b.onChildrenReordered, b.onImportEnded] as unknown as
      { addListener(f: () => void): void; removeListener(f: () => void): void }[];
    const f = () => cb();
    for (const e of evs) e.addListener(f);
    return () => { for (const e of evs) { try { e.removeListener(f); } catch { /* the permission went away */ } } };
  }
}

type ChromeNode = { id: string; title: string; url?: string; children?: ChromeNode[] };
const node = (n: ChromeNode, deep: boolean): BookmarkNode => ({
  id: n.id, title: n.title, ...(n.url !== undefined && { url: n.url }), ...(deep && n.children && { children: n.children.map((c) => node(c, true)) }),
});
