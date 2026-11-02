// Dry-run helpers (M2 T12, rulings R10 / R48). Pure.
//
// Dry-run falls through (R48): the live outcome is computed as if dry-run rules did not exist, so the next live rule
// wins group, dedupe and close. What a dry-run rule would have done is computed separately over the full Program and
// only logged (`would-group`, `would-ungroup`, `would-close`).
import type { Program } from './types';

const live = new WeakMap<Program, Program>();

/** `p` without its dry-run rules (indices kept, so priorities still compare). Memoized per Program. */
export function liveProgram(p: Program): Program {
  if (!p.rules.some((r) => r.dryRun)) return p;
  let l = live.get(p);
  if (!l) {
    l = { ...p, rules: p.rules.filter((r) => !r.dryRun) };
    live.set(p, l);
  }
  return l;
}

/** True when some rule (or the global flag) is dry-run: the engine runs a dry-run pass. */
export function hasDryRun(p: Program): boolean {
  return p.dryRun === true || p.rules.some((r) => r.dryRun);
}

/** True when `ruleKey` names a dry-run rule of `p`. */
export function isDryRunRule(p: Program, ruleKey: string | undefined): boolean {
  return ruleKey !== undefined && p.rules.some((r) => r.key === ruleKey && r.dryRun);
}
