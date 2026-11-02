// Import collapsing (M2 T19, spec §12): a contiguous run of >= 3 imported rules whose url globs differ in exactly one
// path segment, each grouping into a group titled after that segment, is offered as one templated rule plus a color
// table. Never applied automatically: import.preview lists the suggestions, import.apply applies the chosen ones.
//
// Behavior is identical for every URL (ruling R16, amended): the collapsed pattern is an ordered, unbounded regex
// alternation in the original rule order, `/^https:\/\/github\.com\/acme\/(?<repo>repo-1|repo-2|…|repo-10).*$/i`.
// Alternation is first-match-wins with full backtracking, so a URL takes the first alternative for which the whole
// regex matches, exactly as it took the first rule whose glob matched (repo-10 tabs still go to repo-1; other
// acme/<x> tabs still fall through to later rules). Only plain literal globs are collapsed, so the regex is an exact
// translation: a literal http(s) scheme (or none, meaning http(s)), a literal canonical host with no port or userinfo,
// literal path segments of unreserved characters, and an optional trailing `*`. URL globs ignore case (URLPattern
// ignoreCase plus a case-insensitive host), so the regex carries the `i` flag; the capture then has the URL's own
// case, so segments must be lower case and the title and color lowercase the capture (`{repo|lower}`), which keeps an
// upper-case URL variant on the same group as before.
import { COLORS, ruleProblems } from '../config/schema';
import { sanitizeRuleId } from '../config/migrate';
import { MAX_REGEX_LEN } from '../match/pattern';
import { validateRule } from './schema';
import type { GroupAction, Rule } from './types';

export interface CollapseSuggestion {
  /** Ids of the replaced rules, contiguous and in order. */
  replaces: string[];
  rule: Rule;
  table: { name: string; entries: Record<string, string> };
  /** Shadowing the collapse preserves (findShadowed skips regex rules): "repo-10 tabs currently go to repo-1". */
  notes: string[];
}

export interface CollapseOptions {
  /** Rule ids already in use (the collapsed rule's id avoids them and every id in `rules`). */
  ids?: Iterable<string>;
  /** Table names already in use (config tables, recipe tables). */
  tables?: Iterable<string>;
}

const MIN_RUN = 3;
const GLOB = /^(?:(https?|\*):\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)((?:\/[A-Za-z0-9._~-]+)+\/?)(\*?)$/;
const SEG = /^[a-z0-9._~-]+$/;
const GROUP_KEYS = new Set(['title', 'color', 'collapsed', 'sortGroups', 'strict', 'merge']);
const RULE_KEYS = new Set(['id', 'name', 'enabled', 'match', 'actions']);

interface Parsed {
  scheme: string; host: string; segs: string[]; star: boolean;
  /** Group fields other than title and color, as stable JSON (they must be equal across a run). */
  sharedKey: string; shared: Omit<GroupAction, 'title' | 'color'>;
  title: string; color: string;
}

const escRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** A rule in the shape collapse handles, or null. */
function parse(rule: Rule): Parsed | null {
  if (Object.keys(rule).some((k) => !RULE_KEYS.has(k)) || rule.enabled !== true) return null;
  const m = rule.match;
  if (Object.keys(m).length !== 1 || !('url' in m)) return null;
  const urls = Array.isArray(m.url) ? m.url : [m.url];
  if (urls.length !== 1 || typeof urls[0] !== 'string') return null;
  if (rule.actions.length !== 1) return null;
  const a = rule.actions[0]!;
  if (Object.keys(a).length !== 1 || !('group' in a)) return null;
  const { title, color, ...shared } = a.group;
  if (Object.keys(a.group).some((k) => !GROUP_KEYS.has(k)) || !COLORS.has(color)) return null;
  const g = GLOB.exec(urls[0]);
  if (!g) return null;
  const host = g[2] as string;
  try {
    if (new URL(`https://${host}/`).hostname !== host) return null; // only canonical hosts (as exactHostPort)
  } catch {
    return null;
  }
  const segs = (g[3] as string).split('/').slice(1);
  if (segs.some((s) => s === '.' || s === '..')) return null;
  const sharedKey = JSON.stringify(Object.keys(shared).sort().map((k) => [k, (shared as Record<string, unknown>)[k]]));
  return { scheme: g[1] === 'http' || g[1] === 'https' ? g[1] : 'https?', host, segs, star: g[4] === '*', sharedKey, shared, title, color };
}

/** The one segment index where `a` and `b` differ (everything else equal), or -1. */
function diffIndex(a: Parsed, b: Parsed): number {
  if (a.scheme !== b.scheme || a.host !== b.host || a.star !== b.star || a.sharedKey !== b.sharedKey || a.segs.length !== b.segs.length) return -1;
  let at = -1;
  for (let i = 0; i < a.segs.length; i++) {
    if (a.segs[i] === b.segs[i]) continue;
    if (at >= 0) return -1;
    at = i;
  }
  return at;
}

/** Whether rule `p` fits a run varying at `idx`: its title is that segment, a lower-case non-empty literal. */
const fits = (p: Parsed, idx: number) => p.title === p.segs[idx] && SEG.test(p.title);

