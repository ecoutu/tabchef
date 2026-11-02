import { isMap, isScalar, isSeq, LineCounter, parseDocument, stringify, type Node as YamlNode } from 'yaml';
import type { Config, DedupeMode, GroupColor, GroupRule, TabSnap } from '../core/types';
import type { CloseMode, Cond, GroupAction, Recipe, RecipeRef, Rule } from '../core/lang/types';
import { compilePattern, compileTextPattern } from '../core/match/pattern';
import { asGroupRule, orderedUserRules } from '../core/config/group-view';
import { groupRuleToRule, sanitizeRuleId, userKey } from '../core/config/migrate';
import { COLORS } from '../core/config/schema';
import { validateRule } from '../core/lang/schema';
import { ruleOn, substitute } from '../core/lang/compile';
import { builtinRecipes } from '../recipes/load';

// The Rules page (M2 T15) lists user rules and the rules of enabled recipes in one priority order (`order`). User
// rules are edited in a form (ruleForm) or as YAML (ruleToYaml / yamlToRule), toggled per rule; a rule the form
// cannot show is a read-only summary (ruleSummary) with "Edit in YAML". Recipe rules are locked rows: they can be
// reordered, tested and customized (copied into a user rule), not edited. Display order = priority = `order`.

export { orderedUserRules } from '../core/config/group-view';

/** The form view of a rule, or null when the form cannot edit it. */
export const formRule = (r: Rule): GroupRule | null => asGroupRule(r);

/** Index of the rule in `c.rules` (server error paths use it), or -1. */
export const ruleIndex = (c: Config, id: string): number => c.rules.findIndex((r) => r.id === id);

/** JSON pointers (under /rules/<i>) of the form's group and dedupe actions of a rule. */
export function actionPaths(r: Rule): { group: string; dedupe: string } {
  const g = r.actions.findIndex((a) => 'group' in a);
  const d = r.actions.findIndex((a) => 'dedupe' in a);
  return { group: `actions/${g < 0 ? 0 : g}/group`, dedupe: `actions/${d < 0 ? r.actions.length : d}/dedupe` };
}

/**
 * Moves the user rule at display position `from` to `to` (positions in orderedUserRules). Only `order` changes:
 * the slots user keys hold in it are refilled in the new sequence; recipe keys keep their places.
 */
export function reorderRules(c: Config, from: number, to: number): Config {
  const keys = orderedUserRules(c).map((r) => userKey(r.id));
  const n = keys.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return c;
  const [moved] = keys.splice(from, 1);
  keys.splice(to, 0, moved!);
  const userKeys = new Set(keys);
  const queue = [...keys];
  const order = c.order.map((k) => (userKeys.has(k) ? queue.shift()! : k));
  return { ...c, order: [...order, ...queue] };
}

export function addRule(c: Config, partial: Partial<GroupRule> = {}): Config {
  const id = sanitizeRuleId(crypto.randomUUID(), new Set(c.rules.map((r) => r.id)));
  const g: GroupRule = {
    id, name: 'New rule', enabled: true,
    match: { url: '' }, group: { title: 'New group', color: 'blue' },
    ...partial,
  };
  const rule = groupRuleToRule(g, id);
  return { ...c, rules: [...c.rules, rule], order: [...c.order.filter((k) => k !== userKey(id)), userKey(id)] };
}

/** Applies a form patch (M1 fields) to a form-editable rule; other rules and unknown ids leave `c` unchanged. */
export function updateRule(c: Config, id: string, patch: Partial<GroupRule>): Config {
  const i = ruleIndex(c, id);
  const g = i < 0 ? null : asGroupRule(c.rules[i]!);
  if (!g) return c;
  const rules = c.rules.slice();
  rules[i] = groupRuleToRule({ ...g, ...patch, id }, id);
  return { ...c, rules };
}

