import type { DedupeAction, RecipeRef, Rule } from './lang/types';
export type { Action, Cond, RecipeRef, Rule } from './lang/types';

export type GroupColor = 'grey'|'blue'|'red'|'yellow'|'green'|'pink'|'purple'|'cyan'|'orange';
/** M1 group rule: the v1 config's rule shape and the Auto-Group Tabs importer's output (see migrate.ts groupRuleToRule). */
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
/**
 * Per-rule dedupe override (ruling R25): the winning rule's dedupe action (evaluateTab().dedupe). Set fields win over
 * the DedupeSettings (keepFragment: normalize.ts; matchTitle: find.ts matchTitleFor, after a matching titleOverrides entry).
 */
export type DedupeOverride = DedupeAction;
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
  fragmentOverrides: { pattern: string; keepFragment: boolean }[];  // per-URL-pattern override of stripFragment (M2 T18)
  matchTitle: boolean;                                              // duplicates must also have equal titles (M2 T18)
  titleOverrides: { pattern: string; matchTitle: boolean }[];       // per-URL-pattern override of matchTitle (M2 T18)
}
/** Dedupe settings as stored by M1 (before the M2 fields). */
export type DedupeSettingsV1 = Omit<DedupeSettings, 'fragmentOverrides' | 'matchTitle' | 'titleOverrides'>;
/** M1 config; kept for migration (migrate.ts) and old backups only. */
export interface ConfigV1 { version: 1; groupRules: GroupRule[]; dedupe: DedupeSettingsV1; }
export interface ConfigV2 {
  version: 2; rules: Rule[]; recipes: RecipeRef[];
  /** Rule keys ('user/<id>' | '<recipeId>/<id>'); priority = tab-bar order. Missing keys are appended at compile time. */
  order: string[];
  /** M4: named sections of user rules (by rule id), display only; priority stays `order`. Absent = none. */
  sections?: Section[];
  tables: Record<string, Record<string, string>>; dedupe: DedupeSettings; dryRun: boolean;
}
/** A named section on the Rules page: user rule ids (R38 pattern); a rule is in at most one section. */
export interface Section { id: string; name: string; rules: string[] }
export type Config = ConfigV2;
export interface TabSnap { id: number; windowId: number; index: number; url: string; pendingUrl?: string;
  title: string; pinned: boolean; groupId: number; incognito: boolean; discarded: boolean; frozen?: boolean;
  active: boolean; audible: boolean; lastAccessed?: number;
  /** chrome.tabs.Tab.status: 'loading' until the page (and its final title) has loaded. */
  status?: 'loading' | 'complete' | 'unloaded';
  /** The tab that opened this one (chrome.tabs.Tab.openerTabId), when Chrome reports it. */
  openerTabId?: number;
  /** http(s)/data: favicon only; never a chrome:// URL. */
  favIconUrl?: string;
  /**
   * When the tab was created (engine TabAges, M3-R2). `exact: false` means a lower bound: the tab is at least
   * `now - at` old (restored at startup, discarded, or first seen after a browser restart / install). Absent = unknown.
   */
  created?: { at: number; exact: boolean }; }
export interface GroupSnap { id: number; windowId: number; title: string; color: GroupColor; collapsed: boolean; }
export interface WindowSnap { id: number; type: 'normal'|'popup'|'app'|'devtools'; focused: boolean; }
export interface Snapshot { tabs: TabSnap[]; groups: GroupSnap[]; windows: WindowSnap[]; }
export type Op =
  // ruleId is a rule key ('user/<id>' | '<recipeId>/<id>', ruling R19).
  // ruleId (group/ungroup/moveTabs): the rule that moved the tabs in, or whose group they no longer match (why-log).
  | { kind: 'group'; tabIds: number[]; windowId: number; title: string; color: GroupColor; existingGroupId?: number; collapsed?: boolean; ruleId?: string }
  | { kind: 'ungroup'; tabIds: number[]; ruleId?: string }
  | { kind: 'moveTabs'; tabIds: number[]; windowId: number; groupId: number; ruleId?: string }   // merge rules
  | { kind: 'moveGroup'; groupId: number; index: number }
  | { kind: 'updateGroup'; groupId: number; title?: string; color?: GroupColor; collapsed?: boolean }
  | { kind: 'closeTab'; tabId: number; reason: string; ruleId?: string }
  | { kind: 'focusTab'; tabId: number; windowId: number; url?: string };
