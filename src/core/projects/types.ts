// Project types (M3). T1 adds only ProjectDef, so `Recipe.project` can reference it (M3-R19); T14 adds Project and
// ProjectAssignment.
import type { PrState } from '../sources/types';
import type { GroupColor } from '../types';

export type Container = 'group' | 'window';
export type Placement = 'existing' | 'current' | 'new' | `home:${string}`;
export type JoinMode = 'rules' | 'opener' | 'window' | 'manual';

/** A recipe's project definition: how tabs it assigns (`assignProject`) are grouped into one project per key. */
export interface ProjectDef {
  recipeId: string;
  /** Template rendered with the assigning rule's vars. */
  key: string;
  /** Template, e.g. '{key}' or '{key} · {summary}'. */
  title: string;
  /** A Chrome group color or a template. */
  color: string;
  /** 'window' is declared (M4) but compileProgram rejects it until windows are implemented. */
  container: Container;
  join: JoinMode[];
  /** Where a new project's tabs go, first applicable wins. Default ['existing', 'current']. */
  placement: Placement[];
  /** A project tab opened outside its container. Default 'move-and-follow'. */
  onOpenElsewhere: 'move-and-follow' | 'move-silently' | 'leave';
  /** What happens to a project's tabs when the user leaves it. Default 'unload'. */
  onSwitchAway: 'unload' | 'minimize' | 'close-and-save';
  /** Default 'auto'. */
  start: 'auto' | 'on-request';
}

/** What a recipe's `project` may omit: compileProgram fills these defaults in. */
export type ProjectDefaults = Pick<ProjectDef, 'placement' | 'onOpenElsewhere' | 'onSwitchAway' | 'start'>;
export const PROJECT_DEFAULTS: ProjectDefaults = {
  placement: ['existing', 'current'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload', start: 'auto',
};

/** One tab of a project's saved tab list (M4 T7): what reopen restores. */
export interface SavedTab {
  url: string;
  title: string;
  /** The title of the Chrome group it was in (unset: in none, or an untitled one). */
  group?: string;
  pinned?: boolean;
}

/** One open project: tabs sharing a key (e.g. a Jira issue key) under one group. Stored by T15's ProjectStore. */
export interface Project {
  /** `${recipeId}:${key}`. */
  id: string;
  recipeId: string;
  key: string;
  /** The name the user gave a project they created (M4 T6, the `{name}` of its recipe's templates). */
  name?: string;
  /** The color of the Chrome group the project was saved from (M4 T8): wins over its recipe's color. */
  color?: GroupColor;
  /** Saved by the user (M4 T6: every Manual project; T7: close-and-save, Keep): never pruned, synced (D2). */
  keep?: boolean;
  /**
   * The project's saved tab list (M4 T7), in tab-bar order: set by close-and-save, and refreshed for a kept project by
   * every pass that sees its tabs, so closing its last tab by hand leaves the list of the last pass that saw tabs.
   * `closed`: set by close-and-save (M4-R14): while set, passes only grow the list (a new member at its tab-bar place)
   * and never remove from it. Cleared by reopen, or once the open tabs cover the list. removeTab drops its URL anyway.
   */
  saved?: { tabs: SavedTab[]; at: number; closed?: boolean };
  /**
   * Archived by the user (M4 T9): takes no tab (like a tombstone), is not in the popup and is never pruned. Unlike a
   * tombstone, a rule assigning its key does not bring it back (its tabs are only counted, `held`); unarchive, reopen or
   * the undo of its Close and archive do.
   */
  archivedAt?: number;
  /** Bumped on every user-visible change (M4 T7; D1 sync merges by it). A stored project without it reads as createdAt. */
  updatedAt: number;
  summary?: string;
  status?: { name: string; category: 'new' | 'indeterminate' | 'done'; via: 'api' | 'page' | 'title' };
  createdAt: number;
  /** Tabs the user added; they win over rules. */
  manual: { url: string; windowId: number; tabId?: number }[];
  /** Normalized URLs the user removed: they never join this project by rules. */
  excluded: string[];
  linked: { url: string; title: string; state: PrState }[];
  linkedFetchedAt?: number;
  /**
   * The host of the first ticket tab (a tab joined by a `jira.issue` rule) seen in this project, e.g.
   * 'other.atlassian.net' (M3-R110): the Jira connection is asked for its status only when this is its site (or a
   * tab is on that site). Unset (a project started by a PR, or stored before R110): the connected site's.
   */
  site?: string;
  /** Browser running time (ms) without an open tab, counted by T15's passes; pruned on startup once 7 days. */
  closedFor?: number;
  /**
   * Tombstone (M3-R84): set by Close group. A tombstoned project takes no tab by its manual entries, is hidden from the
   * UI and is pruned like any project without tabs; undo of one of `closedIds` (its recently-closed entries), or a rule
   * assigning its key again, revives it with its manual entries, linked PRs and summary.
   */
  closedAt?: number;
  closedIds?: string[];
}

/** One project as listed to the UI (`projects.list`, T15); T17's buildProjectCards shapes it into a card. */
export interface ProjectCardData {
  id: string; key: string; title: string; summary?: string;
  /** Best first: the Jira API (or its page read), the ticket tab's own source entry, the last stored status. */
  status?: NonNullable<Project['status']>;
  /** The status is Done by fresh data (via api or page, not stale, M3-R90); a stale or stored Done is only shown. */
  done: boolean;
  tabs: { tabId: number; windowId: number; title: string; url: string; favIconUrl?: string; lastAccessed?: number; pill?: PrState; stale?: boolean }[];
  /** Linked PRs not open in the project. */
  linked: Project['linked'];
}

/** One project's home page (`projects.home`, M4 T4): its card data plus its groups, settings and recipe's name. */
export interface ProjectHomeData extends ProjectCardData {
  /**
   * The project's tabs by Chrome group, in tab-bar order: windows in snapshot order, then the lowest tab index; tabs in
   * index order. Tabs not in a group form one entry per window with an empty title and grey.
   */
  groups: { title: string; color: GroupColor; windowId: number; tabIds: number[] }[];
  /** Unset when its recipe is off (`recipeOff`). */
  settings?: Pick<ProjectDef, 'container' | 'placement' | 'join' | 'onOpenElsewhere' | 'onSwitchAway'>;
  /** The name of the recipe that defines the project (its id when unknown). */
  recipeName: string;
  /** M4 T9: its recipe is off (or gone): the stored data only, no settings; it cannot be reopened until it is on. */
  recipeOff?: true;
  /** M4 T7: kept (never pruned, synced) and its saved tab list. A kept project with no open tab has no groups. */
  keep?: boolean;
  saved?: Project['saved'];
  /** M4 T9: archived at (no tabs, no groups), and how many open tabs a rule assigns its key to ("Archived: reopen?"). */
  archivedAt?: number;
  held?: number;
}

/** A project with nothing open, as the Projects page's Saved and Archived sections list it (M4 T9, `projects.savedLists`). */
export interface SavedProjectData {
  id: string; key: string; title: string; summary?: string;
  status?: NonNullable<Project['status']>;
  /** Tabs in its saved tab list (what Reopen opens). */
  savedCount: number;
  archivedAt?: number;
  /** Open tabs a rule assigns an archived project's key to: they stay out of it until it is reopened or unarchived. */
  held: number;
  updatedAt: number;
}

/** Why a tab is in a project. `index` is the assigning rule's priority (-1 for manual: it wins over every rule). */
export interface ProjectAssignment { projectId: string; key: string; via: 'rule' | 'manual'; ruleKey?: string; index: number }
