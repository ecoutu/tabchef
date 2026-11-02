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
