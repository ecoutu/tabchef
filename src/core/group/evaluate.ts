// The group target of one tab under a compiled Program (M2 T6): a thin wrapper over evaluateTab(...).group.
// The pinned/exempt skips and "an empty rendered title is no match" invariants live in evaluateTab (ruling R7).
import { evaluateTab, type GroupResult } from '../lang/evaluate';
import type { Program, TabFacts } from '../lang/types';
import type { TabSnap } from '../types';

/**
 * M1's GroupMatch plus the M2 fields. `ruleId` is the rule key (= `key`, ruling R19) and `ruleIndex` its priority
 * (= `index`), so the planner keeps using the M1 names.
 */
export interface GroupTarget extends GroupResult {
  ruleId: string;
  ruleIndex: number;
  /**
   * M3 (project targets, T14): with no group of exactly `title` in the window, a managed group whose title this
   * accepts is adopted and renamed (`updateGroup{title}`) instead of creating a second group.
   */
  titleMatches?: (title: string) => boolean;
}
/** M1 name, kept for the planner. */
export type GroupMatch = GroupTarget;

/**
 * The winning group action for `tab` (highest-priority matching rule with a non-empty title), or null. Pure.
 * `facts` adds what the snapshot alone does not say (opener, current group title, creation time, page facts).
 */
export function evaluateGroupRules(tab: TabSnap, p: Program, facts?: Partial<TabFacts>, now: number = Date.now()): GroupTarget | null {
  return evaluateGroup(tab, p, facts, now).target;
}

/** evaluateGroupRules plus whether the group outcome could still change once page facts arrive (EvalResult.groupNeedsPage). */
export function evaluateGroup(tab: TabSnap, p: Program, facts?: Partial<TabFacts>, now: number = Date.now()): { target: GroupTarget | null; needsPage: boolean } {
  const r = evaluateTab(p, { ...facts, tab }, now);
  const g = r.group;
  return { target: g ? { ...g, ruleId: g.key, ruleIndex: g.index } : null, needsPage: r.groupNeedsPage };
}
