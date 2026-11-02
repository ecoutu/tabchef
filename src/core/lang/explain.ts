// The conflict view ("why is this tab here?") and shadowed-rule warnings (M2 T14). Pure: no browser access.
//
// explainTab lists the rules relevant to one tab (ruling T3→T14: `evalCond` with no page facts says ok or needsPage)
// in priority order, with the action kinds each one won and, per kind it lost, the rule that won it (R34: different
// kinds can be won by different rules).
//  - Live rules read the live outcome: dry-run rules fall through (liveProgram, R48), exactly as the engine applies.
//  - Dry-run rules (`dryRun: true`, "dry run: logged only") read the full Program, the engine's would-* pass: `won`
//    is what the rule would win (and is logged as would-*), `lostTo` the rule (live or dry-run) that beats it there.
//  - Paused rules (R45, `paused` = the reason) take no part: they are listed but neither win nor lose, and the next
//    rule wins in their place, as when ProgramCache leaves them out.
//
// findShadowed is a heuristic, labelled "Likely": rule B is reported when an earlier rule A with the same action
// kind(s) matches every sample URL generated from B's URL patterns (`*` → `x`, `:param` → `p1`) and A has no
// `not` / `pageText` / `title` condition. Rules with a regex URL pattern are never reported (their regex can match
// tabs that no sample stands for).
import { evalCond } from './cond';
import { liveProgram } from './dry-run';
import { evaluateTab, type EvalResult } from './evaluate';
import type { Cond, Program, Rule, TabFacts } from './types';
import type { TabSnap } from '../types';

export type ActionKind = 'group' | 'dedupe' | 'close' | 'showInView';
/** Kinds only one rule can win per tab. showInView is not one: every matching rule adds its view. */
type ExclusiveKind = 'group' | 'dedupe' | 'close';

export interface ExplainEntry {
  key: string;
  name: string;
  /** The rule's action kinds, in its own order (no duplicates). */
  actions: ActionKind[];
  /** Kinds this rule won (for a dry-run rule: would win). showInView counts as won whenever the rule matches. */
  won: ActionKind[];
  /** Kind → key of the rule that won it, for kinds this rule matched for but did not win. */
  lostTo: Partial<Record<ActionKind, string>>;
  /** Why the rule is paused (R45, e.g. "Paused: needs access to <host>"). Paused rules never win or lose. */
  paused?: string;
  /** A dry-run rule (R48): logged only, never applied. */
  dryRun?: true;
  /** The rule's condition matches the tab with the facts given. */
  matched: boolean;
  /** The result depends on page facts the tab does not have yet ("needs page facts"). */
  needsPage?: true;
}

/** Exact inline warning copy for a shadowed rule (heuristic: "Likely"). */
export function shadowText(name: string): string {
  return `Likely never matches: rule "${name}" above catches these first.`;
}