export function removeRule(c: Config, id: string): Config {
  return { ...c, rules: c.rules.filter((r) => r.id !== id), order: c.order.filter((k) => k !== userKey(id)) };
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
  const checkText = (path: string, p: string): void => {
    try { compileTextPattern(p); } catch (e) { out.push({ path, message: e instanceof Error ? e.message : String(e) }); }
  };
  const walk = (m: Cond, path: string): void => {
    if ('url' in m) {
      if (Array.isArray(m.url)) m.url.forEach((p, j) => check(`${path}/url/${j}`, p));
      else check(`${path}/url`, m.url);
    } else if ('title' in m) checkText(`${path}/title`, m.title);
    else if ('all' in m) m.all.forEach((x, j) => walk(x, `${path}/all/${j}`));
    else if ('any' in m) m.any.forEach((x, j) => walk(x, `${path}/any/${j}`));
    else if ('not' in m) walk(m.not, `${path}/not`);
    else if ('opener' in m) walk(m.opener, `${path}/opener`);
  };
  c.rules.forEach((r, i) => walk(r.match, `/rules/${i}/match`));
  c.dedupe.allowDuplicates.forEach((p, i) => check(`/dedupe/allowDuplicates/${i}`, p));
  c.dedupe.alwaysSwitchSites.forEach((p, i) => check(`/dedupe/alwaysSwitchSites/${i}`, p));
  for (const field of ['fragmentOverrides', 'titleOverrides'] as const) {
    c.dedupe[field].forEach((e, i) => {
      if (e.pattern === '') out.push({ path: `/dedupe/${field}/${i}/pattern`, message: 'must not be empty' });
      else check(`/dedupe/${field}/${i}/pattern`, e.pattern);
    });
  }
  return out;
}

/**
 * Server errors look like "/rules/2/actions/0/group/color must be ...".
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
  '^/(rules/\\d+/(name|enabled|dryRun|match/(all/0/)?url(/\\d+)?|match/(all/1/)?title|actions/\\d+/group/(title|color|collapsed|sortGroups|strict|merge)'
  + '|actions/\\d+/dedupe(/mode)?|actions/\\d+/close(/(after|mode))?)'
  + '|dedupe/(mode|scope|stripFragment|ignoreTrailingSlash|followFragment|includeIncognito|matchTitle|(stripParams|allowDuplicates|alwaysSwitchSites)(/\\d+)?'
  + '|(fragmentOverrides|titleOverrides)(/\\d+(/(pattern|keepFragment|matchTitle))?)?))$',
);

/** Server errors that no form field displays inline (shown in the summary instead). */
export function unclaimedErrors(errors: string[]): string[] {
  return errors.filter((e) => {
    const sp = e.indexOf(' ');
    return !FIELD_PATH.test(sp < 0 ? e : e.slice(0, sp));
  });
}

// ---- M2 T15: rows across user and recipe rules ----

/** A row of the Rules page: a user rule, or a rule of an enabled recipe (params substituted; `error` if that fails). */
export type RuleRow =
  | { key: string; kind: 'user'; rule: Rule }
  | { key: string; kind: 'recipe'; recipeId: string; recipeName: string; rule: Rule; error?: string;
      /** Effective state: ruleOn (R56/R57), the same rule compileProgram uses. */
      on: boolean };

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The body of a recipe ref: the built-in, or the user recipe's own body. */
export function recipeBody(ref: RecipeRef, builtins: Record<string, Recipe>): Recipe | undefined {
  return ref.source === 'builtin' ? (own(builtins, ref.id) ? builtins[ref.id] : undefined) : ref.body;
}

/** Param values of a recipe as compileProgram resolves them: the user's value, else the default. */
export function paramValues(body: Recipe, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(body.params ?? {})) out[name] = own(params, name) ? params[name] : def.default;
  return out;
}

