// Project types (M3). T1 adds only ProjectDef, so `Recipe.project` can reference it (M3-R19); T14 adds Project and
// ProjectAssignment.
import type { PrState } from '../sources/types';

/** A recipe's project definition: how tabs it assigns (`assignProject`) are grouped into one project per key. */
export interface ProjectDef {
  recipeId: string;
  /** Template rendered with the assigning rule's vars. */
  key: string;
  /** Template, e.g. '{key}' or '{key} · {summary}'. */
  title: string;
  /** A Chrome group color or a template. */
  color: string;
  container: 'group';
  join: ('rules' | 'manual')[];
}

/** One open project: tabs sharing a key (e.g. a Jira issue key) under one group. Stored by T15's ProjectStore. */
export interface Project {
  /** `${recipeId}:${key}`. */
  id: string;
  recipeId: string;
  key: string;
  summary?: string;
  status?: { name: string; category: 'new' | 'indeterminate' | 'done'; via: 'api' | 'page' | 'title' };
  createdAt: number;
  /** Tabs the user added; they win over rules. */
  manual: { url: string; windowId: number; tabId?: number }[];
  /** Normalized URLs the user removed: they never join this project by rules. */
  excluded: string[];
  linked: { url: string; title: string; state: PrState }[];
  linkedFetchedAt?: number;
  /** Browser running time (ms) without an open tab, counted by T15's passes; pruned on startup once 7 days. */
  closedFor?: number;
}

/** One project as listed to the UI (`projects.list`, T15); T17's buildProjectCards shapes it into a card. */
export interface ProjectCardData {
  id: string; key: string; title: string; summary?: string;
  /** Best first: the Jira API (or its page read), the ticket tab's own source entry, the last stored status. */
  status?: NonNullable<Project['status']>;
  done: boolean;
  tabs: { tabId: number; windowId: number; title: string; url: string; favIconUrl?: string; lastAccessed?: number; pill?: PrState; stale?: boolean }[];
  /** Linked PRs not open in the project. */
  linked: Project['linked'];
}

/** Why a tab is in a project. `index` is the assigning rule's priority (-1 for manual: it wins over every rule). */
export interface ProjectAssignment { projectId: string; key: string; via: 'rule' | 'manual'; ruleKey?: string; index: number }
