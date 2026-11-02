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
import { adapterValue } from '../adapters';
import { extractJiraKeys } from '../keys/jira-key';
import { MAX_MATCH_INPUT } from '../match/pattern';
import { renderTemplate } from '../match/template';
import { isExemptUrl } from '../url/normalize';
import { parseDuration } from './duration';
import { evalCond, type CondScope } from './cond';
import type { DedupeMode, GroupColor } from '../types';
import type { CloseMode, CompiledRule, Cond, ExtractSpec, Program, TabFacts } from './types';

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
/**
 * One `assignProject` candidate (M3): the key rendered with the rule's vars; `index` is the rule's priority.
 * `summary`: the rule's `summary` var (an extract), when non-empty; T14's resolveProjects reports it for the project.
 */
export interface ProjectCandidate { key: string; ruleKey: string; index: number; create: boolean; summary?: string }
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
  /** M3: every matching `assignProject` (key rendered non-empty), in priority order; T14 picks among them. */
  project?: ProjectCandidate[];
  /** Every matching rule key, in priority order (the conflict view). */
  matched: string[];
  /** Some rule's outcome depends on page facts (pageText, a selector or adapter extract) that `f.page` does not have yet. */
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

/** A source field's text for the rule `ruleKey`, or '' when missing or not a string. */
function sourceText(f: TabFacts, ruleKey: string, name: string): string {
  const data = f.source && Object.prototype.hasOwnProperty.call(f.source, ruleKey) ? f.source[ruleKey]?.data : undefined;
  const v = data && Object.prototype.hasOwnProperty.call(data, name) ? data[name] : undefined;
  return typeof v === 'string' ? v : '';
}

/** A selector or `{adapter, field}` extract: its value comes from the page facts. */
export const isPageExtract = (x: ExtractSpec): boolean => 'selector' in x || 'adapter' in x;

/**
 * One extract value, or undefined. A selector value comes from the page facts under `<ruleKey>.<name>`; an adapter
 * field is parsed by the adapter from its `adapter:<id>.<field>` page facts (core/adapters).
 */
function extractValue(key: string, name: string, x: ExtractSpec, f: TabFacts): string | undefined {
  if ('selector' in x) return f.page?.extracts[`${key}.${name}`];
  if ('adapter' in x) return f.page ? adapterValue(x.adapter, x.field, f.page.extracts) : undefined;
  if ('jiraKey' in x) {
    // A `source.<name>` text is the rule's source field; a headRefName one is a branch name (case-insensitive, `_` separates).
    const text = x.from === 'url' ? (f.tab.pendingUrl ?? f.tab.url)
      : x.from === 'title' ? f.tab.title
      : sourceText(f, key, x.from.slice('source.'.length));
    return extractJiraKeys(text, { ...x.jiraKey, branch: x.from.endsWith('headRefName') })[0]; // first key = prefer order (M3-R21)
  }
  const re = regex(x.regex);
  if (!re) return undefined;
  const input = (x.from === 'url' ? (f.tab.pendingUrl ?? f.tab.url) : f.tab.title).slice(0, MAX_MATCH_INPUT);
  const m = re.exec(input);
  if (!m) return undefined;
  if (x.group === undefined) return m[1] ?? m[0];
  return m.groups?.[x.group] ?? (/^\d+$/.test(x.group) ? m[Number(x.group)] : undefined);
}

/** The rule's extract values (no captures). */
function extractsOf(r: CompiledRule, f: TabFacts): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, x] of Object.entries(r.rule.extract ?? {})) {
    const v = extractValue(r.key, name, x, f);
    if (v !== undefined) vars[name] = v;
  }
  return vars;
}

function varsOf(r: CompiledRule, captures: Record<string, string>, f: TabFacts): { vars: Record<string, string>; needsPage: boolean } {
  const needsPage = !f.page && Object.values(r.rule.extract ?? {}).some(isPageExtract);
  return { vars: { ...captures, ...extractsOf(r, f) }, needsPage };
}

function condReadsExtracts(c: Cond): boolean {
  if (typeof c !== 'object' || c === null) return false;
  if ('field' in c) return typeof c.field?.field === 'string' && c.field.field.startsWith('extract.');
  if ('all' in c) return Array.isArray(c.all) && c.all.some(condReadsExtracts);
  if ('any' in c) return Array.isArray(c.any) && c.any.some(condReadsExtracts);
  if ('not' in c) return condReadsExtracts(c.not);
  return false; // not under opener: fields there are unknown
}

const readsExtracts = new WeakMap<CompiledRule['rule'], boolean>();

/**
 * The evalCond scope of rule `r` for facts `f` (M3-R10): its key and, when its match reads `extract.<name>` fields,
 * the extract values computed before the match (selector and adapter ones from page facts, named in `pageVars`).
 */
export function condScope(r: CompiledRule, f: TabFacts): CondScope {
  let reads = readsExtracts.get(r.rule);
  if (reads === undefined) readsExtracts.set(r.rule, (reads = condReadsExtracts(r.rule.match)));
  if (!reads) return { ruleKey: r.key };
  const pageVars = new Set(Object.entries(r.rule.extract ?? {}).filter(([, x]) => isPageExtract(x)).map(([n]) => n));
  return { ruleKey: r.key, vars: extractsOf(r, f), pageVars };
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
    const c = evalCond(r.rule.match, f, now, condScope(r, f));
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
      } else if ('assignProject' in a) {
        const key = renderTemplate(a.assignProject.key, vars, p.tables);
        const summary = vars.summary;
        if (key !== '') {
          (out.project ??= []).push({
            key, ruleKey: r.key, index: r.index, create: a.assignProject.create ?? false, ...(summary ? { summary } : {}),
          });
        }
      }
    }
  }
  return out;
}
