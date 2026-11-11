// Compiles a ConfigV2 plus its recipes into a prioritized Program (M2 T4). Pure: never throws, never mutates its input.
//
// Rule keys (R19): user rules are `user/<id>`, recipe rules `<recipeId>/<ruleId>`.
//
// Priority: position in `config.order`. Keys missing from it are appended: user rules first (config.rules order),
// then recipe rules (config.recipes order, then each recipe's rule order). Migration writes only user keys and
// defaultConfig().order is [], so this append is what places recipe rules after the user's own.
//
// Typed placeholders (R14): in a recipe, any leaf that is exactly the string `{params.<name>}` is replaced by the
// param's value with its type (the user's value from RecipeRef.params, else the ParamDef default): a `string[]`
// param in `match.url` becomes the whole pattern list, a boolean param in `collapsed` becomes a boolean. Inside an
// array, an exact placeholder holding an array is spliced in (`url: ['a/*', '{params.more}']`). So a `string[]`
// param fills an array-typed field (`url`, `pageText`, `anchors`, `needs.hosts`) as the whole array, never as one
// element; an empty list stays empty (a `url: []` cond never matches). A placeholder inside a larger string
// (`'PR {params.prefix}'`) is plain string interpolation, except right after `://` in a `dedupe.urlTransforms` pattern,
// where the value is a regex-escaped host glob and an unusable value drops the transform (renderUrlTransforms, #179).
// Substitution runs before anything compiles; afterwards every rule goes through the same checks as a user rule
// (validateRule + ruleProblems).
//
// Params fields (#194): a recipe rule's match may compare a param, `field: {field: params.<name>, op, value}`, so a
// boolean setting can turn part of a match on or off. The name must be declared by the recipe (else an error, as for an
// unknown placeholder). A user rule has no params, so one with a params field is reported and skipped (like `source`).
// A param is the same for every tab, so once the rule is valid each params field is folded to its verdict (foldParams,
// core/lang/cond.ts).
//
// Needs (R5, T10): `Program.needs` has an entry per enabled recipe, keyed by recipe id (recipe-level needs, empty
// lists when none), plus one per enabled recipe rule that declares `needs`, keyed by rule key. "Enabled" is effective
// (R56): RecipeRef.ruleEnabled[ruleId] overrides the body's `enabled` in both directions. Paused recipes and
// rules keep their entries (PermissionsManager reads needs from the program it pauses). User rules may not declare
// needs (R44); one that does is reported and skipped.
//
// M3 (T1): `source` and `assignProject` are recipe-rule-only (M3-R15); a user rule with one is reported and skipped.
// Not supported yet, reported for the rule that uses them: `project.<name>` fields (M3-R11, until T15).
// `needs.connections` / `needs.anyOf` compile into Program.needs as declared (M3-R63); levels are computed by
// PermissionsManager, so compile stays free of permission and connection state (R45). A needs alternative with its
// own `anyOf` is reported. Declared recipe `levels` are carried in Program.levels. A recipe rule with `assignProject` needs the recipe's `project`. Recipes that
// `conflicts` with each other (either side may list the other) are not both compiled: the later one in
// config.recipes is reported and skipped (M3-R17); enabling one through recipes.enable turns the others off
// (conflictingRecipes).
//
// Errors: a broken recipe (unknown body, bad param, unknown placeholder, invalid rule, bad urlTransform) is reported
// in `errors` and skipped as a whole (rules, tables, views, needs); a broken user rule is reported and skipped alone.
//
// Pattern matchers are compiled once per pattern string and cached by compilePattern / compileTextPattern
// (src/core/match/pattern.ts); validation here warms the URL pattern cache. Memoizing whole Programs is the
// engine's job (ProgramCache, T6).
import { globHost } from '../match/pattern';
import { formatSchemaError, regexProblem, ruleProblems, type Tables } from '../config/rule-problems';
import { validateRule } from '../config/validate-config.generated.js';
import { foldParams } from './cond';
import { DURATION, parseDuration } from './duration';
import type { Config, DedupeSettings } from '../types';
import type { CompiledRule, Cond, NeedsAlt, NeedsEntry, ParamDef, Program, Recipe, RecipeLevel, RecipeNeeds, RecipeRef, Rule } from './types';
import { PROJECT_DEFAULTS, type ProjectDef } from '../projects/types';

