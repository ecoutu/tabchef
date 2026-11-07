import type { GroupColor, Snapshot } from '../core/types';

export interface BrowserPort {
  snapshot(): Promise<Snapshot>;
  group(tabIds: number[], opts: { groupId?: number; windowId: number }): Promise<number>;
  ungroup(tabIds: number[]): Promise<void>;
  /**
   * Moved tabs end up ungrouped (tab groups cannot span windows); callers regroup with group({groupId}) afterwards.
   * index -1 = end.
   */
  moveTabs(tabIds: number[], windowId: number, index: number): Promise<void>;
  updateGroup(groupId: number, p: { title?: string; color?: GroupColor; collapsed?: boolean }): Promise<void>;
  moveGroup(groupId: number, index: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  createTab(p: { url: string; windowId?: number; index?: number; active?: boolean }): Promise<number>;
  focusTab(tabId: number, windowId: number, url?: string): Promise<void>;
  setBadge(text: string): Promise<void>;
  hasPermission(p: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  /** The host match patterns the extension holds (permissions.getAll().origins), D42. */
  grantedOrigins(): Promise<string[]>;
}

/** A bookmark (with `url`) or folder (with `children` when read as a subtree), as chrome.bookmarks gives it (M4 T14). */
export interface BookmarkNode { id: string; title: string; url?: string; children?: BookmarkNode[] }

/**
 * The chrome.bookmarks subset project sync uses (optional permission `bookmarks`, M4 T14). Ids are this profile's
 * only: never persist them as cross-device keys.
 */
export interface BookmarkPort {
  /** The id of "Other bookmarks" (folderType 'other', else id '2', else the second root child). */
  otherId(): Promise<string>;
  /** A folder's direct children (folders without their children). */
  children(id: string): Promise<BookmarkNode[]>;
  /** A node with its whole subtree. */
  subtree(id: string): Promise<BookmarkNode>;
  /** Creates a bookmark (`url`) or folder; index -1 / unset = end. Returns its id. */
  create(p: { parentId: string; index?: number; title: string; url?: string }): Promise<string>;
  update(id: string, p: { title?: string; url?: string }): Promise<void>;
  /** index unset = the end. Within one parent Chrome counts the index before the node leaves. */
  move(id: string, p: { parentId: string; index?: number }): Promise<void>;
  /** Removes a bookmark or an empty folder. */
  remove(id: string): Promise<void>;
  /** Removes a folder with everything in it. */
  removeTree(id: string): Promise<void>;
  /** Any bookmark change (created, removed, changed, moved, reordered, import ended). Returns the unsubscribe. */
  onChanged(cb: () => void): () => void;
}
