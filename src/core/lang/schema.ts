// Validation of recipes and rules (M2 T5): precompiled JSON Schema (scripts/gen-validator.mjs; no runtime ajv, no
// custom keywords, MV3 CSP) followed by TS post-checks for what JSON Schema cannot express: regexes and patterns that
// must compile, durations, templates, Chrome match patterns, params and their placeholders.
//
// Recipe rules may hold `{params.<name>}` placeholders (R14). The schema accepts a placeholder wherever a typed leaf
// is expected; the post-checks then run on each rule with the param defaults substituted, exactly as compileProgram
// (src/core/lang/compile.ts) does, so a default that breaks a rule is reported at that rule. Full validation with the
// user's own param values and the merged tables happens in compileProgram.
import recipeSchema from './recipe.schema.json';
import ruleSchema from './rule.schema.json';
import { validateRecipe as recipeShape, validateRule as ruleShape } from '../config/validate-config.generated.js';
import { COLORS, regexProblem, ruleProblems, schemaProblem, templateProblem, type Problem } from '../config/rule-problems';
import { templateVars } from '../match/template';
import { boundProblem, ParamError, paramProblem, placeholderNames, stringParams, substitute } from './compile';
import { altKind, kindRank, LEVEL_KINDS, type NeedsKind } from './needs';
import type { Comparison, ParamDef, Recipe, RecipeNeeds, Rule, Show } from './types';

export const recipeJsonSchema = recipeSchema;
export const ruleJsonSchema = ruleSchema;
export type { Problem };

/** Recipe ids that are not allowed: `user` would collide with user rule keys `user/<id>` (R19). */
export const RESERVED_RECIPE_IDS: ReadonlySet<string> = new Set(['user']);

