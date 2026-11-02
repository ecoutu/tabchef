import type { Config, DedupeSettings, GroupColor } from '../types';
import type { Cond, Rule } from '../lang/types';
import { compilePattern, MAX_REGEX_LEN, PatternError, patternCaptures } from '../match/pattern';
import { slowRegexProblem } from '../match/regex-safety';
import { DURATION } from '../lang/duration';
import { parseTemplate, TemplateError, templateTables, templateVars } from '../match/template';
import schema from './config.schema.json';
import { validate, validateRule, type ValidateError } from './validate-config.generated.js';
// Import cycle (lang/schema imports this module): only functions cross it, none run at module load.
import { validateRecipe } from '../lang/schema';

export const configJsonSchema = schema;

export type ValidationResult = { ok: true; config: Config } | { ok: false; errors: string[] };

/** The 9 Chrome tab-group colors. */
export const COLORS: ReadonlySet<string> = new Set<string>(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] satisfies GroupColor[]);
const DURATION_MSG = 'must be a duration like 500ms, 30s, 15m, 2h or 1d';
export const AGE_MSG = 'age conditions are not supported yet';
/** Caps on what the watch content script can report (MAX_FACT_TEXT in src/engine/messages.ts; core can't import it). */
export const MAX_PAGE_TEXT = 500;
export const MAX_EXTRACT_NAME = 64;
const PAGE_TEXT_MSG = `must be at most ${MAX_PAGE_TEXT} characters`;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const list = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** A problem at a JSON pointer relative to the rule (e.g. '/match/url/1'). */
export interface Problem { path: string; message: string }

function patternProblem(p: string): string | undefined {
  try {
    compilePattern(p);
    return undefined;
  } catch (e) {
    if (e instanceof PatternError) return e.message;
    throw e;
  }
}
/**
 * Error for a regex that does not compile, that has a nested unbounded quantifier (R67, slowRegexProblem), or, when
 * `capped`, whose text (`measured`, default `source`) exceeds MAX_REGEX_LEN. Rule regexes and dedupe urlTransforms (T18) are capped; stored over-long ones are removed on load
 * (repairConfig) instead of failing the whole config.
 */
export function regexProblem(source: string, flags?: string, capped = false, measured = source): string | undefined {
  if (capped && measured.length > MAX_REGEX_LEN) return `regex too long (max ${MAX_REGEX_LEN} characters)`;
  try {
    new RegExp(source, flags);
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }
  return slowRegexProblem(source); // R67
}

export type Tables = Record<string, Record<string, string>>;

/** Template syntax problem (unknown filter, bad arguments) or a `map:` table that is not defined (when tables are known). */
function templateProblem(t: string, tables?: Tables): string | undefined {
  try {
    parseTemplate(t);
  } catch (e) {
    if (e instanceof TemplateError) return e.message;
    throw e;
  }
  if (tables) {
    const missing = templateTables(t).find((n) => !Object.prototype.hasOwnProperty.call(tables, n));
    if (missing !== undefined) return `unknown table: ${missing}`;
  }
  return undefined;
}

/** Url patterns anywhere in a condition tree. */
function urlPatterns(c: Cond): string[] {
  if ('url' in c) return list(c.url);
  if ('all' in c) return c.all.flatMap(urlPatterns);
  if ('any' in c) return c.any.flatMap(urlPatterns);
  if ('not' in c) return urlPatterns(c.not);
  return [];
}