export interface CompileError { key: string; error: string }
export interface CompileOptions {
  /** Rule keys and/or recipe ids to leave out of the program (e.g. waiting for a permission, T8). */
  paused?: Set<string>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const PROJECT_FIELDS = new Set(['key', 'title', 'color', 'container', 'join', ...Object.keys(PROJECT_DEFAULTS)]);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A param problem found while substituting placeholders. Exported for validateRecipe (src/core/lang/schema.ts). */
export class ParamError extends Error {}

// ---- params ----

const EXACT = /^\{params\.([A-Za-z_]\w*)\}$/;
const INNER = /\{params\.([A-Za-z_]\w*)\}/g;
/** Param names of the `{params.<name>}` placeholders in a string. */
export const placeholderNames = (s: string): string[] => [...s.matchAll(INNER)].map((m) => m[1] as string);

/** Why `v` is not a valid value for `def`, or undefined. */
/** The size min / max compare (M3-R77): a duration in ms, a number itself; undefined for other types or a bad value. */
function magnitude(type: ParamDef['type'], x: unknown): number | undefined {
  if (type === 'duration') return typeof x === 'string' && DURATION.test(x) ? parseDuration(x) : undefined;
  if (type === 'number') return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
  return undefined;
}

/** Why a ParamDef's `min` / `max` is malformed (M3-R77): only on duration and number params, of that type, min ≤ max. */
export function boundProblem(def: ParamDef, k: 'min' | 'max'): string | undefined {
  const b = def[k];
  if (b === undefined) return undefined;
  if (def.type !== 'duration' && def.type !== 'number') return `${k} applies only to duration and number params`;
  if (magnitude(def.type, b) === undefined) return def.type === 'duration' ? 'must be a duration like 500ms, 30s, 15m, 2h or 1d' : 'must be a number';
  if (k === 'min' && def.max !== undefined) {
    const hi = magnitude(def.type, def.max);
    if (hi !== undefined && magnitude(def.type, b)! > hi) return 'must not be more than max';
  }
  return undefined;
}

export function paramProblem(def: ParamDef, v: unknown): string | undefined {
  switch (def.type) {
    case 'string':
    case 'pattern':
      if (typeof v !== 'string') return `must be a string`;
      break;
    case 'regex':
      if (typeof v !== 'string') return `must be a regex string`;
      { const m = regexProblem(v, undefined, true); if (m) return m; }
      break;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number';
      break;
    case 'boolean':
      if (typeof v !== 'boolean') return 'must be a boolean';
      break;
    case 'duration':
      if (typeof v !== 'string' || !DURATION.test(v)) return 'must be a duration like 500ms, 30s, 15m, 2h or 1d';
      break;
    case 'string[]':
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return 'must be a list of strings';
      break;
    default:
      return `unknown param type: ${String((def as { type: unknown }).type)}`;
  }
  const m = magnitude(def.type, v);
  const lo = def.min !== undefined ? magnitude(def.type, def.min) : undefined;
  const hi = def.max !== undefined ? magnitude(def.type, def.max) : undefined;
  if (m !== undefined && lo !== undefined && m < lo) return `must be at least ${String(def.min)}`;
  if (m !== undefined && hi !== undefined && m > hi) return `must be at most ${String(def.max)}`;
  if (def.enum !== undefined) {
    const key = JSON.stringify(v);
    if (!Array.isArray(def.enum) || !def.enum.some((e) => JSON.stringify(e) === key)) return `must be one of ${JSON.stringify(def.enum)}`;
  }
  return undefined;
}

/** Resolved param values of one recipe (user value, else default), each checked against its ParamDef. */
function resolveParams(body: Recipe, given: Record<string, unknown>): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  const defs = isObj(body.params) ? (body.params as Record<string, ParamDef>) : {};
  for (const [name, def] of Object.entries(defs)) {
    if (!isObj(def)) { errors.push(`param ${name}: invalid definition`); continue; }
    const v = isObj(given) && own(given, name) ? given[name] : def.default;
    const m = paramProblem(def, v);
    if (m) errors.push(`param ${name}: ${m}`);
    else values[name] = v;
  }
  return { values, errors };
}

/** Fields that renderTemplate renders (evaluate.ts): a group action's title and color. `path` ends at the field. */
const isTemplateField = (path: string[]) => path.length >= 2 && path[path.length - 2] === 'group'
  && (path[path.length - 1] === 'title' || path[path.length - 1] === 'color');

