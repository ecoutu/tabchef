import type { GroupColor, GroupSnap, Snapshot, TabSnap } from '../core/types';
import type { BookmarkNode, BookmarkPort, BrowserPort } from './browser-port';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;

/** In-memory BrowserPort for tests. Per-window tab indices are always contiguous 0..n-1. */
export class FakeBrowserPort implements BrowserPort {
  state: Snapshot = { tabs: [], groups: [], windows: [] };
  calls: { method: string; args: unknown[] }[] = [];
  badge = '';
  granted = new Set<string>();
  private failures = new Map<string, string[]>();
  private nextId = 1000;

  failNext(method: string, error: string, times = 1): void {
    const q = this.failures.get(method) ?? [];
    for (let i = 0; i < times; i++) q.push(error);
    this.failures.set(method, q);
  }

  /** Test helper: drop queued failures for one method (or all). */
  clearFailures(method?: string): void {
    if (method === undefined) this.failures.clear();
    else this.failures.delete(method);
  }

  addWindow(id: number, over: Partial<Snapshot['windows'][number]> = {}): void {
    this.state.windows.push({ id, type: 'normal', focused: false, ...over });
  }

  addTab(t: NewTab): TabSnap {
    const tab: TabSnap = { ...t, groupId: t.groupId ?? -1, index: 0 };
    this.state.tabs.push(tab);
    const list = this.winTabs(tab.windowId).filter((x) => x !== tab);
    const at = this.place(list, t.index ?? -1, tab.pinned);
    list.splice(at, 0, tab);
    this.reindex(list);
    return tab;
  }

  addGroup(g: GroupSnap): void {
    this.state.groups.push(g);
  }

  private async rec<T>(method: string, args: unknown[], run: () => T): Promise<T> {
    this.calls.push({ method, args });
    const err = this.failures.get(method)?.shift();
    if (err !== undefined) throw new Error(err);
    return run();
  }