/** Named groups of `/regex/` title patterns anywhere in a condition tree (they add captures, M2 T3/R6). */
function titleRegexGroups(c: Cond): string[] {
  if ('title' in c) {
    const t = c.title;
    if (!(t.length >= 2 && t.startsWith('/') && t.lastIndexOf('/') > 0)) return [];
    return [...t.slice(1, t.lastIndexOf('/')).matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((m) => m[1] as string);
  }
  if ('all' in c) return c.all.flatMap(titleRegexGroups);
  if ('any' in c) return c.any.flatMap(titleRegexGroups);
  if ('not' in c) return titleRegexGroups(c.not);
  return [];
}

function condProblems(c: Cond, path: string, out: Problem[]): void {
  if ('url' in c) {
    if (Array.isArray(c.url)) c.url.forEach((p, i) => { const m = patternProblem(p); if (m) out.push({ path: `${path}/url/${i}`, message: m }); });
    else { const m = patternProblem(c.url); if (m) out.push({ path: `${path}/url`, message: m }); }
  } else if ('title' in c) {
    // Title patterns compile with the text matcher (M2 T2/R6); only a /regex/ is checkable here.
    const t = c.title;
    if (t.length >= 2 && t.startsWith('/') && t.lastIndexOf('/') > 0) {
      const m = regexProblem(t.slice(1, t.lastIndexOf('/')), t.slice(t.lastIndexOf('/') + 1), true, t);
      if (m) out.push({ path: `${path}/title`, message: m });
    }
  } else if ('age' in c) {
    // R66: nothing feeds TabFacts.createdAt yet (M3), so an age condition would be dead, or inverted under `not`.
    out.push({ path: `${path}/age`, message: AGE_MSG });
    for (const k of ['gt', 'lt'] as const) {
      const v = c.age[k];
      if (v !== undefined && !DURATION.test(v)) out.push({ path: `${path}/age/${k}`, message: DURATION_MSG });
    }
  } else if ('pageText' in c) {
    // I2: the watch reports needles up to MAX_FACT_TEXT (src/engine/messages.ts); a longer one could never match.
    const long = (n: string) => n.length > MAX_PAGE_TEXT;
    if (Array.isArray(c.pageText)) c.pageText.forEach((n, i) => { if (long(n)) out.push({ path: `${path}/pageText/${i}`, message: PAGE_TEXT_MSG }); });
    else if (long(c.pageText)) out.push({ path: `${path}/pageText`, message: PAGE_TEXT_MSG });
  } else if ('opener' in c) condProblems(c.opener, `${path}/opener`, out);
  else if ('not' in c) condProblems(c.not, `${path}/not`, out);
  else if ('all' in c) c.all.forEach((x, i) => condProblems(x, `${path}/all/${i}`, out));
  else if ('any' in c) c.any.forEach((x, i) => condProblems(x, `${path}/any/${i}`, out));
}

/**
 * Title problems of one group action: an empty title, or a `{var}` that the rule does not provide (varProblems).
 */
function titleProblems(rule: Rule, title: string, tables?: Tables): string[] {
  if (title === '') return ['must not be empty'];
  const tp = templateProblem(title, tables);
  if (tp) return [tp];
  return varProblems(rule, title);
}

/**
 * `{var}`s of a template that neither the rule's url patterns, its title-regex named groups nor its `extract` names
 * provide. For an M1-shaped url-only match every pattern must capture the var (any of them may be the one that
 * matched); for other conditions any url pattern or title regex capturing it is enough. Patterns that do not compile
 * are reported elsewhere and skipped here.
 */
function varProblems(rule: Rule, template: string): string[] {
  const extracted = new Set(Object.keys(rule.extract ?? {}));
  const out: string[] = [];
  const vars = templateVars(template).filter((v) => !extracted.has(v));
  if ('url' in rule.match) {
    for (const v of vars) {
      for (const p of list(rule.match.url)) {
        const caps = patternCaptures(p);
        if (caps && !caps.has(v)) out.push(`uses {${v}}, which pattern "${p}" does not capture`);
      }
    }
    return out;
  }
  const caps = new Set([...urlPatterns(rule.match).flatMap((p) => [...(patternCaptures(p) ?? [])]), ...titleRegexGroups(rule.match)]);
  for (const v of vars) if (!caps.has(v)) out.push(`uses {${v}}, which no url pattern, title regex or extract provides`);
  return out;
}

/** Title problems of every group action of a rule (messages only; see titleProblems). */
export function ruleTitleProblems(rule: Rule, tables?: Tables): string[] {
  return rule.actions.flatMap((a) => ('group' in a ? titleProblems(rule, a.group.title, tables) : []));
}

/**
 * Post-schema problems of a structurally valid rule: patterns, regexes, durations, colors and titles (and the
 * `{var}`s titles and colors use). Shared by validateConfig, repairConfig and the compiler (src/core/lang/compile.ts).
 */
export function ruleProblems(rule: Rule, tables?: Tables): Problem[] {
  const out: Problem[] = [];
  condProblems(rule.match, '/match', out);
  if (rule.trigger?.every !== undefined && !DURATION.test(rule.trigger.every)) out.push({ path: '/trigger/every', message: DURATION_MSG });
  // Uniqueness is checked here, not with JSON-schema uniqueItems: ajv's standalone code for it needs a runtime require().
  rule.trigger?.on.forEach((k, j, all) => { if (all.indexOf(k) !== j) out.push({ path: `/trigger/on/${j}`, message: `duplicate trigger: ${k}` }); });
  for (const [name, x] of Object.entries(rule.extract ?? {})) {
    if (name.length > MAX_EXTRACT_NAME) out.push({ path: `/extract/${name}`, message: `extract name too long (max ${MAX_EXTRACT_NAME} characters)` });
    if ('regex' in x) { const m = regexProblem(x.regex, undefined, true); if (m) out.push({ path: `/extract/${name}/regex`, message: m }); }
  }
  rule.actions.forEach((a, j) => {
    if ('group' in a) {
      for (const m of titleProblems(rule, a.group.title, tables)) out.push({ path: `/actions/${j}/group/title`, message: m });
      const cp = templateProblem(a.group.color, tables);
      if (cp) out.push({ path: `/actions/${j}/group/color`, message: cp });
      else if (!COLORS.has(a.group.color) && templateVars(a.group.color).length === 0) {
        out.push({ path: `/actions/${j}/group/color`, message: `must be one of ${[...COLORS].join(', ')}, or a {template}` });
      } else for (const m of varProblems(rule, a.group.color)) out.push({ path: `/actions/${j}/group/color`, message: m });
    } else if ('close' in a && a.close.after !== undefined && !DURATION.test(a.close.after)) {
      out.push({ path: `/actions/${j}/close/after`, message: DURATION_MSG });
    }
  });
  return out;
}

/**
 * Problems of the dedupe regexes and url patterns (T18): urlTransforms (compile + MAX_REGEX_LEN) and the
 * fragmentOverrides / titleOverrides patterns (compilePattern, which caps at MAX_REGEX_LEN; empty is rejected).
 * Paths are relative to /dedupe. Shared by validateConfig and repairConfig.
 */
export function dedupeProblems(d: Pick<DedupeSettings, 'urlTransforms' | 'fragmentOverrides' | 'titleOverrides'>): Problem[] {
  const out: Problem[] = [];
  d.urlTransforms.forEach((t, i) => {
    const m = regexProblem(t.pattern, t.flags, true);
    if (m) out.push({ path: `/urlTransforms/${i}/pattern`, message: m });
  });
  for (const field of ['fragmentOverrides', 'titleOverrides'] as const) {
    d[field].forEach((e, i) => {
      const m = e.pattern === '' ? 'must not be empty' : patternProblem(e.pattern);
      if (m) out.push({ path: `/${field}/${i}/pattern`, message: m });
    });
  }
  return out;
}

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

/** An ajv error as a Problem: its JSON pointer, and its message with the offending property or allowed values. */
export function schemaProblem(e: ValidateError): Problem {
  const p = e.params ?? {};
  let detail = '';
  if (typeof p.additionalProperty === 'string') detail = `: ${p.additionalProperty}`;
  else if (Array.isArray(p.allowedValues)) detail = `: ${p.allowedValues.map(String).join(', ')}`;
  return { path: e.instancePath || '/', message: `${e.message ?? 'invalid'}${detail}` };
}

/** "<instancePath> <message>", with the offending property or allowed values when ajv names them. */
export function formatSchemaError(e: ValidateError): string {
  const { path, message } = schemaProblem(e);
  return `${path} ${message}`;
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
