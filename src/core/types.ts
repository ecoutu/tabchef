export type GroupColor = 'grey'|'blue'|'red'|'yellow'|'green'|'pink'|'purple'|'cyan'|'orange';
export interface GroupRule {
  id: string; name: string; enabled: boolean;
  match: { url: string | string[] };          // glob, /regex/, or :param patterns
  group: { title: string; color: GroupColor; collapsed?: boolean };  // title may use {param}
  sortGroups?: 'creation' | 'alphabetical';
  dedupe?: DedupeMode;                        // per-rule override
  strict?: boolean;   // default true: ungroup a tab when its URL stops matching (Auto-Group Tabs "Strict")
  merge?: boolean;    // default false: one group across all windows; matching tabs move into the existing group's window (Auto-Group Tabs "Merge")
}
export type DedupeMode = 'always-switch' | 'ask' | 'off';
export interface DedupeSettings {
  mode: DedupeMode; keep: 'existing';         // new tab always closes (anti-goal)
  stripParams: string[]; stripFragment: boolean; ignoreTrailingSlash: boolean;
  canonicalizers: string[];                   // ids, e.g. ['githubPr']
  followFragment: boolean;                    // kept tab navigates to the new #fragment (default true)
  allowDuplicates: string[];                  // url patterns exempt from dedupe
  alwaysSwitchSites: string[];                // url patterns that skip the ask prompt and always switch (ask mode)
  includeIncognito: boolean;
  scope: 'all-windows' | 'same-window';       // default 'all-windows' (Tab Deduper dedupAllWindows)
  urlTransforms: { pattern: string; replacement: string; flags?: string }[];  // regex replace applied to the dedupe key, after canonicalizers
}
export interface Config { version: 1; groupRules: GroupRule[]; dedupe: DedupeSettings; }
export interface TabSnap { id: number; windowId: number; index: number; url: string; pendingUrl?: string;
  title: string; pinned: boolean; groupId: number; incognito: boolean; discarded: boolean; frozen?: boolean;
  active: boolean; audible: boolean; lastAccessed?: number;
  /** http(s)/data: favicon only; never a chrome:// URL. */
  favIconUrl?: string; }
export interface GroupSnap { id: number; windowId: number; title: string; color: GroupColor; collapsed: boolean; }
export interface WindowSnap { id: number; type: 'normal'|'popup'|'app'|'devtools'; focused: boolean; }
export interface Snapshot { tabs: TabSnap[]; groups: GroupSnap[]; windows: WindowSnap[]; }
export type Op =
  // ruleId (group/ungroup/moveTabs): the rule that moved the tabs in, or whose group they no longer match (why-log).
  | { kind: 'group'; tabIds: number[]; windowId: number; title: string; color: GroupColor; existingGroupId?: number; collapsed?: boolean; ruleId?: string }
  | { kind: 'ungroup'; tabIds: number[]; ruleId?: string }
  | { kind: 'moveTabs'; tabIds: number[]; windowId: number; groupId: number; ruleId?: string }   // merge rules
  | { kind: 'moveGroup'; groupId: number; index: number }
  | { kind: 'updateGroup'; groupId: number; color?: GroupColor; collapsed?: boolean }
  | { kind: 'closeTab'; tabId: number; reason: string; ruleId?: string }
  | { kind: 'focusTab'; tabId: number; windowId: number; url?: string };