/** Every row, in priority order: keys named in `order` first, then the rest (user rules, then recipe rules). */
export function ruleRows(c: Config, builtins: Record<string, Recipe> = builtinRecipes()): RuleRow[] {
  const rows: RuleRow[] = c.rules.map((rule) => ({ key: userKey(rule.id), kind: 'user', rule }));
  for (const ref of c.recipes) {
    const body = ref.enabled ? recipeBody(ref, builtins) : undefined;
    if (!body) continue;
    const values = paramValues(body, ref.params);
    for (const raw of body.rules) {
      const on = ruleOn(ref, raw);
      const row: RuleRow = { key: `${ref.id}/${raw.id}`, kind: 'recipe', recipeId: ref.id, recipeName: body.name, rule: raw, on };
      try {
        row.rule = substitute(raw, values) as Rule;
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      rows.push(row);
    }
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: RuleRow[] = [];
  for (const k of c.order) {
    const r = byKey.get(k);
    if (r) { out.push(r); byKey.delete(k); }
  }
  return [...out, ...byKey.values()];
}

/** `order` with every shown key in it: the existing entries, then the shown keys it lacks (in display order). */
function fullOrder(c: Config, shown: string[]): string[] {
  const have = new Set(c.order);
  return [...c.order, ...shown.filter((k) => !have.has(k))];
}

/** `full` with the slots of the shown keys refilled in the sequence `shown` (other entries keep their places). */
function refill(full: string[], shown: string[]): string[] {
  const set = new Set(shown);
  const queue = [...shown];
  return full.map((k) => (set.has(k) ? queue.shift()! : k));
}

/**
 * Moves the row `fromKey` (user or recipe rule key) to display position `toIndex`. Operates on `order` only: missing
 * shown keys are written into it (same priority compileProgram gives them), then the shown keys' slots are refilled.
 * Entries not shown (rules of disabled recipes) keep their places. Unknown key, same place or out of range → `c`.
 */
export function reorder(c: Config, fromKey: string, toIndex: number, builtins: Record<string, Recipe> = builtinRecipes()): Config {
  const shown = ruleRows(c, builtins).map((r) => r.key);
  const from = shown.indexOf(fromKey);
  if (from < 0 || from === toIndex || toIndex < 0 || toIndex >= shown.length) return c;
  const next = shown.slice();
  next.splice(from, 1);
  next.splice(toIndex, 0, fromKey);
  return { ...c, order: trimDefaultTail(c, shown, refill(fullOrder(c, shown), next)) };
}

/**
 * Drops the keys `order` gained when they still sit at its end in their default sequence: compileProgram appends
 * missing keys in that same sequence, so the result means the same and `order` only grows when it must.
 */
function trimDefaultTail(c: Config, shown: string[], order: string[]): string[] {
  const have = new Set(c.order);
  const added = shown.filter((k) => !have.has(k));
  const tail = order.slice(order.length - added.length);
  return added.length && tail.every((k, i) => k === added[i]) ? order.slice(0, order.length - added.length) : order;
}

/**
 * The user rule "Customize" made from recipe rule `key`: id `<recipeId>-<ruleId>` (sanitized), or that id with a `-N`
 * suffix (copies made before Customize became idempotent). Undefined for user keys or when there is none.
 */
export function customizedCopy(c: Config, key: string): Rule | undefined {
  const slash = key.indexOf('/');
  if (slash <= 0 || key.startsWith('user/')) return undefined;
  const base = sanitizeRuleId(`${key.slice(0, slash)}-${key.slice(slash + 1)}`, new Set());
  const suffixed = new RegExp(`^${base.replace(/[-_]/g, '\\$&')}-\\d+$`);
  return c.rules.find((r) => r.id === base) ?? c.rules.find((r) => suffixed.test(r.id));
}

/**
 * "Customize": copies a recipe rule (params substituted) into a new user rule placed just above it, so the copy wins.
 * The id is `<recipeId>-<ruleId>` made unique (R38 pattern, sanitizeRuleId); `needs` is dropped (user rules declare
 * none, R44). One copy per recipe rule: when customizedCopy finds one, nothing is added. Unknown keys, user keys and
 * rows whose params fail → `c`.
 */
export function customizeRule(c: Config, key: string, builtins: Record<string, Recipe> = builtinRecipes()): Config {
  if (customizedCopy(c, key)) return c;
  const rows = ruleRows(c, builtins);
  const row = rows.find((r) => r.key === key);
  if (!row || row.kind !== 'recipe' || row.error) return c;
  const copy: Rule = JSON.parse(JSON.stringify(row.rule));
  delete copy.needs;
  const id = sanitizeRuleId(`${row.recipeId}-${row.rule.id}`, new Set(c.rules.map((r) => r.id)));
  const rule: Rule = { ...copy, id, name: `${row.rule.name} (custom)`, enabled: row.on };
  const full = fullOrder(c, rows.map((r) => r.key));
  const at = full.indexOf(key);
  const order = [...full.slice(0, at), userKey(id), ...full.slice(at)];
  return { ...c, rules: [...c.rules, rule], order };
}

/**
 * Turns one recipe rule on or off (R56): writes `ruleEnabled[ruleId]` on that recipe's ref, overriding the body's
 * `enabled` in either direction. Going back to the body default deletes the entry (and an empty map), so the config
 * stays minimal. Unknown recipes or rules → `c`.
 */
export function setRecipeRuleOn(c: Config, key: string, on: boolean, builtins: Record<string, Recipe> = builtinRecipes()): Config {
  const slash = key.indexOf('/');
  const recipeId = key.slice(0, slash);
  const ruleId = key.slice(slash + 1);
  const ref = slash > 0 ? c.recipes.find((r) => r.id === recipeId) : undefined;
  const raw = ref ? recipeBody(ref, builtins)?.rules.find((r) => r.id === ruleId) : undefined;
  if (!ref || !raw) return c;
  const map = { ...ref.ruleEnabled };
  if (on === ruleOn({}, raw)) delete map[ruleId]; // back to the body default
  else map[ruleId] = on;
  const next: RecipeRef = { ...ref };
  delete next.ruleEnabled;
  if (Object.keys(map).length) next.ruleEnabled = map;
  return { ...c, recipes: c.recipes.map((r) => (r === ref ? next : r)) };
}

/** Replaces user rule `id` with `rule` (from the YAML view); a new id renames its `order` key. */
export function replaceRule(c: Config, id: string, rule: Rule): { ok: true; config: Config } | { ok: false; error: string } {
  if (rule.id !== id && c.rules.some((r) => r.id === rule.id)) return { ok: false, error: `Another rule already has id "${rule.id}"` };
  const rules = c.rules.map((r) => (r.id === id ? rule : r));
  const order = c.order.map((k) => (k === userKey(id) ? userKey(rule.id) : k));
  return { ok: true, config: { ...c, rules, order } };
}

// ---- M2 T15: the rule form ----

/** What the rule form edits. `url` '' / `title` '' = no such condition; a null action = the rule has none. */
export interface RuleForm {
  name: string; enabled: boolean; dryRun: boolean;
  url: string | string[]; title: string;
  group: GroupAction | null; dedupe: DedupeMode | null; close: { after?: string; mode?: CloseMode } | null;
}

const FORM_RULE_KEYS = new Set(['id', 'name', 'enabled', 'dryRun', 'match', 'actions']);
const FORM_GROUP_KEYS = new Set(['title', 'color', 'collapsed', 'sortGroups', 'strict', 'merge']);
const keysIn = (o: object, allowed: Set<string>): boolean => Object.keys(o).every((k) => allowed.has(k));
const keysAre = (o: object, ...keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));

function matchForm(m: Cond): { url: string | string[]; title: string } | null {
  if (keysAre(m, 'url')) return { url: (m as { url: string | string[] }).url, title: '' };
  if (keysAre(m, 'title')) return { url: '', title: (m as { title: string }).title };
  if (keysAre(m, 'all')) {
    const all = (m as { all: Cond[] }).all;
    if (all.length === 2 && keysAre(all[0]!, 'url') && keysAre(all[1]!, 'title')) {
      return { url: (all[0] as { url: string | string[] }).url, title: (all[1] as { title: string }).title };
    }
  }
  return null;
}

/**
 * The form view of a rule, or null when the form cannot show all of it: a match other than url, title or
 * all[url, title]; more than one action of a kind; showInView; a templated color or anchors; dedupe options other
 * than mode; close options other than after/mode; trigger, extract or needs.
 */
export function ruleForm(r: Rule): RuleForm | null {
  if (!keysIn(r, FORM_RULE_KEYS)) return null;
  const m = matchForm(r.match);
  if (!m) return null;
  const f: RuleForm = { name: r.name, enabled: r.enabled, dryRun: r.dryRun === true, ...m, group: null, dedupe: null, close: null };
  for (const a of r.actions) {
    if ('group' in a) {
      if (f.group || !keysIn(a.group, FORM_GROUP_KEYS) || !COLORS.has(a.group.color)) return null;
      f.group = a.group;
    } else if ('dedupe' in a) {
      if (f.dedupe || !keysAre(a.dedupe, 'mode') || a.dedupe.mode === undefined) return null;
      f.dedupe = a.dedupe.mode;
    } else if ('close' in a) {
      if (f.close || !keysIn(a.close, new Set(['after', 'mode']))) return null;
      f.close = a.close;
    } else return null;
  }
  return f;
}

const hasUrl = (u: string | string[]): boolean => (Array.isArray(u) ? u.length > 0 : u !== '');

/** `r` with the form values: match rebuilt; actions replaced in place, removed, or appended (group, dedupe, close). */
export function applyRuleForm(r: Rule, f: RuleForm): Rule {
  const match: Cond = f.title === '' ? { url: f.url } : !hasUrl(f.url) ? { title: f.title } : { all: [{ url: f.url }, { title: f.title }] };
  const actions: Rule['actions'] = [];
  const seen = new Set<string>();
  for (const a of r.actions) {
    if ('group' in a) { seen.add('group'); if (f.group) actions.push({ group: f.group }); }
    else if ('dedupe' in a) { seen.add('dedupe'); if (f.dedupe) actions.push({ dedupe: { mode: f.dedupe } }); }
    else if ('close' in a) { seen.add('close'); if (f.close) actions.push({ close: f.close }); }
    else actions.push(a);
  }
  if (f.group && !seen.has('group')) actions.push({ group: f.group });
  if (f.dedupe && !seen.has('dedupe')) actions.push({ dedupe: { mode: f.dedupe } });
  if (f.close && !seen.has('close')) actions.push({ close: f.close });
  return { id: r.id, name: f.name, enabled: f.enabled, ...(f.dryRun && { dryRun: true }), match, actions };
}

/** Applies a form patch to user rule `id`; rules the form cannot show and unknown ids leave `c` unchanged. */
export function patchRuleForm(c: Config, id: string, patch: Partial<RuleForm>): Config {
  const i = ruleIndex(c, id);
  const f = i < 0 ? null : ruleForm(c.rules[i]!);
  if (!f) return c;
  const rules = c.rules.slice();
  rules[i] = applyRuleForm(c.rules[i]!, { ...f, ...patch });
  return { ...c, rules };
}

// ---- M2 T15: read-only summary ----

const list = (x: string | string[]): string => (Array.isArray(x) ? x.join(', ') : x);

function condText(c: Cond): string {
  if ('url' in c) return `url ${list(c.url)}`;
  if ('title' in c) return `title ${c.title}`;
  if ('all' in c) return `all of (${c.all.map(condText).join('; ')})`;
  if ('any' in c) return `any of (${c.any.map(condText).join('; ')})`;
  if ('not' in c) return `not (${condText(c.not)})`;
  if ('opener' in c) return `opened from (${condText(c.opener)})`;
  if ('group' in c) return `in group ${c.group}`;
  if ('pinned' in c) return c.pinned ? 'pinned' : 'not pinned';
  if ('audible' in c) return c.audible ? 'playing audio' : 'not playing audio';
  if ('age' in c) return `age${c.age.gt ? ` over ${c.age.gt}` : ''}${c.age.lt ? ` under ${c.age.lt}` : ''}`;
  if ('pageText' in c) return `page text ${(Array.isArray(c.pageText) ? c.pageText : [c.pageText]).map((t) => `"${t}"`).join(', ')}`;
  return JSON.stringify(c);
}

/** One line per part of a rule, for rules the form cannot show (and locked recipe rows). */
export function ruleSummary(r: Rule): string[] {
  const out = [`Match: ${condText(r.match)}`];
  if (r.trigger) out.push(`Runs on: ${r.trigger.on.join(', ')}${r.trigger.every ? ` every ${r.trigger.every}` : ''}`);
  if (r.extract) out.push(`Extracts: ${Object.keys(r.extract).join(', ')}`);
  for (const a of r.actions) {
    if ('group' in a) out.push(`Group into "${a.group.title}" (${a.group.color})${a.group.anchors?.length ? ` with ${a.group.anchors.length} anchor tabs` : ''}`);
    else if ('dedupe' in a) out.push(`De-duplicate${a.dedupe.mode ? `: ${a.dedupe.mode}` : ''}`);
    else if ('close' in a) out.push(`Close${a.close.after ? ` after ${a.close.after}` : ''}${a.close.mode ? ` (${a.close.mode})` : ''}`);
    else out.push(`Show in view ${a.showInView.view}`);
  }
  if (r.dryRun) out.push('Dry run: logged only');
  return out;
}

// ---- M2 T15: editor hints ----

/** URL patterns anywhere in a rule's match (for editor hints). */
export function ruleUrlPatterns(r: Rule): string[] {
  const out: string[] = [];
  const walk = (c: Cond): void => {
    if ('url' in c) out.push(...(Array.isArray(c.url) ? c.url : [c.url]));
    else if ('all' in c) c.all.forEach(walk);
    else if ('any' in c) c.any.forEach(walk);
    else if ('not' in c) walk(c.not);
    else if ('opener' in c) walk(c.opener);
  };
  walk(r.match);
  return out;
}

/**
 * Editor hints (not errors) for a URL glob: a pattern ending in a param or literal path segment matches only that
 * exact path (T15/T16 follow-up), and a `*` inside the host also matches look-alike hosts (R32: kept for
 * compatibility, so warned about, not refused). Regex patterns get none.
 */
export function patternHints(p: string): string[] {
  if (p.startsWith('/') || p === '') return [];
  const out: string[] = [];
  const rest = p.replace(/^[a-z*]+:\/\//i, '');
  const slash = rest.search(/[/?#]/);
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const sub = host.startsWith('*.') ? 2 : 0;
  const star = host.indexOf('*', sub);
  if (rest[slash] === '/' && !/[*/]$/.test(rest) && !/[?#]/.test(rest)) out.push('matches only exactly this path; add * to include deeper pages');
  const lit = star > sub ? host.slice(sub, star) : '';
  if (lit !== '') {
    const name = lit.replace(/\.$/, '');
    out.push(`also matches look-alike hosts such as ${name}.evil.com${lit.endsWith('.') ? '' : `; use ${lit}/* to match only ${lit}`}`);
  }
  return out;
}

// ---- M2 T16: pre-filled rules (context menu) ----

/** What the NewRule page saves: a group rule (new, or the pattern added to an existing one), a close rule, or a never-dedupe rule. */
export type NewRuleSpec =
  | { kind: 'group'; pattern: string; name: string; group: { existing: string } | { title: string; color: GroupColor } }
  | { kind: 'close'; pattern: string; name: string; close: { after?: string; mode: CloseMode } }
  | { kind: 'allowDup'; pattern: string; name: string };

/** User rules the NewRule group picker can add a pattern to: form-editable, with a group action. */
export function groupRuleChoices(c: Config): { id: string; name: string; title: string }[] {
  return orderedUserRules(c).flatMap((r) => {
    const g = ruleForm(r)?.group;
    return g ? [{ id: r.id, name: r.name, title: g.title }] : [];
  });
}

/**
 * `c` with the rule of `spec`. A new rule goes first in priority (`order`): it was made from a concrete page, so it
 * should win over broader rules. Into an existing group rule, the pattern is appended to its URL list (once).
 */
export function addNewRule(c: Config, spec: NewRuleSpec): Config {
  let action: Rule['actions'][number];
  if (spec.kind === 'group') {
    if ('existing' in spec.group) return addPatternToRule(c, spec.group.existing, spec.pattern);
    action = { group: { title: spec.group.title, color: spec.group.color } };
  } else action = spec.kind === 'close' ? { close: spec.close } : { dedupe: { mode: 'off' } };
  const id = sanitizeRuleId(`${spec.kind}-${spec.pattern}`, new Set(c.rules.map((r) => r.id)));
  const rule: Rule = { id, name: spec.name, enabled: true, match: { url: spec.pattern }, actions: [action] };
  return { ...c, rules: [...c.rules, rule], order: [userKey(id), ...c.order.filter((k) => k !== userKey(id))] };
}

function addPatternToRule(c: Config, id: string, pattern: string): Config {
  const target = c.rules[ruleIndex(c, id)];
  const f = target ? ruleForm(target) : null;
  if (!f) return c;
  const lines = Array.isArray(f.url) ? f.url : f.url === '' ? [] : [f.url];
  return lines.includes(pattern) ? c : patchRuleForm(c, id, { url: [...lines, pattern] });
}

// ---- M2 T15: YAML view ----

/** The YAML text of a rule (the YAML view). */
export function ruleToYaml(r: Rule): string {
  return stringify(r, { lineWidth: 0 });
}

export type YamlRuleResult = { ok: true; rule: Rule } | { ok: false; errors: { line: number; message: string }[] };

const unescapePointer = (s: string): string => s.replace(/~1/g, '/').replace(/~0/g, '~');

/** Line of the deepest node along a JSON pointer (map keys point at the key's line). */
function lineOfPath(doc: ReturnType<typeof parseDocument>, segs: string[], lc: LineCounter): number {
  const lineOf = (n: YamlNode | null | undefined): number | undefined => (n?.range ? lc.linePos(n.range[0]).line : undefined);
  let node: unknown = doc.contents;
  let line = lineOf(doc.contents as YamlNode) ?? 1;
  for (const seg of segs) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg);
      if (!pair) break;
      line = lineOf(pair.key as YamlNode) ?? line;
      node = pair.value;
    } else if (isSeq(node)) {
      const item = node.items[Number(seg)] as YamlNode | undefined;
      if (!/^\d+$/.test(seg) || !item) break;
      line = lineOf(item) ?? line;
      node = item;
    } else break;
  }
  return line;
}

/**
 * Parses the YAML view: syntax errors, then validateRule (schema, then the pattern / regex / duration / template
 * post-checks). Each error carries the line of the node its path names; an unknown key points at that key.
 */
export function yamlToRule(s: string): YamlRuleResult {
  const lc = new LineCounter();
  const doc = parseDocument(s, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    return { ok: false, errors: doc.errors.map((e) => ({ line: lc.linePos(e.pos[0]).line, message: e.message.split('\n')[0]! })) };
  }
  if (!isMap(doc.contents)) return { ok: false, errors: [{ line: 1, message: 'A rule must be a mapping (id, name, enabled, match, actions)' }] };
  const v = validateRule(doc.toJS({ maxAliasCount: 100 }));
  if (v.ok) return { ok: true, rule: v.rule };
  return {
    ok: false,
    errors: v.errors.map((p) => {
      const segs = p.path.split('/').slice(1).filter((x) => x !== '').map(unescapePointer);
      const extra = /additional propert(?:y|ies): (\S+)/.exec(p.message)?.[1];
      const at = p.path === '/' || p.path === '' ? '' : `${p.path.slice(1)}: `;
      return { line: lineOfPath(doc, extra ? [...segs, extra] : segs, lc), message: `${at}${p.message}` };
    }),
  };
}
