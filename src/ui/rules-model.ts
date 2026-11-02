import type { Config, GroupRule, TabSnap } from '../core/types';
import type { Rule } from '../core/lang/types';
import { compilePattern } from '../core/match/pattern';
import { asGroupRule, orderedUserRules } from '../core/config/group-view';
import { groupRuleToRule, sanitizeRuleId, userKey } from '../core/config/migrate';

// The Rules page edits v2 user rules through the M1 form fields (ruling R3). A rule the form cannot express
// (asGroupRule returns null) is shown read-only until M2 T15. Display order = priority = `order`.

export { orderedUserRules } from '../core/config/group-view';

/** The form view of a rule, or null when the form cannot edit it. */
export const formRule = (r: Rule): GroupRule | null => asGroupRule(r);

/** Index of the rule in `c.rules` (server error paths use it), or -1. */
export const ruleIndex = (c: Config, id: string): number => c.rules.findIndex((r) => r.id === id);

/** JSON pointers (under /rules/<i>) of the form's group and dedupe actions of a rule. */
export function actionPaths(r: Rule): { group: string; dedupe: string } {
  const g = r.actions.findIndex((a) => 'group' in a);
  const d = r.actions.findIndex((a) => 'dedupe' in a);
  return { group: `actions/${g < 0 ? 0 : g}/group`, dedupe: `actions/${d < 0 ? r.actions.length : d}/dedupe` };
}

/**
 * Moves the user rule at display position `from` to `to` (positions in orderedUserRules). Only `order` changes:
 * the slots user keys hold in it are refilled in the new sequence; recipe keys keep their places.
 */
export function reorderRules(c: Config, from: number, to: number): Config {
  const keys = orderedUserRules(c).map((r) => userKey(r.id));
  const n = keys.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return c;
  const [moved] = keys.splice(from, 1);
  keys.splice(to, 0, moved!);
  const userKeys = new Set(keys);
  const queue = [...keys];
  const order = c.order.map((k) => (userKeys.has(k) ? queue.shift()! : k));
  return { ...c, order: [...order, ...queue] };
}

export function addRule(c: Config, partial: Partial<GroupRule> = {}): Config {
  const id = sanitizeRuleId(crypto.randomUUID(), new Set(c.rules.map((r) => r.id)));
  const g: GroupRule = {
    id, name: 'New rule', enabled: true,
    match: { url: '' }, group: { title: 'New group', color: 'blue' },
    ...partial,
  };
  const rule = groupRuleToRule(g, id);
  return { ...c, rules: [...c.rules, rule], order: [...c.order.filter((k) => k !== userKey(id)), userKey(id)] };
}

/** Applies a form patch (M1 fields) to a form-editable rule; other rules and unknown ids leave `c` unchanged. */
export function updateRule(c: Config, id: string, patch: Partial<GroupRule>): Config {
  const i = ruleIndex(c, id);
  const g = i < 0 ? null : asGroupRule(c.rules[i]!);
  if (!g) return c;
  const rules = c.rules.slice();
  rules[i] = groupRuleToRule({ ...g, ...patch, id }, id);
  return { ...c, rules };
}

export function removeRule(c: Config, id: string): Config {
  return { ...c, rules: c.rules.filter((r) => r.id !== id), order: c.order.filter((k) => k !== userKey(id)) };
}

const patterns = (rule: GroupRule): string[] => (Array.isArray(rule.match.url) ? rule.match.url : [rule.match.url]);

export function previewMatches(rule: GroupRule, tabs: TabSnap[]): TabSnap[] {
  const matchers = patterns(rule).filter((p) => p !== '').flatMap((p) => {
    try { return [compilePattern(p)]; } catch { return []; }
  });
  return tabs.filter((t) => matchers.some((m) => m(t.url) !== null));
}

/** Error message for a pattern that does not compile, else undefined. */
export function patternError(p: string): string | undefined {
  try { compilePattern(p); return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

export interface PathError { path: string; message: string }

/** Client-side pattern errors for every pattern field, keyed by JSON path. */
export function configPatternErrors(c: Config): PathError[] {
  const out: PathError[] = [];
  const check = (path: string, p: string): void => {
    const m = patternError(p);
    if (m) out.push({ path, message: m });
  };
  c.rules.forEach((r, i) => {
    if (!('url' in r.match)) return;
    if (Array.isArray(r.match.url)) r.match.url.forEach((p, j) => check(`/rules/${i}/match/url/${j}`, p));
    else check(`/rules/${i}/match/url`, r.match.url);
  });
  c.dedupe.allowDuplicates.forEach((p, i) => check(`/dedupe/allowDuplicates/${i}`, p));
  c.dedupe.alwaysSwitchSites.forEach((p, i) => check(`/dedupe/alwaysSwitchSites/${i}`, p));
  return out;
}

/**
 * Server errors look like "/rules/2/actions/0/group/color must be ...".
 * Exact path -> the message; deeper path -> "rest message".
 */
export function errorsForPath(errors: string[], path: string): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const sp = e.indexOf(' ');
    const p = sp < 0 ? e : e.slice(0, sp);
    const msg = sp < 0 ? '' : e.slice(sp + 1);
    if (p === path) out.push(msg);
    else if (p.startsWith(`${path}/`)) out.push(`${p.slice(path.length + 1)} ${msg}`);
  }
  return out;
}

const FIELD_PATH = new RegExp(
  '^/(rules/\\d+/(name|enabled|match/url(/\\d+)?|actions/\\d+/group/(title|color|collapsed|sortGroups|strict|merge)|actions/\\d+/dedupe(/mode)?)'
  + '|dedupe/(mode|scope|stripFragment|ignoreTrailingSlash|followFragment|includeIncognito|(stripParams|allowDuplicates|alwaysSwitchSites)(/\\d+)?))$',
);

/** Server errors that no form field displays inline (shown in the summary instead). */
export function unclaimedErrors(errors: string[]): string[] {
  return errors.filter((e) => {
    const sp = e.indexOf(' ');
    return !FIELD_PATH.test(sp < 0 ? e : e.slice(0, sp));
  });
}