/**
 * Deep copy of `x` with `{params.<name>}` placeholders substituted (see the header). Throws ParamError.
 * R37: a string value landing in a template field must not contain `{` or `}` (it would become template structure,
 * and the template language has no escape), so it is a param error.
 */
export function substitute(x: unknown, values: Record<string, unknown>, path: string[] = [], hostParams: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(x) && path.length === 2 && path[0] === 'dedupe' && path[1] === 'urlTransforms') return renderUrlTransforms(x, values, hostParams);
  const lookup = (name: string): unknown => {
    if (!own(values, name)) throw new ParamError(`unknown param: {params.${name}}`);
    const v = values[name];
    if (typeof v === 'string' && /[{}]/.test(v) && isTemplateField(path)) throw new ParamError(`param ${name}: braces are not allowed in values used in templates`);
    return v;
  };
  if (typeof x === 'string') {
    const m = EXACT.exec(x);
    if (m) {
      const v = lookup(m[1] as string);
      return Array.isArray(v) ? [...v] : v;
    }
    return x.replace(INNER, (_s, name: string) => {
      const v = lookup(name);
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new ParamError(`{params.${name}} is a list and cannot be part of a larger string`);
      return String(v);
    });
  }
  if (Array.isArray(x)) {
    return x.flatMap((el) => {
      const m = typeof el === 'string' ? EXACT.exec(el) : null;
      if (m) {
        const v = lookup(m[1] as string);
        return Array.isArray(v) ? [...v] : [v];
      }
      return [substitute(el, values, path, hostParams)];
    });
  }
  if (isObj(x)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = substitute(v, values, [...path, k], hostParams);
    return out;
  }
  return x;
}

/**
 * A param value as a host glob inside a regex (#179), accepting exactly the hosts a URL glob's host accepts (globHost):
 * a leading `*.` is the bare host or any run of host characters then a dot (`(?:[^/?#]*\.)?`), as in a URL glob, the rest an exact canonical `host[:port]`,
 * lowercased (a URL's host always is) and regex-escaped. A path after the host (a context path, `example.com/jira`)
 * is kept, regex-escaped. Undefined for a value that is no such host glob: a `*` anywhere else (mid-host, `*:8080`,
 * `host:*`) or in the path, `? # @ \` or whitespace in the path, or a host no canonical URL has.
 */
