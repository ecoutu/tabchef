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
// (`'PR {params.prefix}'`) is plain string interpolation. Substitution runs before anything compiles; afterwards
// every rule goes through the same checks as a user rule (validateRule + ruleProblems).
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
// config.recipes is reported and skipped (M3-R17).
//
// Errors: a broken recipe (unknown body, bad param, unknown placeholder, invalid rule, bad urlTransform) is reported
// in `errors` and skipped as a whole (rules, tables, views, needs); a broken user rule is reported and skipped alone.
//
// Pattern matchers are compiled once per pattern string and cached by compilePattern / compileTextPattern
// (src/core/match/pattern.ts); validation here warms the URL pattern cache. Memoizing whole Programs is the
// engine's job (ProgramCache, T6).
import { formatSchemaError, regexProblem, ruleProblems, type Tables } from '../config/rule-problems';
import { validateRule } from '../config/validate-config.generated.js';
import { DURATION } from './duration';
import type { Config, DedupeSettings } from '../types';
import type { CompiledRule, Cond, NeedsAlt, NeedsEntry, ParamDef, Program, Recipe, RecipeLevel, RecipeNeeds, RecipeRef, Rule } from './types';
import type { ProjectDef } from '../projects/types';

export interface CompileError { key: string; error: string }
export interface CompileOptions {
  /** Rule keys and/or recipe ids to leave out of the program (e.g. waiting for a permission, T8). */
  paused?: Set<string>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A param problem found while substituting placeholders. Exported for validateRecipe (src/core/lang/schema.ts). */
export class ParamError extends Error {}

// ---- params ----

const EXACT = /^\{params\.([A-Za-z_]\w*)\}$/;
const INNER = /\{params\.([A-Za-z_]\w*)\}/g;
/** Param names of the `{params.<name>}` placeholders in a string. */
export const placeholderNames = (s: string): string[] => [...s.matchAll(INNER)].map((m) => m[1] as string);

/** Why `v` is not a valid value for `def`, or undefined. */
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
export function substitute(x: unknown, values: Record<string, unknown>, path: string[] = []): unknown {
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
      return [substitute(el, values, path)];
    });
  }
  if (isObj(x)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = substitute(v, values, [...path, k]);
    return out;
  }
  return x;
}

// ---- rules ----

/** A needs.anyOf alternative with its own anyOf (alternatives are one level deep; the schema's `$ref` allows nesting). */
function nestedNeeds(n: unknown): string | undefined {
  if (!isObj(n) || !Array.isArray(n.anyOf)) return undefined;
  return n.anyOf.some((a) => isObj(a) && own(a, 'anyOf')) ? 'needs.anyOf: an alternative cannot have its own anyOf' : undefined;
}

function usesProjectField(c: Cond): boolean {
  if (!isObj(c)) return false;
  if ('field' in c) return isObj(c.field) && typeof c.field.field === 'string' && c.field.field.startsWith('project.');
  if ('all' in c) return Array.isArray(c.all) && c.all.some(usesProjectField);
  if ('any' in c) return Array.isArray(c.any) && c.any.some(usesProjectField);
  if ('not' in c) return usesProjectField(c.not);
  if ('opener' in c) return usesProjectField(c.opener);
  return false;
}

/** M3 features a valid rule may not use here (see the header). `project` is the recipe's (undefined for user rules). */
function m3Problems(r: Rule, recipe: Pick<Recipe, 'project'> | undefined): string[] {
  const out: string[] = [];
  const assigns = Array.isArray(r.actions) && r.actions.some((a) => isObj(a) && own(a, 'assignProject'));
  if (!recipe) {
    if (own(r, 'source')) out.push('source: only recipe rules can read a source');
    if (assigns) out.push('assignProject: only recipe rules can assign projects');
  } else if (assigns && recipe.project === undefined) out.push('assignProject: the recipe declares no project');
  if (usesProjectField(r.match)) out.push('project fields are not supported yet');
  const n = nestedNeeds(r.needs);
  if (n) out.push(n);
  return out;
}

