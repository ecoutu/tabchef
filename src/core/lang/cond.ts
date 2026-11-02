// Condition evaluator for the M2 rule language (`Rule.match`). Pure: no browser access; the caller resolves facts.
import { compilePattern, compileTextPattern } from '../match/pattern';
import type { Matcher } from '../match/pattern';
import { parseDuration } from './duration';
import { foldText } from './fold-text';
import type { Comparison, Cond, Show, TabFacts } from './types';

export interface CondResult {
  ok: boolean;
  /** Captures from matched `url` patterns (and title regex named groups); the first match wins. */
  captures: Record<string, string>;
  /** True when the result depended on `pageText` and `f.page` was undefined. `ok` is then false. */
  needsPage: boolean;
}

const no = (needsPage = false): CondResult => ({ ok: false, captures: {}, needsPage });
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
export function evalCond(c: Cond, f: TabFacts, now: number): CondResult {
  if (typeof c !== 'object' || c === null) return no();
  const keys = Object.keys(c);
  if (keys.length !== 1) return no();
  const v = (c as Record<string, unknown>)[keys[0] as string];
  switch (keys[0]) {
    case 'all': {
      if (!Array.isArray(v)) return no();
      let captures: Record<string, string> = {};
      let needsPage = false;
      for (const sub of v as Cond[]) {
        const r = evalCond(sub, f, now);
        if (r.ok) captures = { ...r.captures, ...captures };
        else if (r.needsPage) needsPage = true;
        else return no(); // definitely false: the page can't change that
      }
      return needsPage ? no(true) : yes(captures);
    }
    case 'any': {
      if (!Array.isArray(v)) return no();
      let needsPage = false;
      for (const sub of v as Cond[]) {
        const r = evalCond(sub, f, now);
        if (r.ok) return yes(r.captures);
        if (r.needsPage) needsPage = true;
      }
      return no(needsPage);
    }
    case 'not': {
      const r = evalCond(v as Cond, f, now);
      return r.needsPage ? no(true) : bool(!r.ok);
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
      // Only the opener's tab is known; its page is never fetched, so pageText under opener is just false.
      const r = evalCond(v as Cond, { tab: f.opener }, now);
      return r.ok ? yes(r.captures) : no();
    }
    case 'group':
      return bool(f.groupTitle !== undefined && f.groupTitle === v);
    case 'pinned':
      return bool(f.tab.pinned === v);
    case 'audible':
      return bool(f.tab.audible === v);
    case 'age': {
      if (f.createdAt === undefined || typeof v !== 'object' || v === null) return no();
      const { gt, lt } = v as { gt?: unknown; lt?: unknown };
      if (gt === undefined && lt === undefined) return no();
      const age = now - f.createdAt;
      try {
        if (gt !== undefined && !(age > parseDuration(gt as string))) return no();
        if (lt !== undefined && !(age < parseDuration(lt as string))) return no();
      } catch {
        return no();
      }
      return yes();
    }
    case 'pageText': {
      const needles = (Array.isArray(v) ? v : [v]).filter((n): n is string => typeof n === 'string' && n !== '');
      if (!needles.length) return no();
      if (!f.page) return no(true);
      const texts = f.page.texts.map(foldText);
      return bool(needles.some((n) => texts.some((t) => t.includes(foldText(n)))));
    }
    default:
      return no();
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

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
