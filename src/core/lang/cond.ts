// Condition evaluator for the M2 rule language (`Rule.match`). Pure: no browser access; the caller resolves facts.
import { compilePattern, compileTextPattern } from '../match/pattern';
import type { Matcher } from '../match/pattern';
import { parseDuration } from './duration';
import { foldText } from './fold-text';
import type { Comparison, Cond, Rule, Show, TabFacts } from './types';

export interface CondResult {
  ok: boolean;
  /** Captures from matched `url` patterns (and title regex named groups); the first match wins. */
  captures: Record<string, string>;
  /** True when the result depended on `pageText` and `f.page` was undefined. `ok` is then false. */
  needsPage: boolean;
  /**
   * Set (true) when the result depended on a fact that is unknown and that the page cannot supply (an `age` whose
   * `tab.created` is absent or too low a lower bound, R66 / M3-R3). `ok` is then false, and `not` keeps it false: an
   * unknown is never negated into a match.
   */
  unknown?: true;
}

/**
 * What a `field` condition reads besides the tab facts (M3-R10): the rule key (its `f.source` entry) and the rule's
 * extract values computed before the match (`vars`). `pageVars` names the selector extracts whose value comes from
 * page facts: while `f.page` is undefined, an `extract.<name>` field on one of them needs the page.
 */
export interface CondScope { ruleKey: string; vars?: Record<string, string>; pageVars?: ReadonlySet<string> }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const no = (needsPage = false, unknown = false): CondResult =>
  (unknown ? { ok: false, captures: {}, needsPage, unknown: true } : { ok: false, captures: {}, needsPage });
const yes = (captures: Record<string, string> = {}): CondResult => ({ ok: true, captures, needsPage: false });
const bool = (b: boolean): CondResult => (b ? yes() : no());

/** Run a pattern; a pattern that does not compile (schema validation rejects those) is a non-match, never a throw. */
function run(compile: (p: string) => Matcher, p: unknown, input: string): Record<string, string> | null {
  if (typeof p !== 'string') return null;
  try {
    return compile(p)(input);
  } catch {
    return null;
  }
}

/** Evaluate one condition against a tab's facts at time `now` (ms). Never throws. */
export function evalCond(c: Cond, f: TabFacts, now: number, scope?: CondScope): CondResult {
  if (typeof c !== 'object' || c === null) return no();
  const keys = Object.keys(c);
  if (keys.length !== 1) return no();
  const v = (c as Record<string, unknown>)[keys[0] as string];
  switch (keys[0]) {
    case 'all': {
      if (!Array.isArray(v)) return no();
      let captures: Record<string, string> = {};
      let needsPage = false;
      let unknown = false;
      for (const sub of v as Cond[]) {
        const r = evalCond(sub, f, now, scope);
        if (r.ok) captures = { ...r.captures, ...captures };
        else if (r.needsPage || r.unknown) { needsPage ||= r.needsPage; unknown ||= r.unknown === true; }
        else return no(); // definitely false: the page can't change that
      }
      return needsPage || unknown ? no(needsPage, unknown) : yes(captures);
    }
    case 'any': {
      if (!Array.isArray(v)) return no();
      let needsPage = false;
      let unknown = false;
      for (const sub of v as Cond[]) {
        const r = evalCond(sub, f, now, scope);
        if (r.ok) return yes(r.captures);
        needsPage ||= r.needsPage;
        unknown ||= r.unknown === true;
      }
      return no(needsPage, unknown);
    }
    case 'not': {
      const r = evalCond(v as Cond, f, now, scope);
      return r.needsPage || r.unknown ? no(r.needsPage, r.unknown === true) : bool(!r.ok);
    }
    case 'url': {
      const url = f.tab.pendingUrl ?? f.tab.url; // matchers truncate to MAX_MATCH_INPUT
      for (const p of Array.isArray(v) ? v : [v]) {
        const caps = run(compilePattern, p, url);
        if (caps) return yes(caps);
      }
      return no();
    }
    case 'title': {
      const caps = run(compileTextPattern, v, f.tab.title);
      return caps ? yes(caps) : no();
    }
    case 'opener': {
      if (!f.opener) return no();
      // Only the opener's tab is known; its page is never fetched, so pageText under opener is just false. Fields
      // describe this tab, not the opener: no scope, so a field under opener is unknown.
      const r = evalCond(v as Cond, { tab: f.opener }, now);
      return r.ok ? yes(r.captures) : no(false, r.unknown === true); // an unknown opener age stays unknown (R66)
    }
    case 'group':
      return bool(f.groupTitle !== undefined && f.groupTitle === v);
    case 'pinned':
      return bool(f.tab.pinned === v);
    case 'audible':
      return bool(f.tab.audible === v);
    case 'age': {
      if (typeof v !== 'object' || v === null) return no();
      const { gt, lt } = v as { gt?: unknown; lt?: unknown };
      if (gt === undefined && lt === undefined) return no();
      const created = f.tab.created;
      if (created === undefined) return no(false, true); // unknown, not false (R66)
      const age = now - created.at;
      // Not exact: `age` is a lower bound (the tab is at least that old), so `gt` can only become true and `lt` only
      // false; anything else is unknown (M3-R3). Every verdict agrees with the true age.
      let unknown = false;
      try {
        if (gt !== undefined && !(age > parseDuration(gt as string))) {
          if (created.exact) return no();
          unknown = true;
        }
        if (lt !== undefined && !(age < parseDuration(lt as string))) return no();
        if (lt !== undefined && !created.exact) unknown = true;
      } catch {
        return no();
      }
      return unknown ? no(false, true) : yes();
    }
    case 'pageText': {
      const needles = (Array.isArray(v) ? v : [v]).filter((n): n is string => typeof n === 'string' && n !== '');
      if (!needles.length) return no();
      if (!f.page) return no(true);
      const texts = f.page.texts.map(foldText);
      return bool(needles.some((n) => texts.some((t) => t.includes(foldText(n)))));
    }
    case 'field':
      return evalField(v, f, now, scope);
    default:
      return no();
  }
}