/** Schema + post-check problems of one rule, as "<path> <message>" strings (empty when valid). Reported joined, one entry per rule. */
function ruleErrors(rule: unknown, tables: Tables): string[] {
  if (!validateRule(rule)) return (validateRule.errors ?? []).map(formatSchemaError);
  return ruleProblems(rule as Rule, tables).map((p) => `${p.path} ${p.message}`);
}

interface Candidate { id: string; source: RecipeRef['source']; body: Recipe; ref: RecipeRef; values: Record<string, unknown> }

/**
 * Whether a recipe rule runs (R56/R57): the user's boolean override `ref.ruleEnabled[rule.id]`, else the body's
 * `enabled`, which counts as on unless it is `false` (a body rule without `enabled` is "on" and then fails
 * validation, as before R56). The one effective-state rule: compileProgram, the Rules page and the Recipes page use it.
 */
export function ruleOn(ref: Pick<RecipeRef, 'ruleEnabled'>, rule: Pick<Rule, 'id' | 'enabled'>): boolean {
  const o: unknown = isObj(ref.ruleEnabled) && own(ref.ruleEnabled, rule.id) ? ref.ruleEnabled[rule.id] : undefined;
  return typeof o === 'boolean' ? o : rule.enabled !== false;
}

/** Enabled recipes with their params substituted; failures go to `errors`. */
function resolveRecipes(config: Config, builtins: Record<string, Recipe>, errors: CompileError[]): Candidate[] {
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
      body = substitute(rest, values) as Recipe;
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
    out.push({ id, source: ref.source, body, ref, values });
  }
  return withoutConflicts(out, errors);
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
): { program: Program; errors: CompileError[] } {
  const errors: CompileError[] = [];
  const paused = opts.paused ?? new Set<string>();
  const candidates = resolveRecipes(config, builtins, errors);
  const checkTables = mergeTables(candidates, config);

  // Recipe rules: any invalid enabled rule (or a duplicate id) skips the whole recipe.
  const recipes: { c: Candidate; rules: Rule[] }[] = [];
  for (const c of candidates) {
    const errs: CompileError[] = [];
    const ids = new Set<string>();
    const rules: Rule[] = [];
    c.body.rules.forEach((raw, i) => {
      const key = `${c.id}/${isObj(raw) && typeof raw.id === 'string' ? raw.id : `#${i}`}`;
      if (!isObj(raw) || !ruleOn(c.ref, raw)) return; // effectively off (R56): no needs, never compiled
      // R57: the body is validated as written; only a rule the user turned on against its body (`enabled: false`) is
      // compiled as a copy with `enabled: true`. Nothing is filled in (a body rule without `enabled` stays invalid).
      const turnedOn = raw.enabled === false;
      const r: Rule = turnedOn ? { ...raw, enabled: true } : raw;
      const es = ruleErrors(r, checkTables);
      if (!es.length) es.push(...m3Problems(r, c.body));
      if (ids.has(r.id)) es.push('duplicate rule id');
      ids.add(r.id);
      // An invalid body rule is the author's error and skips the recipe; a rule only the user turned on that does not
      // compile is reported for its key and skipped alone (R57), so the toggle cannot break the rest of the recipe.
      if (es.length) (turnedOn ? errors : errs).push({ key, error: es.join('; ') });
      else rules.push(r);
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
    if (own(r, 'needs')) es.push('needs: only recipe rules declare needs (R44)');
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
  // M3 T15: what the ProjectService needs of a project recipe (its def and params; Program carries no params otherwise).
  const withProject = survivors.filter((c) => c.body.project !== undefined);
  const projects = withProject.map((c): ProjectDef => ({ ...c.body.project!, recipeId: c.id }));
  const params = Object.fromEntries(withProject.map((c) => [c.id, c.values]));

  return {
    program: {
      rules: ordered.map((e, index) => ({ ...e, index })),
      views: survivors.flatMap((c) => (c.body.views ?? []).map((v) => ({ ...v, recipeId: c.id }))),
      tables: mergeTables(survivors, config),
      dedupe,
      needs,
      ...(Object.keys(levels).length && { levels }),
      ...(projects.length && { projects, params }),
      dryRun: config.dryRun === true,
    },
    errors,
  };
}