  private winTabs(windowId: number): TabSnap[] {
    return this.state.tabs.filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index);
  }
  private reindex(list: TabSnap[]): void {
    list.forEach((t, i) => (t.index = i));
  }
  private tab(id: number): TabSnap {
    const t = this.state.tabs.find((x) => x.id === id);
    if (!t) throw new Error(`No tab with id: ${id}`);
    return t;
  }
  /** Clamp to the pinned prefix and snap out of the middle of another group's block. `rest` excludes the moving tabs. */
  private place(rest: TabSnap[], at: number, movingPinned: boolean): number {
    let i = at < 0 || at > rest.length ? rest.length : at;
    const pinned = rest.filter((t) => t.pinned).length;
    i = movingPinned ? Math.min(i, pinned) : Math.max(i, pinned);
    while (i > 0 && i < rest.length && rest[i]!.groupId !== -1 && rest[i]!.groupId === rest[i - 1]!.groupId) i++;
    return i;
  }

  /** Test helper: throws if per-window indices, pinned prefix or group contiguity are violated. */
  assertInvariants(): void {
    for (const w of new Set(this.state.tabs.map((t) => t.windowId))) {
      const list = this.winTabs(w);
      list.forEach((t, i) => {
        if (t.index !== i) throw new Error(`window ${w}: tab ${t.id} has index ${t.index}, expected ${i}`);
        if (t.pinned && i > 0 && !list[i - 1]!.pinned) throw new Error(`window ${w}: pinned tab ${t.id} after unpinned`);
      });
      const seen = new Set<number>();
      list.forEach((t, i) => {
        if (t.groupId === -1) return;
        if (i > 0 && list[i - 1]!.groupId === t.groupId) return;
        if (seen.has(t.groupId)) throw new Error(`window ${w}: group ${t.groupId} is not contiguous`);
        seen.add(t.groupId);
      });
    }
    for (const g of this.state.groups) {
      const ws = new Set(this.state.tabs.filter((t) => t.groupId === g.id).map((t) => t.windowId));
      if (ws.size > 1) throw new Error(`group ${g.id} spans windows`);
    }
  }

  private dropEmptyGroups(): void {
    this.state.groups = this.state.groups.filter((g) => this.state.tabs.some((t) => t.groupId === g.id));
  }

  async snapshot(): Promise<Snapshot> {
    return this.rec('snapshot', [], () => structuredClone(this.state));
  }

  async group(tabIds: number[], opts: { groupId?: number; windowId: number }): Promise<number> {
    return this.rec('group', [tabIds, opts], () => {
      const moving = tabIds.map((id) => this.tab(id));
      if (moving.some((t) => t.pinned)) throw new Error('Cannot group pinned tabs');
      moving.sort((a, b) =>
        a.windowId === b.windowId ? a.index - b.index : a.windowId - b.windowId);
      const target = this.winTabs(opts.windowId);
      const firstPos = target.findIndex((t) => moving.includes(t));
      const srcWindows = new Set(moving.map((t) => t.windowId));
      const movedSet = new Set(moving);
      const rest = target.filter((t) => !movedSet.has(t));
      let gid = opts.groupId;
      let at: number;
      if (gid === undefined) {
        gid = this.nextId++;
        this.state.groups.push({ id: gid, windowId: opts.windowId, title: '', color: 'grey', collapsed: false });
        at = this.place(rest, firstPos >= 0 ? target.slice(0, firstPos).filter((t) => !movedSet.has(t)).length : -1, false);
      } else {
        let last = -1;
        rest.forEach((t, i) => { if (t.groupId === gid) last = i; });
        at = last >= 0 ? last + 1 : rest.length;
      }
      for (const t of moving) { t.windowId = opts.windowId; t.groupId = gid; }
      rest.splice(at, 0, ...moving);
      this.reindex(rest);
      for (const w of srcWindows) if (w !== opts.windowId) this.reindex(this.winTabs(w));
      this.dropEmptyGroups();
      return gid;
    });
  }

  async ungroup(tabIds: number[]): Promise<void> {
    return this.rec('ungroup', [tabIds], () => {
      // Like Chrome: ungrouped tabs leave their group's block and land right after what remains of it.
      const leaving = tabIds.map((id) => this.tab(id)).filter((t) => t.groupId !== -1);
      for (const gid of new Set(leaving.map((t) => t.groupId))) {
        const out = leaving.filter((t) => t.groupId === gid);
        const set = new Set(out);
        const rest = this.winTabs(out[0]!.windowId).filter((t) => !set.has(t));
        let last = -1;
        rest.forEach((t, i) => { if (t.groupId === gid) last = i; });
        for (const t of out) t.groupId = -1;
        if (last < 0) continue; // whole group ungrouped: tabs stay where they are
        rest.splice(last + 1, 0, ...out.sort((a, b) => a.index - b.index));
        this.reindex(rest);
      }
      this.dropEmptyGroups();
    });
  }

  async moveTabs(tabIds: number[], windowId: number, index: number): Promise<void> {
    return this.rec('moveTabs', [tabIds, windowId, index], () => {
      const moving = tabIds.map((id) => this.tab(id));
      const src = new Set(moving.map((t) => t.windowId));
      const set = new Set(moving);
      const rest = this.winTabs(windowId).filter((t) => !set.has(t));
      const at = this.place(rest, index, moving.every((t) => t.pinned));
      for (const t of moving) { t.windowId = windowId; t.groupId = -1; }
      rest.splice(at, 0, ...moving);
      this.reindex(rest);
      for (const w of src) if (w !== windowId) this.reindex(this.winTabs(w));
      this.dropEmptyGroups();
    });
  }

  async updateGroup(groupId: number, p: { title?: string; color?: GroupColor; collapsed?: boolean }): Promise<void> {
    return this.rec('updateGroup', [groupId, p], () => {
      const g = this.state.groups.find((x) => x.id === groupId);
      if (!g) throw new Error(`No group with id: ${groupId}`);
      if (p.title !== undefined) g.title = p.title;
      if (p.color !== undefined) g.color = p.color;
      if (p.collapsed !== undefined) g.collapsed = p.collapsed;
    });
  }

  async moveGroup(groupId: number, index: number): Promise<void> {
    return this.rec('moveGroup', [groupId, index], () => {
      const block = this.state.tabs.filter((t) => t.groupId === groupId).sort((a, b) => a.index - b.index);
      const first = block[0];
      if (!first) throw new Error(`No group with id: ${groupId}`);
      const set = new Set(block);
      const rest = this.winTabs(first.windowId).filter((t) => !set.has(t));
      const at = this.place(rest, index, false);
      rest.splice(at, 0, ...block);
      this.reindex(rest);
    });
  }

  async closeTab(tabId: number): Promise<void> {
    return this.rec('closeTab', [tabId], () => {
      const t = this.tab(tabId);
      this.state.tabs = this.state.tabs.filter((x) => x !== t);
      this.reindex(this.winTabs(t.windowId));
      this.dropEmptyGroups();
    });
  }

  async createTab(p: { url: string; windowId?: number; index?: number; active?: boolean }): Promise<number> {
    return this.rec('createTab', [p], () => {
      const windowId = p.windowId ?? this.state.windows.find((w) => w.focused)?.id ?? this.state.windows[0]?.id;
      if (windowId === undefined) throw new Error('No window available');
      const id = this.nextId++;
      const index = this.place(this.winTabs(windowId), p.index ?? -1, false);
      this.addTab({
        id, windowId, url: p.url, title: p.url, pinned: false, incognito: false, discarded: false,
        active: p.active ?? true, audible: false, index,
      });
      return id;
    });
  }

  async focusTab(tabId: number, windowId: number, url?: string): Promise<void> {
    return this.rec('focusTab', [tabId, windowId, url], () => {
      const t = this.tab(tabId);
      if (url !== undefined) t.url = url;
      for (const o of this.state.tabs) if (o.windowId === t.windowId) o.active = o === t;
      for (const w of this.state.windows) w.focused = w.id === windowId;
    });
  }

  async setBadge(text: string): Promise<void> {
    return this.rec('setBadge', [text], () => { this.badge = text; });
  }

  async hasPermission(p: { permissions?: string[]; origins?: string[] }): Promise<boolean> {
    return this.rec('hasPermission', [p], () =>
      [...(p.permissions ?? []), ...(p.origins ?? [])].every((x) => this.granted.has(x)));
  }

  /** `granted` holds permissions and origins alike: origins are the entries with a scheme. */
  async grantedOrigins(): Promise<string[]> {
    return this.rec('grantedOrigins', [], () => [...this.granted].filter((x) => x.includes('://')));
  }
}