/**
 * An ISO-8601 date-time with a zone (`2024-05-12T10:00Z`, `…:00.000Z`, `…+02:00`, and Jira's colonless `…+0000`):
 * the only strings `{ago}` reads as dates.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const isScalar = (x: unknown): x is string | number | boolean | null =>
  x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';

/** A field's value; undefined when missing (no scope, no source entry or data, no such field or extract). */
function fieldValue(name: string, f: TabFacts, scope: CondScope): unknown {
  const dot = name.indexOf('.');
  const kind = name.slice(0, dot);
  const n = name.slice(dot + 1);
  const own = (o: object | undefined) => o !== undefined && Object.prototype.hasOwnProperty.call(o, n);
  if (kind === 'source') {
    const data = f.source && Object.prototype.hasOwnProperty.call(f.source, scope.ruleKey) ? f.source[scope.ruleKey]?.data : undefined;
    return isObj(data) && own(data) ? data[n] : undefined;
  }
  if (kind === 'extract') return scope.vars && own(scope.vars) ? scope.vars[n] : undefined;
  return undefined; // project.<name>: no producer until T15 (compile rejects them, M3-R11)
}

/**
 * A `field` condition (M3): missing data is unknown, never false, so `not` and `!=` never match it (M3-R8). `{ago: d}`
 * compares `Date.parse(value)` with `now - d` (M3-R9); a value that is not an ISO date-time is unknown, as is a `<`/`>` across
 * types or a value that is not a scalar.
 */
function evalField(v: unknown, f: TabFacts, now: number, scope: CondScope | undefined): CondResult {
  if (!isObj(v) || typeof v.field !== 'string' || !v.field.includes('.')) return no();
  const c = v as unknown as Comparison;
  if (!scope) return no(false, true);
  const value = fieldValue(c.field, f, scope);
  if (value === undefined) {
    const n = c.field.slice(c.field.indexOf('.') + 1);
    return c.field.startsWith('extract.') && !f.page && scope.pageVars?.has(n) ? no(true) : no(false, true);
  }
  if (!isScalar(value)) return no(false, true);
  const want = c.value;
  if (isObj(want) && 'ago' in want) {
    if (c.op !== '<' && c.op !== '>') return no();
    let threshold: number;
    try {
      threshold = now - parseDuration(want.ago as string);
    } catch {
      return no(); // unreachable for validated rules
    }
    // Date.parse is lenient ('1', 'May 12', 'Release 2' parse): only an ISO-8601 date-time counts as a date (M3-R9).
    const t = typeof value === 'string' && ISO_DATE_TIME.test(value) ? Date.parse(value) : NaN;
    if (Number.isNaN(t)) return no(false, true);
    return bool(c.op === '<' ? t < threshold : t > threshold);
  }
  if ((c.op === '<' || c.op === '>') && !((typeof value === 'number' && typeof want === 'number') || (typeof value === 'string' && typeof want === 'string'))) {
    return no(false, true);
  }
  return bool(compare(c, value));
}

function condUsesAge(c: Cond): boolean {
  if ('age' in c) return true;
  if ('all' in c) return c.all.some(condUsesAge);
  if ('any' in c) return c.any.some(condUsesAge);
  if ('not' in c) return condUsesAge(c.not);
  if ('opener' in c) return condUsesAge(c.opener);
  return false;
}

/** Whether a rule has an `age` condition anywhere (opener too): while one is in the Program, age is re-evaluated (M3-R5). */
export function usesAge(r: Rule): boolean {
  return condUsesAge(r.match);
}

function compare(c: Comparison, v: unknown): boolean {
  const want = c.value;
  switch (c.op) {
    case '==': return v !== undefined && v === want;
    case '!=': return v !== want;
    case '<': case '>': {
      const ok = (typeof v === 'number' && typeof want === 'number') || (typeof v === 'string' && typeof want === 'string');
      if (!ok) return false;
      return c.op === '<' ? (v as number | string) < (want as number | string) : (v as number | string) > (want as number | string);
    }
    case 'in': return v !== undefined && Array.isArray(want) && want.some((x) => x === v);
    // An unanchored regex search, through the same cached, input-capped compiler as `title: /re/` patterns (no
    // comparison evaluator existed before T17). Wrapped as `/value/`, a 499–500-char value exceeds MAX_REGEX_LEN: no match.
    case 'matches': return typeof want === 'string' && (typeof v === 'string' || typeof v === 'number') && run(compileTextPattern, `/${want}/`, String(v)) !== null;
    default: return false;
  }
}

/**
 * Evaluate a view `show` expression (M2 T17): `{field, op, value}` comparisons combined with all / any / not, where
 * `field(name)` resolves a field (`tab.*`, `extract.*`; undefined when unknown). Pure; never throws.
 */
export function evalShow(s: Show, field: (name: string) => unknown): boolean {
  if (!isObj(s)) return false;
  if ('all' in s) return Array.isArray(s.all) && s.all.every((x) => evalShow(x, field));
  if ('any' in s) return Array.isArray(s.any) && s.any.some((x) => evalShow(x, field));
  if ('not' in s) return isObj(s.not) && !evalShow(s.not, field);
  const c = s as Comparison;
  return typeof c.field === 'string' && compare(c, field(c.field));
}