export function hostGlobRegex(v: string): string | undefined {
  const cut = v.search(/[/?#]/);
  const g = globHost(cut < 0 ? v : v.slice(0, cut));
  const path = cut < 0 ? '' : v.slice(cut);
  if (!g || /[*?#@\\\s]/.test(path)) return undefined;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (g.sub ? '(?:[^/?#]*\\.)?' : '') + esc(g.host.toLowerCase()) + (g.port ? `:${g.port}` : '') + esc(path);
}

/**
 * A recipe's dedupe.urlTransforms with params substituted (#179). In a `pattern`, a `{params.<name>}` of a
 * `type: string` param (`hostParams`) right after `://` is a host glob (hostGlobRegex), so a rule's
 * `{params.jiraSite}` scopes its fold the way it scopes the rule's url match; a transform with an unusable host value
 * is dropped rather than left to match every host. Any other placeholder in the pattern (another param type, or
 * anywhere else), and every other field, substitutes as anywhere else (plain interpolation).
 */
function renderUrlTransforms(list: unknown[], values: Record<string, unknown>, hostParams: ReadonlySet<string>): unknown[] {
  return list.flatMap((t) => {
    if (!isObj(t) || typeof t.pattern !== 'string') return [substitute(t, values)];
    let usable = true;
    const pattern = t.pattern.replace(INNER, (_s, name: string, at: number, all: string) => {
      if (!own(values, name)) throw new ParamError(`unknown param: {params.${name}}`);
      const v = values[name];
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new ParamError(`{params.${name}} is a list and cannot be part of a larger string`);
      if (all.slice(at - 3, at) !== '://' || !hostParams.has(name)) return String(v);
      const re = hostGlobRegex(String(v));
      if (re === undefined) usable = false;
      return re ?? '';
    });
    return usable ? [{ ...(substitute(t, values) as Record<string, unknown>), pattern }] : [];
  });
}

/** Names of a recipe's `type: string` params: the ones a urlTransform host placeholder renders as a host glob. */
export function stringParams(params: unknown): Set<string> {
  return new Set(isObj(params) ? Object.entries(params).filter(([, d]) => isObj(d) && d.type === 'string').map(([n]) => n) : []);
}

// ---- rules ----

/** A needs.anyOf alternative with its own anyOf (alternatives are one level deep; the schema's `$ref` allows nesting). */
function nestedNeeds(n: unknown): string | undefined {
  if (!isObj(n) || !Array.isArray(n.anyOf)) return undefined;
  return n.anyOf.some((a) => isObj(a) && own(a, 'anyOf')) ? 'needs.anyOf: an alternative cannot have its own anyOf' : undefined;
}

function usesField(c: Cond, kind: 'project' | 'params'): boolean {
  if (!isObj(c)) return false;
  if ('field' in c) return isObj(c.field) && typeof c.field.field === 'string' && c.field.field.startsWith(`${kind}.`);
  if ('all' in c) return Array.isArray(c.all) && c.all.some((x) => usesField(x, kind));
  if ('any' in c) return Array.isArray(c.any) && c.any.some((x) => usesField(x, kind));
  if ('not' in c) return usesField(c.not, kind);
  if ('opener' in c) return usesField(c.opener, kind);
  return false;
}

/** M3 features a valid rule may not use here (see the header). `project` is the recipe's (undefined for user rules). */
function m3Problems(r: Rule, recipe: Pick<Recipe, 'project'> | undefined): string[] {
  const out: string[] = [];
  const assigns = Array.isArray(r.actions) && r.actions.some((a) => isObj(a) && own(a, 'assignProject'));
  if (!recipe) {
    if (own(r, 'source')) out.push('source: only recipe rules can read a source');
    if (assigns) out.push('assignProject: only recipe rules can assign projects');
    if (usesField(r.match, 'params')) out.push('params fields: only recipe rules have params');
  } else if (assigns && !isObj(recipe.project)) out.push('assignProject: the recipe declares no project');
  if (usesField(r.match, 'project')) out.push('project fields are not supported yet');
  const n = nestedNeeds(r.needs);
  if (n) out.push(n);
  return out;
}

/**
 * Schema + post-check problems of one rule, as "<path> <message>" strings (empty when valid). Reported joined, one entry
 * per rule. `params`: the declared param names of a recipe rule's recipe; undefined for a user rule.
 */
function ruleErrors(rule: unknown, tables: Tables, params?: ReadonlySet<string>): string[] {
  if (!validateRule(rule)) return (validateRule.errors ?? []).map(formatSchemaError);
  return ruleProblems(rule as Rule, tables, params).map((p) => `${p.path} ${p.message}`);
}

interface Candidate { id: string; source: RecipeRef['source']; body: Recipe; ref: RecipeRef; values: Record<string, unknown>; defs: Record<string, ParamDef> }

/**
 * Whether a recipe rule runs (R56/R57): the user's boolean override `ref.ruleEnabled[rule.id]`, else the body's
 * `enabled`, which counts as on unless it is `false` (a body rule without `enabled` is "on" and then fails
 * validation, as before R56). The one effective-state rule: compileProgram, the Rules page and the Recipes page use it.
 */
export function ruleOn(ref: Pick<RecipeRef, 'ruleEnabled'>, rule: Pick<Rule, 'id' | 'enabled'>): boolean {
  const o: unknown = isObj(ref.ruleEnabled) && own(ref.ruleEnabled, rule.id) ? ref.ruleEnabled[rule.id] : undefined;
  return typeof o === 'boolean' ? o : rule.enabled !== false;
}

/** Enabled recipes with their params substituted; failures go to `errors`, tolerated-but-ignored input to `warnings`. */
function resolveRecipes(config: Config, builtins: Record<string, Recipe>, errors: CompileError[], warnings: CompileError[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const ref of Array.isArray(config.recipes) ? config.recipes : []) {
    if (!isObj(ref) || !ref.enabled) continue;
    const id = String(ref.id);
    if (id === 'user') { errors.push({ key: id, error: 'recipe id "user" is reserved' }); continue; } // user rule keys are user/<id> (R19)
    if (seen.has(id)) { errors.push({ key: id, error: 'duplicate recipe id' }); continue; }
    seen.add(id);
    const raw = ref.source === 'builtin' ? (own(builtins, id) ? builtins[id] : undefined) : ref.body;
    if (!isObj(raw) || !Array.isArray(raw.rules)) {
      errors.push({ key: id, error: raw === undefined ? (ref.source === 'builtin' ? 'unknown built-in recipe' : 'recipe has no body') : 'malformed recipe' });
      continue;
    }
    const { values, errors: perr } = resolveParams(raw, ref.params);
    if (perr.length) { for (const e of perr) errors.push({ key: id, error: e }); continue; }
    const rest: Record<string, unknown> = { ...raw };
    delete rest.params; // param defaults are values, never substituted
    let body: Recipe;
    try {
      body = substitute(rest, values, [], stringParams(raw.params)) as Recipe;
    } catch (e) {
      if (!(e instanceof ParamError)) throw e;
      errors.push({ key: id, error: e.message });
      continue;
    }
    if (body.tables !== undefined && !isObj(body.tables)) { errors.push({ key: id, error: 'malformed tables' }); continue; }
    const transforms: unknown = isObj(body.dedupe) ? body.dedupe.urlTransforms : undefined;
    if (transforms !== undefined && !Array.isArray(transforms)) { errors.push({ key: id, error: 'malformed dedupe.urlTransforms' }); continue; }
    const strs = (x: unknown) => x === undefined || (Array.isArray(x) && x.every((s) => typeof s === 'string'));
    const needsOk = (n: unknown): boolean => isObj(n) && strs(n.hosts) && strs(n.permissions) && strs(n.connections);
    if (body.needs !== undefined && !(needsOk(body.needs) && (body.needs.anyOf === undefined || (Array.isArray(body.needs.anyOf) && body.needs.anyOf.every(needsOk))))) {
      errors.push({ key: id, error: 'malformed needs' });
      continue;
    }
    const nested = nestedNeeds(body.needs);
    if (nested) { errors.push({ key: id, error: nested }); continue; }
    const list = (transforms ?? []) as unknown[];
    const badAt = list.findIndex((t) => !isObj(t) || typeof t.pattern !== 'string' || typeof t.replacement !== 'string' || (t.flags !== undefined && typeof t.flags !== 'string') || regexProblem(t.pattern, t.flags as string | undefined) !== undefined);
    if (badAt >= 0) {
      const bad = list[badAt];
      errors.push({ key: id, error: `invalid urlTransform pattern: ${String(isObj(bad) ? bad.pattern : bad)}` });
      continue;
    }
    if (body.views !== undefined && !(Array.isArray(body.views) && body.views.every(isObj))) { errors.push({ key: id, error: 'malformed views' }); continue; }
    if (isObj(body.project)) {
      if (body.project.container === 'window') { errors.push({ key: id, error: 'window projects are not supported yet' }); continue; } // until M4 T15
      for (const name of Object.keys(body.project)) {
        if (!PROJECT_FIELDS.has(name)) warnings.push({ key: id, error: `project field ${name} is not supported by this version` });
      }
    }
    out.push({ id, source: ref.source, body, ref, values, defs: isObj(raw.params) ? (raw.params as Record<string, ParamDef>) : {} });
  }
  return withoutConflicts(out, errors);
}

/**
 * The enabled recipes of `config` that conflict with recipe `id` (either side lists the other, M3-R17): what enabling
 * `id` turns off (recipes.enable and its preview, so the two never disagree).
 */
export function conflictingRecipes(config: Pick<Config, 'recipes'>, id: string, builtins: Record<string, Recipe>): string[] {
  const bodyOf = (r: RecipeRef): unknown => (r.source === 'builtin' ? (own(builtins, r.id) ? builtins[r.id] : undefined) : r.body);
  const lists = (r: RecipeRef | undefined): unknown[] => {
    const b = r && bodyOf(r);
    return isObj(b) && Array.isArray(b.conflicts) ? b.conflicts : [];
  };
  const recipes = Array.isArray(config.recipes) ? config.recipes.filter(isObj) : [];
  const self = recipes.find((r) => r.id === id);
  return recipes.filter((r) => r.id !== id && r.enabled && (lists(self).includes(r.id) || lists(r).includes(id))).map((r) => r.id);
}

/** `recipes` minus each one that conflicts with an earlier kept one (either side lists the other, M3-R17). */
function withoutConflicts(recipes: Candidate[], errors: CompileError[]): Candidate[] {
  const lists = (c: Candidate): unknown[] => (Array.isArray(c.body.conflicts) ? c.body.conflicts : []);
  const kept: Candidate[] = [];
  for (const c of recipes) {
    const other = kept.find((k) => lists(k).includes(c.id) || lists(c).includes(k.id));
    if (other) errors.push({ key: c.id, error: `conflicts with recipe "${other.id}"; both are enabled` });
    else kept.push(c);
  }
  return kept;
}

/** Tables merged builtin recipes → user recipes → config.tables; later wins per entry. */
function mergeTables(recipes: Candidate[], config: Config): Tables {
  const out: Tables = {};
  const add = (t: Tables | undefined) => {
    for (const [name, entries] of Object.entries(t ?? {})) if (isObj(entries)) out[name] = { ...(out[name] ?? {}), ...entries };
  };
  for (const src of ['builtin', 'user'] as const) for (const r of recipes) if (r.source === src) add(r.body.tables);
  add(isObj(config.tables) ? config.tables : undefined);
  return out;
}

/**
 * Entries by key; a key collision (not reachable through compileProgram's own checks; defense in depth) keeps the
 * first entry and reports the later one instead of silently replacing it. Exported for tests.
 */
export function indexByKey<E extends { key: string }>(entries: E[], errors: CompileError[]): Map<string, E> {
  const out = new Map<string, E>();
  for (const e of entries) {
    if (out.has(e.key)) errors.push({ key: e.key, error: 'duplicate rule key' });
    else out.set(e.key, e);
  }
  return out;
}

/** Compile `config` (+ built-in recipe bodies) into a prioritized Program. Pure; never throws on bad data. */
export function compileProgram(
  config: Config, builtins: Record<string, Recipe>, opts: CompileOptions = {},
): { program: Program; errors: CompileError[]; warnings: CompileError[] } {
  const errors: CompileError[] = [];
  const warnings: CompileError[] = []; // input this version ignores (e.g. unknown project fields); the recipe still compiles
  const paused = opts.paused ?? new Set<string>();
  const candidates = resolveRecipes(config, builtins, errors, warnings);
  const checkTables = mergeTables(candidates, config);

  // Recipe rules: any invalid enabled rule (or a duplicate id) skips the whole recipe.
  const recipes: { c: Candidate; rules: Rule[] }[] = [];
  for (const c of candidates) {
    const errs: CompileError[] = [];
    const ids = new Set<string>();
    const rules: Rule[] = [];
    const declared = new Set(Object.keys(c.defs));
    c.body.rules.forEach((raw, i) => {
      const key = `${c.id}/${isObj(raw) && typeof raw.id === 'string' ? raw.id : `#${i}`}`;
      if (!isObj(raw) || !ruleOn(c.ref, raw)) return; // effectively off (R56): no needs, never compiled
      // R57: the body is validated as written; only a rule the user turned on against its body (`enabled: false`) is
      // compiled as a copy with `enabled: true`. Nothing is filled in (a body rule without `enabled` stays invalid).
      const turnedOn = raw.enabled === false;
      const r: Rule = turnedOn ? { ...raw, enabled: true } : raw;
      const es = ruleErrors(r, checkTables, declared);
      if (!es.length) es.push(...m3Problems(r, c.body));
      if (ids.has(r.id)) es.push('duplicate rule id');
      ids.add(r.id);
      // An invalid body rule is the author's error and skips the recipe; a rule only the user turned on that does not
      // compile is reported for its key and skipped alone (R57), so the toggle cannot break the rest of the recipe.
      if (es.length) (turnedOn ? errors : errs).push({ key, error: es.join('; ') });
      else {
        const match = foldParams(r.match, c.values); // validated first: the folded constants are runtime-only
        rules.push(match === r.match ? r : { ...r, match });
      }
    });
    if (errs.length) errors.push(...errs);
    else recipes.push({ c, rules });
  }

  // User rules: an invalid one is skipped alone.
  const userRules: Rule[] = [];
  const userIds = new Set<string>();
  for (const r of Array.isArray(config.rules) ? config.rules : []) {
    if (!isObj(r) || !r.enabled) continue;
    const key = `user/${String(r.id)}`;
    const es = ruleErrors(r, checkTables);
    if (own(r, 'needs')) es.push('needs: only recipe rules can declare needs');
    else if (!es.length) es.push(...m3Problems(r, undefined));
    if (userIds.has(r.id)) es.push('duplicate rule id');
    userIds.add(r.id);
    if (es.length) errors.push({ key, error: es.join('; ') });
    else userRules.push(r);
  }

  // Priority.
  type Entry = Omit<CompiledRule, 'index'>;
  const entries: Entry[] = [];
  const dry = (r: Rule) => r.dryRun === true || config.dryRun === true;
  for (const r of userRules) entries.push({ key: `user/${r.id}`, rule: r, dryRun: dry(r) });
  for (const { c, rules } of recipes) for (const r of rules) entries.push({ key: `${c.id}/${r.id}`, rule: r, recipeId: c.id, dryRun: dry(r) });
  const byKey = indexByKey(entries.filter((e) => !paused.has(e.key) && !(e.recipeId && paused.has(e.recipeId))), errors);
  const ordered: Entry[] = [];
  const placed = new Set<string>();
  const place = (k: string) => {
    const e = byKey.get(k);
    if (!e || placed.has(k)) return;
    placed.add(k);
    ordered.push(e);
  };
  for (const k of Array.isArray(config.order) ? config.order : []) place(k);
  for (const e of entries) place(e.key); // missing keys: user rules, then recipe rules (entries order)

  const survivors = recipes.map((x) => x.c);
  const dedupe: DedupeSettings = {
    ...config.dedupe,
    urlTransforms: [...(config.dedupe?.urlTransforms ?? []), ...survivors.flatMap((c) => c.body.dedupe?.urlTransforms ?? [])],
  };
  const needs: Program['needs'] = {};
  const altOf = (n: RecipeNeeds | undefined): NeedsAlt => ({
    origins: [...(n?.hosts ?? [])], permissions: [...(n?.permissions ?? [])], ...(n?.connections && { connections: [...n.connections] }),
  });
  const needsOf = (n: RecipeNeeds | undefined): NeedsEntry => ({ ...altOf(n), ...(n?.anyOf && { anyOf: n.anyOf.map(altOf) }) });
  const levels: Record<string, RecipeLevel[]> = {};
  for (const { c, rules } of recipes) {
    needs[c.id] = needsOf(c.body.needs);
    for (const r of rules) if (r.needs) needs[`${c.id}/${r.id}`] = needsOf(r.needs); // paused rules too
    if (c.body.levels) levels[c.id] = c.body.levels;
  }
  // M3 T15: what the ProjectService needs of a project recipe (its def). Params (T13): the resolved values of every
  // recipe that declares any, read by the ProjectService, view `params.*` fields and the sources.refresh period.
  const projects = survivors.filter((c) => isObj(c.body.project)).map((c): ProjectDef => {
    const p = c.body.project!; // an object: a non-object `project` is ignored like any malformed optional field
    const given = Object.fromEntries(Object.keys(PROJECT_DEFAULTS).filter((k) => own(p, k)).map((k) => [k, p[k as keyof typeof PROJECT_DEFAULTS]]));
    return { ...PROJECT_DEFAULTS, placement: [...PROJECT_DEFAULTS.placement], ...given, key: p.key, title: p.title, color: p.color, container: p.container, join: p.join, recipeId: c.id }; // unknown fields dropped
  });
  const params = Object.fromEntries(survivors.filter((c) => Object.keys(c.values).length > 0).map((c) => [c.id, c.values]));
  // M3-R75 / M3-R78: the sources.refresh period, only from recipes that declare `refreshEvery` as a duration param.
  const refreshEvery = Object.fromEntries(survivors
    .filter((c) => own(c.defs, 'refreshEvery') && c.defs.refreshEvery?.type === 'duration' && typeof c.values.refreshEvery === 'string')
    .map((c) => [c.id, c.values.refreshEvery as string]));

  return {
    program: {
      rules: ordered.map((e, index) => ({ ...e, index })),
      views: survivors.flatMap((c) => (c.body.views ?? []).map((v) => ({ ...v, recipeId: c.id }))),
      tables: mergeTables(survivors, config),
      dedupe,
      needs,
      ...(Object.keys(levels).length && { levels }),
      ...(projects.length && { projects }),
      ...(Object.keys(params).length && { params }),
      ...(Object.keys(refreshEvery).length && { refreshEvery }),
      dryRun: config.dryRun === true,
    },
    errors,
    warnings,
  };
}
