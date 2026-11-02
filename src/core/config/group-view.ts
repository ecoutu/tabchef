// Narrow M1-engine shim (ruling R3): the v2 rules the M1 grouping/dedupe engine can run, as M1 GroupRules.
// Replaced by the compiled Program in M2 T6.
import type { Config, DedupeMode, GroupColor, GroupRule } from '../types';
import type { Rule } from '../lang/types';
import { userKey } from './migrate';

const COLORS = new Set<string>(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] satisfies GroupColor[]);
const RULE_KEYS = new Set(['id', 'name', 'enabled', 'match', 'actions']);
const GROUP_KEYS = new Set(['title', 'color', 'collapsed', 'sortGroups', 'strict', 'merge']);
const onlyKeys = (o: object, allowed: Set<string>): boolean => Object.keys(o).every((k) => allowed.has(k));

/**
 * The M1 form of a v2 rule (same id), or null when the rule uses anything M1 cannot express: a match other than
 * `{ url }`, anything but exactly one group action (literal color, no anchors) plus at most one mode-only dedupe
 * action, or dryRun / trigger / extract. Inverse of groupRuleToRule for rules it accepts.
 */
export function asGroupRule(r: Rule): GroupRule | null {
  if (!onlyKeys(r, RULE_KEYS) || !('url' in r.match) || Object.keys(r.match).length !== 1) return null;
  const groups = r.actions.filter((a) => 'group' in a);
  const dedupes = r.actions.filter((a) => 'dedupe' in a);
  if (groups.length !== 1 || dedupes.length > 1 || groups.length + dedupes.length !== r.actions.length) return null;
  const g = groups[0]!.group;
  if (!onlyKeys(g, GROUP_KEYS) || !COLORS.has(g.color)) return null;
  const d = dedupes[0]?.dedupe;
  if (d && !onlyKeys(d, new Set(['mode']))) return null;
  return {
    id: r.id, name: r.name, enabled: r.enabled, match: { url: r.match.url },
    group: { title: g.title, color: g.color as GroupColor, ...(g.collapsed !== undefined && { collapsed: g.collapsed }) },
    ...(g.sortGroups !== undefined && { sortGroups: g.sortGroups }),
    ...(d?.mode !== undefined && { dedupe: d.mode as DedupeMode }),
    ...(g.strict !== undefined && { strict: g.strict }),
    ...(g.merge !== undefined && { merge: g.merge }),
  };
}

/** User rules in priority order: those named in `order` first (in that order), then the rest in array order. */
export function orderedUserRules(c: Config): Rule[] {
  const byKey = new Map(c.rules.map((r) => [userKey(r.id), r]));
  const out: Rule[] = [];
  for (const k of c.order) {
    const r = byKey.get(k);
    if (r) { out.push(r); byKey.delete(k); }
  }
  return [...out, ...byKey.values()];
}

/**
 * The rules the M1 engine runs, in priority order, with `id` = the rule key ('user/<id>', ruling R19) so every
 * ruleId the engine records is a key. Rules asGroupRule rejects are skipped (they wait for the T6 engine).
 */
export function groupView(c: Config): GroupRule[] {
  return orderedUserRules(c).flatMap((r) => {
    const g = asGroupRule(r);
    return g ? [{ ...g, id: userKey(r.id) }] : [];
  });
}
