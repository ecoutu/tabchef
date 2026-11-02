// Evaluates one tab against a compiled Program (M2 T4). Pure: no browser access, no logging, never throws.
//
// For each action kind the first matching rule (priority order) that has that kind wins, so the group, dedupe and
// close results may come from different rules. `views` collects every matching showInView. Template vars are the
// condition captures (url `:params`, url/title regex named groups) plus the rule's `extract` values.
//
// Group invariants (R7, as M1 src/core/group/evaluate.ts): a pinned tab or an exempt URL never gets a group, and a
// title that renders to '' skips that rule for the group kind (an empty title would adopt the user's untitled
// groups); evaluation continues to the next matching rule with a group action.
import { COLORS } from '../config/schema';
import { MAX_MATCH_INPUT } from '../match/pattern';
import { renderTemplate } from '../match/template';
import { isExemptUrl } from '../url/normalize';
import { parseDuration } from './duration';
import { evalCond } from './cond';
import type { DedupeMode, GroupColor } from '../types';
import type { CloseMode, CompiledRule, ExtractSpec, Program, TabFacts } from './types';

export interface GroupResult {
  key: string; index: number; title: string; color: GroupColor; collapsed: boolean;
  sortGroups: 'creation' | 'alphabetical'; strict: boolean; merge: boolean; dryRun: boolean;
  /** Anchor URLs rendered with the tab's vars (not yet checked: the AnchorService opens only http(s) ones). */
  anchors: string[];
  /** The color rendered outside the 9 Chrome colors and fell back to grey; the engine logs it (T6). */
  invalidColor?: true;
}
export interface DedupeResult { key: string; mode?: DedupeMode; followFragment?: boolean; keepFragment?: boolean; matchTitle?: boolean }
export interface CloseResult { key: string; afterMs: number; mode: CloseMode; dryRun: boolean }
/** No `notify` / `discard`: those actions do not exist in M2 (R26). */
export interface EvalResult {
  group?: GroupResult;
  dedupe?: DedupeResult;
  close?: CloseResult;
  views: string[];
  /**
   * Per view in `views`: the template vars (condition captures + extract values) of the first rule that put the tab
   * there. A view's `show`, `groupBy` and `sort` read them as `extract.<name>` (M2 T17). Absent when `views` is empty.
   */
  viewVars?: Record<string, Record<string, string>>;
  /** Every matching rule key, in priority order (the conflict view). */
  matched: string[];
  /** Some rule's outcome depends on page facts (pageText or a selector extract) that `f.page` does not have yet. */
  needsPage: boolean;
  /**
   * The group outcome itself may change once page facts arrive: the winning group rule rendered without a selector
   * extract, or a higher-priority rule with a group action could not be decided without the page. The planner holds
   * such a tab while its facts are on their way (M2 T7).
   */
  groupNeedsPage: boolean;
}

const regexCache = new Map<string, RegExp | null>();
function regex(source: string): RegExp | null {
  let re = regexCache.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source);
    } catch {
      re = null; // validation rejects these; a stale one is just no value
    }
    regexCache.set(source, re);
  }
  return re;
}

/** One extract value, or undefined. A selector value comes from the page facts under `<ruleKey>.<name>`. */
function extractValue(key: string, name: string, x: ExtractSpec, f: TabFacts): string | undefined {
  if ('selector' in x) return f.page?.extracts[`${key}.${name}`];
  const re = regex(x.regex);
  if (!re) return undefined;
  const input = (x.from === 'url' ? (f.tab.pendingUrl ?? f.tab.url) : f.tab.title).slice(0, MAX_MATCH_INPUT);
  const m = re.exec(input);
  if (!m) return undefined;
  if (x.group === undefined) return m[1] ?? m[0];
  return m.groups?.[x.group] ?? (/^\d+$/.test(x.group) ? m[Number(x.group)] : undefined);
}

function varsOf(r: CompiledRule, captures: Record<string, string>, f: TabFacts): { vars: Record<string, string>; needsPage: boolean } {
  const vars = { ...captures };
  let needsPage = false;
  for (const [name, x] of Object.entries(r.rule.extract ?? {})) {
    if ('selector' in x && !f.page) needsPage = true;
    const v = extractValue(r.key, name, x, f);
    if (v !== undefined) vars[name] = v;
  }
  return { vars, needsPage };
}

function afterMs(after: string | undefined): number {
  if (after === undefined) return 0;
  try {
    return parseDuration(after);
  } catch {
    return 0; // unreachable for validated rules
  }
}

/** Evaluate tab facts `f` at time `now` (ms) against program `p`. */
export function evaluateTab(p: Program, f: TabFacts, now: number): EvalResult {
  const out: EvalResult = { views: [], matched: [], needsPage: false, groupNeedsPage: false };
  const url = f.tab.pendingUrl ? f.tab.pendingUrl : f.tab.url;
  const groupable = !f.tab.pinned && !isExemptUrl(url);
  for (const r of p.rules) {
    const c = evalCond(r.rule.match, f, now);
    // Only a rule ahead of the group winner can still change the group outcome.
    const decidesGroup = groupable && !out.group && r.rule.actions.some((a) => 'group' in a);
    if (c.needsPage) {
      out.needsPage = true;
      if (decidesGroup) out.groupNeedsPage = true;
    }
    if (!c.ok) continue;
    out.matched.push(r.key);
    const { vars, needsPage } = varsOf(r, c.captures, f);
    if (needsPage) {
      out.needsPage = true;
      if (decidesGroup) out.groupNeedsPage = true;
    }
    for (const a of r.rule.actions) {
      if ('group' in a) {
        if (out.group || !groupable) continue;
        const title = renderTemplate(a.group.title, vars, p.tables);
        if (title === '') continue;
        const rendered = renderTemplate(a.group.color, vars, p.tables);
        const valid = COLORS.has(rendered);
        out.group = {
          key: r.key, index: r.index, title, color: (valid ? rendered : 'grey') as GroupColor,
          collapsed: a.group.collapsed ?? false, sortGroups: a.group.sortGroups ?? 'creation',
          strict: a.group.strict ?? true, merge: a.group.merge ?? false, anchors: (a.group.anchors ?? []).map((u) => renderTemplate(u, vars, p.tables)),
          dryRun: r.dryRun,
          ...(valid ? {} : { invalidColor: true as const }),
        };
      } else if ('dedupe' in a) {
        if (!out.dedupe) out.dedupe = { key: r.key, ...a.dedupe };
      } else if ('close' in a) {
        if (!out.close) out.close = { key: r.key, afterMs: afterMs(a.close.after), mode: a.close.mode ?? 'auto', dryRun: r.dryRun };
      } else if ('showInView' in a) {
        if (!out.views.includes(a.showInView.view)) {
          out.views.push(a.showInView.view);
          (out.viewVars ??= {})[a.showInView.view] = vars;
        }
      }
    }
  }
  return out;
}