/** Template variable (and slug) for a run: the segments' common leading word, else the segment before, else `seg`. */
function varName(segs: string[], before: string | undefined): string {
  let lcp = segs[0] as string;
  for (const s of segs) while (!s.startsWith(lcp)) lcp = lcp.slice(0, -1);
  const word = (s: string) => /^[a-z][a-z0-9]*/.exec(s.toLowerCase())?.[0].slice(0, 32);
  const w = word(lcp);
  if (w && w.length >= 2) return w;
  return (before !== undefined ? word(before) : undefined) ?? 'seg';
}

/**
 * Collapse suggestions for `rules` (imported, migrated v2 rules), in rule order; runs never overlap. Each suggestion's
 * rule passes validateRule and ruleProblems with its table, and its pattern is at most MAX_REGEX_LEN characters.
 */
export function suggestCollapse(rules: Rule[], opts: CollapseOptions = {}): CollapseSuggestion[] {
  const parsed = rules.map(parse);
  const ids = new Set([...(opts.ids ?? []), ...rules.map((r) => r.id)]);
  const tables = new Set(opts.tables ?? []);
  const out: CollapseSuggestion[] = [];
  let i = 0;
  while (i < rules.length) {
    const first = parsed[i];
    let j = i;
    let idx = -1;
    while (first && j + 1 < rules.length) {
      const next = parsed[j + 1];
      const d = next ? diffIndex(parsed[j]!, next) : -1;
      if (d < 0 || (idx >= 0 && d !== idx) || !fits(first, d) || !fits(next!, d)) break;
      if (parsed.slice(i, j + 1).some((p) => p!.segs[d] === next!.segs[d])) break;
      idx = d;
      j++;
    }
    const s = j - i + 1 >= MIN_RUN ? build(rules.slice(i, j + 1), parsed.slice(i, j + 1) as Parsed[], idx, ids, tables) : null;
    if (s) out.push(s);
    i = s || j === i ? j + 1 : j;
  }
  return out;
}

function build(run: Rule[], ps: Parsed[], idx: number, ids: Set<string>, tables: Set<string>): CollapseSuggestion | null {
  const p0 = ps[0]!;
  const segs = ps.map((p) => p.segs[idx] as string);
  const v = varName(segs, p0.segs[idx - 1]);
  const prefix = `/${p0.segs.slice(0, idx).map((s) => `${s}/`).join('')}`;
  const rest = p0.segs.slice(idx + 1).map((s) => `/${s}`).join('');
  const pattern = `/^${p0.scheme}:\\/\\/${escRe(p0.host)}${escRe(prefix)}(?<${v}>${segs.map(escRe).join('|')})${escRe(rest)}${p0.star ? '.*' : ''}$/i`;
  if (pattern.length > MAX_REGEX_LEN) return null;

  const entries: Record<string, string> = {};
  const counts = new Map<string, number>();
  ps.forEach((p, k) => {
    entries[segs[k] as string] = p.color;
    counts.set(p.color, (counts.get(p.color) ?? 0) + 1);
  });
  let common = p0.color;
  for (const [c, n] of counts) if (n > (counts.get(common) ?? 0)) common = c;

  let name = `${v}Colors`;
  for (let n = 2; tables.has(name); n++) name = `${v}Colors${n}`;
  const taken = new Set(ids);
  const id = sanitizeRuleId(`collapsed-${v}`, taken);
  const rule: Rule = {
    id, name: `${p0.host}${prefix}:${v}${rest}${p0.star ? '*' : ''}`, enabled: true, match: { url: [pattern] },
    actions: [{ group: { title: `{${v}|lower}`, color: `{${v}|lower|map:${name}|default:${common}}`, ...p0.shared } }],
  };
  const valid = validateRule(rule);
  if (!valid.ok || ruleProblems(rule, { [name]: entries }).length) return null;

  const notes: string[] = [];
  if (p0.star && rest === '') {
    segs.forEach((later, k) => {
      const by = segs.slice(0, k).find((earlier) => later.startsWith(earlier));
      if (by !== undefined) notes.push(`${later} tabs currently go to ${by}`);
    });
  }
  ids.add(id);
  tables.add(name);
  return { replaces: run.map((r) => r.id), rule, table: { name, entries }, notes };
}

/**
 * `rules` and `tables` with the chosen suggestions applied: each replaced run becomes its collapsed rule in place, and
 * its table is added. Throws when a suggestion's run is not in `rules` as one contiguous block (it was derived from
 * other rules).
 */
export function applyCollapse(
  rules: Rule[], tables: Record<string, Record<string, string>>, chosen: CollapseSuggestion[],
): { rules: Rule[]; tables: Record<string, Record<string, string>> } {
  const outRules = [...rules];
  const outTables = { ...tables };
  for (const s of chosen) {
    const at = outRules.findIndex((r) => r.id === s.replaces[0]);
    if (at < 0 || s.replaces.some((id, k) => outRules[at + k]?.id !== id)) throw new Error(`collapse suggestion ${s.rule.id} does not match the rules`);
    outRules.splice(at, s.replaces.length, s.rule);
    outTables[s.table.name] = { ...s.table.entries };
  }
  return { rules: outRules, tables: outTables };
}
