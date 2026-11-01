import type { Config, GroupRule, TabSnap } from '../core/types';
import { compilePattern } from '../core/match/pattern';

export function reorderRules(c: Config, from: number, to: number): Config {
  const n = c.groupRules.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return c;
  const rules = c.groupRules.slice();
  const [moved] = rules.splice(from, 1);
  rules.splice(to, 0, moved!);
  return { ...c, groupRules: rules };
}

export function addRule(c: Config, partial: Partial<GroupRule> = {}): Config {
  const rule: GroupRule = {
    id: crypto.randomUUID(), name: 'New rule', enabled: true,
    match: { url: '' }, group: { title: 'New group', color: 'blue' },
    ...partial,
  };
  return { ...c, groupRules: [...c.groupRules, rule] };
}

export function updateRule(c: Config, id: string, patch: Partial<GroupRule>): Config {
  if (!c.groupRules.some((r) => r.id === id)) return c;
  return { ...c, groupRules: c.groupRules.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

export function removeRule(c: Config, id: string): Config {
  return { ...c, groupRules: c.groupRules.filter((r) => r.id !== id) };
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
  c.groupRules.forEach((r, i) => {
    if (Array.isArray(r.match.url)) r.match.url.forEach((p, j) => check(`/groupRules/${i}/match/url/${j}`, p));
    else check(`/groupRules/${i}/match/url`, r.match.url);
  });
  c.dedupe.allowDuplicates.forEach((p, i) => check(`/dedupe/allowDuplicates/${i}`, p));
  c.dedupe.alwaysSwitchSites.forEach((p, i) => check(`/dedupe/alwaysSwitchSites/${i}`, p));
  return out;
}

/**
 * Server errors look like "/groupRules/2/group/color must be ...".
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
  '^/(groupRules/\\d+/(name|enabled|match/url(/\\d+)?|group/title|group/color|group/collapsed|sortGroups|dedupe|strict|merge)'
  + '|dedupe/(mode|scope|stripFragment|ignoreTrailingSlash|followFragment|includeIncognito|(stripParams|allowDuplicates|alwaysSwitchSites)(/\\d+)?))$',
);

/** Server errors that no form field displays inline (shown in the summary instead). */
export function unclaimedErrors(errors: string[]): string[] {
  return errors.filter((e) => {
    const sp = e.indexOf(' ');
    return !FIELD_PATH.test(sp < 0 ? e : e.slice(0, sp));
  });
}