/**
 * In-memory BookmarkPort for tests (M4 T14): a root '0' with "Bookmarks bar" ('1') and "Other bookmarks" ('2'). One
 * instance shared by two ProjectSync instances stands for one tree Chrome Sync keeps equal on two devices. Each change
 * is reported to every listener after the call resolves (a timer task), as Chrome's events arrive later.
 */
export class FakeBookmarkPort implements BookmarkPort {
  root: BookmarkNode = { id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: [] }, { id: '2', title: 'Other bookmarks', children: [] }] };
  /** Every successful change, in order. */
  log: { method: string; args: unknown[] }[] = [];
  private nextId = 100;
  private listeners = new Set<() => void>();
  /** Test switch: report each change synchronously, inside the call (a remote change landing mid-write). */
  syncEvents = false;

  /** Test helper: the number of successful changes. */
  writes(): number {
    return this.log.length;
  }

  private find(id: string, n: BookmarkNode = this.root, parent?: BookmarkNode): { node: BookmarkNode; parent?: BookmarkNode } {
    if (n.id === id) return { node: n, parent };
    for (const c of n.children ?? []) {
      try { return this.find(id, c, n); } catch { /* not under c */ }
    }
    throw new Error(`Can't find bookmark for id. ${id}`);
  }

  private change(method: string, args: unknown[]): void {
    this.log.push({ method, args });
    for (const cb of [...this.listeners]) {
      if (this.syncEvents) cb();
      else setTimeout(cb, 0);
    }
  }

  async otherId(): Promise<string> {
    return '2';
  }

  async children(id: string): Promise<BookmarkNode[]> {
    return (this.find(id).node.children ?? []).map((c) => ({ id: c.id, title: c.title, ...(c.url !== undefined && { url: c.url }) }));
  }

  async subtree(id: string): Promise<BookmarkNode> {
    return structuredClone(this.find(id).node);
  }

  async create(p: { parentId: string; index?: number; title: string; url?: string }): Promise<string> {
    const parent = this.find(p.parentId).node;
    if (!parent.children) throw new Error('Parameter "parentId" does not specify a folder.');
    const id = String(this.nextId++);
    const node: BookmarkNode = { id, title: p.title, ...(p.url !== undefined ? { url: p.url } : { children: [] }) };
    const at = p.index === undefined || p.index < 0 || p.index > parent.children.length ? parent.children.length : p.index;
    parent.children.splice(at, 0, node);
    this.change('create', [p]);
    return id;
  }

  async update(id: string, p: { title?: string; url?: string }): Promise<void> {
    const n = this.find(id).node;
    if (p.title !== undefined) n.title = p.title;
    if (p.url !== undefined) n.url = p.url;
    this.change('update', [id, p]);
  }

  async move(id: string, p: { parentId: string; index?: number }): Promise<void> {
    const { node, parent: from } = this.find(id);
    const to = this.find(p.parentId).node;
    if (!to.children || !from?.children) throw new Error('Invalid move');
    const old = from.children.indexOf(node);
    from.children.splice(old, 1);
    // Chrome: the index is counted before the node leaves, so within the same parent a later index lands one before.
    const want = p.index ?? to.children.length + (from === to ? 1 : 0);
    const index = from === to && old < want ? want - 1 : want;
    to.children.splice(Math.min(Math.max(index, 0), to.children.length), 0, node);
    this.change('move', [id, p]);
  }

  async remove(id: string): Promise<void> {
    const { node, parent } = this.find(id);
    if (node.children?.length) throw new Error("Can't remove non-empty folder (use recursive to force).");
    parent!.children!.splice(parent!.children!.indexOf(node), 1);
    this.change('remove', [id]);
  }

  async removeTree(id: string): Promise<void> {
    const { node, parent } = this.find(id);
    parent!.children!.splice(parent!.children!.indexOf(node), 1);
    this.change('removeTree', [id]);
  }

  onChanged(cb: () => void): () => void {
    const once = () => cb();
    this.listeners.add(once);
    return () => { this.listeners.delete(once); };
  }
}
