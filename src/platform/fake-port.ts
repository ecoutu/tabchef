import type { GroupColor, GroupSnap, Snapshot, TabSnap } from '../core/types';
import type { BrowserPort } from './browser-port';

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
      for (const id of tabIds) this.tab(id).groupId = -1;
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
}
