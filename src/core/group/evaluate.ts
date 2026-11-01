import { isExemptUrl } from '../url/normalize';
import { compilePattern, PatternError } from '../match/pattern';
import { renderTemplate } from '../match/template';
import type { GroupColor, GroupRule, TabSnap } from '../types';

export interface GroupMatch {
  ruleId: string;
  ruleIndex: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  sortGroups: 'creation' | 'alphabetical';
  strict: boolean;
  merge: boolean;
}

function firstCaptures(patterns: string[], url: string): Record<string, string> | null {
  for (const p of patterns) {
    try {
      const caps = compilePattern(p)(url);
      if (caps) return caps;
    } catch (e) {
      if (!(e instanceof PatternError)) throw e;
    }
  }
  return null;
}

/** First enabled rule (array order = priority) matching the tab with a non-empty title, or null. Pure. */
export function evaluateGroupRules(tab: TabSnap, rules: GroupRule[]): GroupMatch | null {
  if (tab.pinned) return null;
  const url = tab.pendingUrl ? tab.pendingUrl : tab.url;
  if (isExemptUrl(url)) return null;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as GroupRule;
    if (!rule.enabled) continue;
    const patterns = Array.isArray(rule.match.url) ? rule.match.url : [rule.match.url];
    const caps = firstCaptures(patterns, url);
    if (!caps) continue;
    const title = renderTemplate(rule.group.title, caps);
    if (title === '') continue; // an empty title would adopt the user's untitled groups: no match
    return {
      ruleId: rule.id,
      ruleIndex: i,
      title,
      color: rule.group.color,
      collapsed: rule.group.collapsed ?? false,
      sortGroups: rule.sortGroups ?? 'creation',
      strict: rule.strict ?? true,
      merge: rule.merge ?? false,
    };
  }
  return null;
}