/** Action kinds of a rule, in order, without duplicates. */
export function actionKinds(r: Rule): ActionKind[] {
  const out: ActionKind[] = [];
  for (const a of r.actions) {
    const k = (['group', 'dedupe', 'close', 'showInView'] as const).find((x) => x in a);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

const winnerOf = (e: EvalResult, k: ExclusiveKind): string | undefined => e[k]?.key;

/**
 * Explain tab facts `f` at `now` against program `p` (compiled without a paused set, so paused rules are still in it).
 * `paused` maps rule keys and/or recipe ids to their pause reason.
 */
export function explainTab(p: Program, f: TabFacts, now: number, paused: Record<string, string> = {}): ExplainEntry[] {
  const own = (k: string | undefined): string | undefined => (k !== undefined && Object.hasOwn(paused, k) ? paused[k] : undefined);
  const reasonOf = (key: string, recipeId: string | undefined) => own(key) ?? own(recipeId);
  const running: Program = { ...p, rules: p.rules.filter((r) => reasonOf(r.key, r.recipeId) === undefined) };
  const live = evaluateTab(liveProgram(running), f, now);
  const full = evaluateTab(running, f, now); // the would-* pass (R48)
  const noPage: TabFacts = { ...f };
  delete noPage.page;
  const out: ExplainEntry[] = [];
  for (const r of p.rules) {
    const rel = evalCond(r.rule.match, noPage, now);
    if (!rel.ok && !rel.needsPage) continue;
    const c = evalCond(r.rule.match, f, now);
    const actions = actionKinds(r.rule);
    const e: ExplainEntry = { key: r.key, name: r.rule.name, actions, won: [], lostTo: {}, matched: c.ok };
    const reason = reasonOf(r.key, r.recipeId);
    if (reason !== undefined) e.paused = reason;
    if (r.dryRun) e.dryRun = true;
    const selectorExtract = Object.values(r.rule.extract ?? {}).some((x) => 'selector' in x);
    if (!f.page && (c.needsPage || (c.ok && selectorExtract))) e.needsPage = true;
    if (c.ok && reason === undefined) {
      const outcome = r.dryRun ? full : live;
      for (const k of actions) {
        if (k === 'showInView') { e.won.push(k); continue; }
        const w = winnerOf(outcome, k);
        if (w === r.key) e.won.push(k);
        else if (w !== undefined) e.lostTo[k] = w;
      }
    }
    out.push(e);
  }
  return out;
}

// ---- shadowed rules ----

const isRegex = (p: string): boolean => p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0;
const SCHEME = /^([A-Za-z*][A-Za-z0-9+.*-]*):\/\//;

/** A URL a glob matches: `*` → `x`, `:param` → `p1`, no scheme (or `*://`) → https. Undefined when not a valid URL. */
function sampleUrl(glob: string): string | undefined {
  let s = glob;
  const m = SCHEME.exec(s);
  if (!m) s = `https://${s}`;
  else if (m[1] === '*') s = `https://${s.slice(m[0].length)}`;
  s = s.replace(/(^|\/):[A-Za-z_]\w*/g, '$1p1').replace(/\*/g, 'x');
  try {
    new URL(s);
  } catch {
    return undefined;
  }
  return s;
}

/**
 * Sample URLs standing for every tab `c` can match, or null when they cannot be generated (no URL condition on the
 * path to a match, a regex pattern, or a sample that is not a URL). `all`: one URL child is enough (B's tabs are a
 * subset of it); `any`: every child must yield samples.
 */
function samplesOf(c: Cond): string[] | null {
  if (typeof c !== 'object' || c === null) return null;
  if ('url' in c) {
    const pats = Array.isArray(c.url) ? c.url : [c.url];
    if (!pats.length || pats.some((p) => typeof p !== 'string' || isRegex(p))) return null;
    const out = pats.map(sampleUrl);
    return out.every((u): u is string => u !== undefined) ? out : null;
  }
  if ('all' in c && Array.isArray(c.all)) {
    for (const sub of c.all) {
      const s = samplesOf(sub);
      if (s) return s;
    }
    return null;
  }
  if ('any' in c && Array.isArray(c.any) && c.any.length) {
    const all: string[] = [];
    for (const sub of c.any) {
      const s = samplesOf(sub);
      if (!s) return null;
      all.push(...s);
    }
    return all;
  }
  return null;
}

/** True when `c` uses a `not`, `pageText` or `title` condition anywhere. */
function hasUnsure(c: Cond): boolean {
  if (typeof c !== 'object' || c === null) return true;
  if ('not' in c || 'pageText' in c || 'title' in c) return true;
  if ('all' in c && Array.isArray(c.all)) return c.all.some(hasUnsure);
  if ('any' in c && Array.isArray(c.any)) return c.any.some(hasUnsure);
  if ('opener' in c) return hasUnsure(c.opener);
  return false;
}

const sampleTab = (url: string): TabSnap => ({
  id: -1, windowId: -1, index: 0, url, title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false,
});

/** Rules that likely never win anything: an earlier rule catches all of their tabs first. The first such rule is named. */
export function findShadowed(p: Program): { key: string; shadowedBy: string }[] {
  const out: { key: string; shadowedBy: string }[] = [];
  for (let bi = 0; bi < p.rules.length; bi++) {
    const b = p.rules[bi]!;
    const kinds = actionKinds(b.rule).filter((k): k is ExclusiveKind => k !== 'showInView');
    if (!kinds.length || b.rule.actions.some((a) => 'showInView' in a)) continue; // its view would still apply
    const samples = samplesOf(b.rule.match);
    if (!samples) continue;
    for (let ai = 0; ai < bi; ai++) {
      const a = p.rules[ai]!;
      if (a.dryRun && !b.dryRun) continue; // a dry-run rule falls through (R48)
      if (hasUnsure(a.rule.match)) continue;
      const aKinds = actionKinds(a.rule);
      if (!kinds.every((k) => aKinds.includes(k))) continue;
      if (samples.every((u) => evalCond(a.rule.match, { tab: sampleTab(u) }, 0).ok)) {
        out.push({ key: b.key, shadowedBy: a.key });
        break;
      }
    }
  }
  return out;
}
