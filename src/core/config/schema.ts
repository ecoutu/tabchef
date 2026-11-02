import type { Config, DedupeSettings } from '../types';
import type { Rule } from '../lang/types';
import schema from './config.schema.json';
import { validate, validateRule } from './validate-config.generated.js';
import { validateRecipe } from '../lang/schema';
import { dedupeProblems, formatSchemaError, ruleProblems, type Problem, type Tables } from './rule-problems';

// The rule, regex, pattern and schema-error checks live in rule-problems.ts (no dependency on lang/schema, which
// imports them); re-exported here for existing importers.
export {
  AGE_MSG, COLORS, dedupeProblems, formatSchemaError, MAX_EXTRACT_NAME, MAX_PAGE_TEXT, regexProblem, ruleProblems,
  ruleTitleProblems, schemaProblem, type Problem, type Tables,
} from './rule-problems';

export const configJsonSchema = schema;

export type ValidationResult = { ok: true; config: Config } | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);


/** Message of a dedupe problem as validateConfig reports it: M1's wording for a urlTransform regex that does not compile. */
function dedupeError(p: Problem, d: DedupeSettings): string {
  const t = /^\/urlTransforms\/(\d+)\/pattern$/.exec(p.path);
  if (t && !p.message.startsWith('regex too long')) return `invalid urlTransform pattern: ${d.urlTransforms[Number(t[1])]?.pattern ?? ''}`;
  return `/dedupe${p.path} ${p.message}`;
}

const DEDUPE_LISTS = ['urlTransforms', 'fragmentOverrides', 'titleOverrides'] as const;

/**
 * Load-path repair of the dedupe lists: entries with a dedupeProblems problem (an over-long or broken regex/pattern
 * from older stored data) are removed, with a warning, so the rest of the config still loads (the pre-repair
 * original is what the load path backs up). Structurally malformed dedupe is left for validateConfig.
 */
function repairDedupe(input: unknown): { dedupe: unknown; removed: string[] } {
  if (!isObj(input) || !DEDUPE_LISTS.every((k) => Array.isArray(input[k]) && (input[k] as unknown[]).every((e) => isObj(e) && typeof e.pattern === 'string'))) {
    return { dedupe: input, removed: [] };
  }
  const d = input as unknown as DedupeSettings;
  const bad = dedupeProblems(d);
  if (!bad.length) return { dedupe: input, removed: [] };
  const drop = new Set(bad.map((p) => p.path));
  const out: Record<string, unknown> = { ...input };
  for (const k of DEDUPE_LISTS) out[k] = (d[k] as { pattern: string }[]).filter((_, i) => !drop.has(`/${k}/${i}/pattern`));
  return { dedupe: out, removed: bad.map((p) => `${p.path.replace(/\/pattern$/, '').slice(1)} (${p.message})`) };
}

const tablesOf = (input: Record<string, unknown>): Tables | undefined => (isObj(input.tables) ? (input.tables as Tables) : undefined);

/**
 * Load-path repair for stored data (sync, lastGood, backups), run after migrateConfig: an enabled rule with
 * problems (title, pattern, regex, duration, color) is DISABLED, never dropped, so a config saved by an older,
 * laxer version still loads instead of falling back to defaults (which the next edit would then write over sync).
 * Strict checks apply to enabled rules only, so the result validates. Malformed input is returned unchanged for
 * validateConfig to report. Does not mutate its input.
 */
export function repairConfig(input: unknown): { config: unknown; warnings: string[] } {
  if (!isObj(input) || !Array.isArray(input.rules)) return { config: input, warnings: [] };
  const names: string[] = [];
  const rules = input.rules.map((r: unknown) => {
    if (!isObj(r) || r.enabled !== true || !validateRule(r) || ruleProblems(r as unknown as Rule, tablesOf(input)).length === 0) return r;
    names.push(typeof r.name === 'string' && r.name !== '' ? r.name : String(r.id));
    return { ...r, enabled: false };
  });
  const recipes = repairRecipes(input.recipes);
  const dedupe = repairDedupe(input.dedupe);
  const warnings: string[] = [];
  if (names.length) warnings.push(`${names.length} rule(s) disabled: ${names.join(', ')} — fix them on the Rules page.`);
  if (recipes.disabled.length) warnings.push(`${recipes.disabled.length} recipe(s) disabled: ${recipes.disabled.join(', ')} — fix them, then re-enable.`);
  if (dedupe.removed.length) warnings.push(`${dedupe.removed.length} dedupe setting(s) removed: ${dedupe.removed.join(', ')} — restore the previous version from Backups to recover them.`);
  if (!warnings.length) return { config: input, warnings };
  return {
    config: { ...input, rules, ...(recipes.disabled.length ? { recipes: recipes.recipes } : {}), ...(dedupe.removed.length ? { dedupe: dedupe.dedupe } : {}) },
    warnings,
  };
}

/** Problems of a stored recipe entry's body, as config-relative "<path> <message>" strings (none when it has no body). */
function recipeBodyErrors(body: unknown, i: number): string[] {
  if (body === undefined) return [];
  const v = validateRecipe(body);
  return v.ok ? [] : v.errors.map((e) => `/recipes/${i}/body${e.path === '/' ? '' : e.path} ${e.message}`);
}

/**
 * R41: stored config keeps `recipes[].body` loose in the schema; each enabled entry's body is checked here with
 * validateRecipe. An invalid one is DISABLED (kept, never dropped), and its errors go into the warning, the way
 * repairConfig handles rules. Built-in entries carry no body and are left alone.
 */
function repairRecipes(input: unknown): { recipes: unknown; disabled: string[] } {
  if (!Array.isArray(input)) return { recipes: input, disabled: [] };
  const disabled: string[] = [];
  const recipes = input.map((r: unknown) => {
    if (!isObj(r) || r.enabled !== true || r.body === undefined) return r;
    const v = validateRecipe(r.body);
    if (v.ok) return r;
    disabled.push(`${String(r.id)} (${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')})`);
    return { ...r, enabled: false };
  });
  return { recipes, disabled };
}

/**
 * Strict validation for saves and imports (input must be v2; stored data goes through migrateConfig first).
 * Post-schema checks (patterns, regexes, durations, colors, titles) apply to enabled rules only: a disabled rule
 * never runs, and stored data may hold such rules (see repairConfig).
 */
export function validateConfig(input: unknown): ValidationResult {
  if (!validate(input)) return { ok: false, errors: (validate.errors ?? []).map(formatSchemaError) };
  const config = input as unknown as Config;
  const errors: string[] = [];
  const seen = new Set<string>();
  config.rules.forEach((r, i) => {
    if (seen.has(r.id)) errors.push(`/rules/${i}/id duplicate rule id: ${r.id}`);
    seen.add(r.id);
    if (r.enabled) for (const p of ruleProblems(r, config.tables)) errors.push(`/rules/${i}${p.path} ${p.message}`);
  });
  config.recipes.forEach((r, i) => { if (r.enabled) errors.push(...recipeBodyErrors(r.body, i)); });
  config.order.forEach((k, i) => { if (config.order.indexOf(k) !== i) errors.push(`/order/${i} duplicate key: ${k}`); });
  for (const p of dedupeProblems(config.dedupe)) errors.push(dedupeError(p, config.dedupe));
  return errors.length ? { ok: false, errors } : { ok: true, config };
}