export type RecipeResult = { ok: true; recipe: Recipe } | { ok: false; errors: Problem[] };
export type RuleResult = { ok: true; rule: Rule } | { ok: false; errors: Problem[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

type SchemaError = Parameters<typeof schemaProblem>[0];
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/**
 * ajv reports every failing `oneOf` branch. Conds, actions and shows are one-key objects whose branch is picked by
 * that key, so a branch that reports its key as missing (`required`) at the oneOf's own path is a branch the author
 * did not mean. Those branches are dropped when another branch is meant (it has no `required` error, or the error
 * lies deeper, inside a $ref); when none is, only their `required` errors are dropped, so an unknown key (`eval`)
 * is still named. Then the generic "must match exactly one schema in oneOf" and the placeholder alternative
 * ("must match pattern ^\{params...") are dropped wherever a more specific error remains at that path.
 */
function pruneOneOf(errors: SchemaError[]): SchemaError[] {
  const summaries = errors.filter((e) => e.keyword === 'oneOf');
  /** The oneOf group of an error: the summary with that schema path whose instance path is the longest prefix. */
  const groupOf = (e: SchemaError) => {
    const m = /^(.*?\/oneOf)\/(\d+)(?:\/|$)/.exec(e.schemaPath);
    if (!m) return undefined;
    let best: SchemaError | undefined;
    for (const s of summaries) {
      if (s.schemaPath === m[1] && under(e.instancePath, s.instancePath) && (!best || s.instancePath.length > best.instancePath.length)) best = s;
    }
    return best && { summary: best, branch: m[2] as string };
  };
  const info = errors.map((e) => ({ e, g: groupOf(e) }));
  const drop = new Set<SchemaError>();
  for (const s of summaries) {
    const members = info.filter((x) => x.g?.summary === s);
    const dead = new Set(members.filter((x) => x.e.keyword === 'required' && x.e.instancePath === s.instancePath).map((x) => x.g?.branch));
    const meant = members.some((x) => !dead.has(x.g?.branch))
      || errors.some((e) => e.instancePath !== s.instancePath && under(e.instancePath, s.instancePath) && !members.some((x) => x.e === e));
    for (const x of members) if (dead.has(x.g?.branch) && (meant || x.e.keyword === 'required')) drop.add(x.e);
  }
  const kept = errors.filter((e) => !drop.has(e));
  const specific = (e: SchemaError) => kept.some((o) => o !== e && o.keyword !== 'oneOf' && !o.schemaPath.includes('$defs/placeholder') && under(o.instancePath, e.instancePath));
  return kept.filter((e) => !((e.keyword === 'oneOf' || e.schemaPath.includes('$defs/placeholder')) && specific(e)));
}

/** Schema errors as Problems (pruned, see pruneOneOf), without duplicates. */
function shapeProblems(errors: SchemaError[] | null): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const e of pruneOneOf(errors ?? [])) {
    const p = schemaProblem(e);
    const key = `${p.path}\n${p.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

// Chrome match patterns (needs.hosts): <scheme>://<host><path> with scheme `*`, http or https; host `*`, `*.<name>`
// or a literal name (an optional `:port` or `:*`); the path starts with `/`.
const MATCH_PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::(\*|\d{1,5}))?(\/\S*)$/;
const MATCH_MSG = 'must be a Chrome match pattern: scheme *, http or https; host *, *.example.com or example.com (optional :port); then a path, e.g. https://example.com/*';

/** Why `p` is not a Chrome match pattern Tabchef accepts in `needs.hosts`, or undefined. */
export function matchPatternProblem(p: string): string | undefined {
  const m = MATCH_PATTERN.exec(p);
  if (!m) return MATCH_MSG;
  if (m[3] !== undefined && m[3] !== '*' && Number(m[3]) > 65535) return 'port out of range';
  return undefined;
}

/** One rule: schema, then the post-checks (patterns, regexes, durations, colors, titles; tables when given). */
export function validateRule(x: unknown): RuleResult {
  if (!ruleShape(x)) return { ok: false, errors: shapeProblems(ruleShape.errors) };
  const errors = ruleProblems(x as unknown as Rule);
  return errors.length ? { ok: false, errors } : { ok: true, rule: x as unknown as Rule };
}

/** Placeholders anywhere in `x` that name no declared param. */
function unknownPlaceholders(x: unknown, declared: Set<string>, path: string, out: Problem[]): void {
  if (typeof x === 'string') {
    for (const n of placeholderNames(x)) if (!declared.has(n)) out.push({ path, message: `unknown param: {params.${n}}` });
  } else if (Array.isArray(x)) x.forEach((v, i) => unknownPlaceholders(v, declared, `${path}/${i}`, out));
  else if (isObj(x)) for (const [k, v] of Object.entries(x)) unknownPlaceholders(v, declared, `${path}/${esc(k)}`, out);
}

/** Value checks of view `show` comparisons: `matches` takes a regex (capped, must compile), `in` takes a list. */
function showProblems(s: Show, path: string, out: Problem[]): void {
  if ('all' in s) s.all.forEach((x, i) => showProblems(x, `${path}/all/${i}`, out));
  else if ('any' in s) s.any.forEach((x, i) => showProblems(x, `${path}/any/${i}`, out));
  else if ('not' in s) showProblems(s.not, `${path}/not`, out);
  else {
    const c = s as Comparison;
    if (c.op === 'matches') {
      const m = typeof c.value === 'string' ? regexProblem(c.value, undefined, true) : 'must be a regex string';
      if (m) out.push({ path: `${path}/value`, message: m });
    } else if (c.op === 'in' && !Array.isArray(c.value)) out.push({ path: `${path}/value`, message: 'must be a list' });
  }
}

const duplicates = <T>(items: T[], key: (t: T) => string, path: (i: number) => string, what: string, out: Problem[]) => {
  const seen = new Set<string>();
  items.forEach((t, i) => {
    const k = key(t);
    if (seen.has(k)) out.push({ path: path(i), message: `duplicate ${what}: ${k}` });
    seen.add(k);
  });
};

/** The kinds of a rule's needs alternatives (core/lang/needs.ts altKind); an alternative counts with the base needs. */
function needsKinds(n: RecipeNeeds | undefined): NeedsKind[] {
  const base = altKind({ origins: n?.hosts, connections: n?.connections });
  if (!Array.isArray(n?.anyOf) || n.anyOf.length === 0) return [base];
  return n.anyOf.map((a) => {
    const k = altKind({ origins: a.hosts, connections: a.connections });
    return kindRank(k) > kindRank(base) ? k : base;
  });
}

/**
 * One recipe: schema, then the post-checks: reserved id, param defaults and enums, unknown placeholders,
 * `needs.hosts` match patterns (recipe-level, and rule-level after substitution), urlTransform regexes, view `show`
 * values, duplicate rule and view ids, and each rule (with the param defaults substituted) through the same checks
 * as validateRule. Paths are JSON pointers into `x`;
 * after a list param is spliced into an array, indices inside that array are post-substitution.
 */
export function validateRecipe(x: unknown): RecipeResult {
  if (!recipeShape(x)) return { ok: false, errors: shapeProblems(recipeShape.errors) };
  const r = x as unknown as Recipe;
  const out: Problem[] = [];
  if (RESERVED_RECIPE_IDS.has(r.recipe)) out.push({ path: '/recipe', message: `recipe id "${r.recipe}" is reserved` });

  const params: Record<string, ParamDef> = r.params ?? {};
  const defaults: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(params)) {
    const base = `/params/${esc(name)}`;
    const { enum: allowed, ...plain } = def;
    allowed?.forEach((v, i) => { const m = paramProblem(plain, v); if (m) out.push({ path: `${base}/enum/${i}`, message: m }); });
    const bad = (['min', 'max'] as const).filter((k) => {
      const b = boundProblem(def, k);
      if (b) out.push({ path: `${base}/${k}`, message: b });
      return b !== undefined;
    });
    if (bad.length) continue; // the default is checked against valid bounds only
    const m = paramProblem(def, def.default);
    if (m) out.push({ path: `${base}/default`, message: m });
    else defaults[name] = def.default;
  }
  const body: Partial<Recipe> = { ...r };
  delete body.params; // param defaults are values, never substituted (as in compileProgram)
  const unknown: Problem[] = [];
  unknownPlaceholders(body, new Set(Object.keys(params)), '', unknown);
  out.push(...unknown);

  const hosts = (list: unknown, base: string) => {
    if (!Array.isArray(list)) return; // a {params.x} placeholder: checked after substitution, below
    list.forEach((h, i) => { const m = typeof h === 'string' ? matchPatternProblem(h) : undefined; if (m) out.push({ path: `${base}/${i}`, message: m }); });
  };
  const needsHosts = (n: RecipeNeeds | undefined, base: string): void => {
    hosts(n?.hosts, `${base}/hosts`);
    if (Array.isArray(n?.anyOf)) n.anyOf.forEach((a, i) => needsHosts(a, `${base}/anyOf/${i}`));
  };
  needsHosts(r.needs, '/needs');
  // M3: project templates and color, conflicts, levels, and assignProject only with a project.
  if (r.project) {
    // Checked with the param defaults substituted (`color: '{params.color}'`), as compileProgram renders it.
    let project = r.project;
    try { project = substitute(r.project, defaults) as Recipe['project'] & object; } catch { /* a placeholder problem: reported above */ }
    for (const k of ['key', 'title', 'color'] as const) {
      const m = templateProblem(project[k]);
      if (m) out.push({ path: `/project/${k}`, message: m });
    }
    if (!COLORS.has(project.color) && templateVars(project.color).length === 0) {
      out.push({ path: '/project/color', message: `must be one of ${[...COLORS].join(', ')}, or a {template}` });
    }
  }
  r.conflicts?.forEach((id, i) => { if (id === r.recipe) out.push({ path: `/conflicts/${i}`, message: 'a recipe cannot conflict with itself' }); });
  // Levels are positional (M3-R69): levels[i] means LEVEL_KINDS[i], so at most 3, and each listed rule needs an
  // alternative of that kind (a rule's needs without anyOf are its one alternative; no needs = titles).
  if ((r.levels?.length ?? 0) > LEVEL_KINDS.length) out.push({ path: '/levels', message: `at most ${LEVEL_KINDS.length} levels (titles, page, connection by position)` });
  const ruleById = new Map(r.rules.map((x) => [x.id, x]));
  r.levels?.forEach((l, i) => l.rules.forEach((id, j) => {
    const rule = ruleById.get(id);
    if (!rule) { out.push({ path: `/levels/${i}/rules/${j}`, message: `unknown rule id: ${id}` }); return; }
    const kind = LEVEL_KINDS[i];
    if (kind && !needsKinds(rule.needs).includes(kind)) {
      out.push({ path: `/levels/${i}/rules/${j}`, message: `rule ${id} has no ${kind} alternative (level ${i} means ${kind})` });
    }
  }));
  duplicates(r.levels ?? [], (l) => l.id, (i) => `/levels/${i}/id`, 'level id', out);
  if (!r.project) {
    r.rules.forEach((x, i) => x.actions.forEach((a, j) => {
      if ('assignProject' in a) out.push({ path: `/rules/${i}/actions/${j}/assignProject`, message: 'the recipe declares no project' });
    }));
  }
  r.dedupe?.urlTransforms?.forEach((t, i) => {
    // Checked as compileProgram renders it with the param defaults: a string param right after `://` is a host glob,
    // any other placeholder interpolates plainly (#179). A transform the defaults drop is not checked; one whose
    // placeholders fail to substitute (reported above) is checked as written.
    let rendered: unknown[] | undefined;
    try { rendered = substitute([t], defaults, ['dedupe', 'urlTransforms'], stringParams(r.params)) as unknown[]; } catch { /* a placeholder problem: reported above */ }
    if (rendered?.length === 0) return; // dropped, as compileProgram drops it
    const first = rendered?.[0];
    const m = regexProblem(isObj(first) && typeof first.pattern === 'string' ? first.pattern : t.pattern, t.flags, true);
    if (m) out.push({ path: `/dedupe/urlTransforms/${i}/pattern`, message: m });
  });
  r.views?.forEach((v, i) => { if (v.show) showProblems(v.show, `/views/${i}/show`, out); });
  duplicates(r.views ?? [], (v) => v.id, (i) => `/views/${i}/id`, 'view id', out);
  duplicates(r.rules, (x) => x.id, (i) => `/rules/${i}/id`, 'rule id', out);

  // Rules with the defaults substituted; skipped when a placeholder or a default is already reported.
  if (!unknown.length && Object.keys(defaults).length === Object.keys(params).length) {
    r.rules.forEach((rule, i) => {
      let sub: unknown;
      try {
        sub = substitute(rule, defaults);
      } catch (e) {
        if (!(e instanceof ParamError)) throw e;
        out.push({ path: `/rules/${i}`, message: e.message });
        return;
      }
      const res = validateRule(sub);
      if (!res.ok) for (const p of res.errors) out.push({ path: `/rules/${i}${p.path === '/' ? '' : p.path}`, message: p.message });
      else needsHosts(res.rule.needs, `/rules/${i}/needs`);
    });
  }
  return out.length ? { ok: false, errors: out } : { ok: true, recipe: r };
}
