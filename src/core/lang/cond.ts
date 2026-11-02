// Condition evaluator for the M2 rule language (`Rule.match`). Pure: no browser access; the caller resolves facts.
import { compilePattern, compileTextPattern, MAX_MATCH_INPUT } from '../match/pattern';
import type { Matcher } from '../match/pattern';
import { parseDuration } from './duration';
import type { Cond, TabFacts } from './types';

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
      const url = (f.tab.pendingUrl ?? f.tab.url).slice(0, MAX_MATCH_INPUT);
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
      const texts = f.page.texts.map((t) => t.toLowerCase());
      return bool(needles.some((n) => texts.some((t) => t.includes(n.toLowerCase()))));
    }
    default:
      return no();
  }
}
