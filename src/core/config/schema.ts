import type { Config, GroupColor } from '../types';
import type { Cond, Rule } from '../lang/types';
import { compilePattern, PatternError, patternCaptures } from '../match/pattern';
import { templateVars } from '../match/template';
import schema from './config.schema.json';
import { validate, validateRule, type ValidateError } from './validate-config.generated.js';

export const configJsonSchema = schema;

export type ValidationResult = { ok: true; config: Config } | { ok: false; errors: string[] };

const COLORS = new Set<string>(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] satisfies GroupColor[]);
/** Durations: a positive integer and a unit (s, m, h, d), e.g. '30s', '15m', '2d'. */
export const DURATION = /^[0-9]+[smhd]$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const list = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** A problem at a JSON pointer relative to the rule (e.g. '/match/url/1'). */
interface Problem { path: string; message: string }

function patternProblem(p: string): string | undefined {
  try {
    compilePattern(p);
    return undefined;
  } catch (e) {
    if (e instanceof PatternError) return e.message;
    throw e;
  }
}
function regexProblem(source: string, flags?: string): string | undefined {
  try {
    new RegExp(source, flags);
    return undefined;
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }
}

/** Url patterns anywhere in a condition tree. */
function urlPatterns(c: Cond): string[] {
  if ('url' in c) return list(c.url);
  if ('all' in c) return c.all.flatMap(urlPatterns);
  if ('any' in c) return c.any.flatMap(urlPatterns);
  if ('not' in c) return urlPatterns(c.not);
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
      const m = regexProblem(t.slice(1, t.lastIndexOf('/')), t.slice(t.lastIndexOf('/') + 1));
      if (m) out.push({ path: `${path}/title`, message: m });
    }
  } else if ('age' in c) {
    for (const k of ['gt', 'lt'] as const) {
      const v = c.age[k];
      if (v !== undefined && !DURATION.test(v)) out.push({ path: `${path}/age/${k}`, message: `must be a duration like 30s, 15m, 2h or 1d` });
    }
  } else if ('opener' in c) condProblems(c.opener, `${path}/opener`, out);
  else if ('not' in c) condProblems(c.not, `${path}/not`, out);
  else if ('all' in c) c.all.forEach((x, i) => condProblems(x, `${path}/all/${i}`, out));
  else if ('any' in c) c.any.forEach((x, i) => condProblems(x, `${path}/any/${i}`, out));
}

/**
 * Title problems of one group action: an empty title, or a `{var}` that neither the rule's url patterns nor its
 * `extract` names provide. For an M1-shaped url-only match every pattern must capture the var (any of them may be
 * the one that matched); for other conditions any url pattern capturing it is enough. Patterns that do not compile
 * are reported elsewhere and skipped here.
 */
function titleProblems(rule: Rule, title: string): string[] {
  if (title === '') return ['must not be empty'];
  const extracted = new Set(Object.keys(rule.extract ?? {}));
  const out: string[] = [];
  const vars = templateVars(title).filter((v) => !extracted.has(v));
  if ('url' in rule.match) {
    for (const v of vars) {
      for (const p of list(rule.match.url)) {
        const caps = patternCaptures(p);
        if (caps && !caps.has(v)) out.push(`uses {${v}}, which pattern "${p}" does not capture`);
      }
    }
    return out;
  }
  const caps = new Set(urlPatterns(rule.match).flatMap((p) => [...(patternCaptures(p) ?? [])]));
  for (const v of vars) if (!caps.has(v)) out.push(`uses {${v}}, which no url pattern or extract provides`);
  return out;
}

/** Title problems of every group action of a rule (messages only; see titleProblems). */
export function ruleTitleProblems(rule: Rule): string[] {
  return rule.actions.flatMap((a) => ('group' in a ? titleProblems(rule, a.group.title) : []));
}

/** Post-schema problems of a structurally valid rule: patterns, regexes, durations, colors and titles. */
function ruleProblems(rule: Rule): Problem[] {
  const out: Problem[] = [];
  condProblems(rule.match, '/match', out);
  if (rule.trigger?.every !== undefined && !DURATION.test(rule.trigger.every)) out.push({ path: '/trigger/every', message: 'must be a duration like 30s, 15m, 2h or 1d' });
  // Uniqueness is checked here, not with JSON-schema uniqueItems: ajv's standalone code for it needs a runtime require().
  rule.trigger?.on.forEach((k, j, all) => { if (all.indexOf(k) !== j) out.push({ path: `/trigger/on/${j}`, message: `duplicate trigger: ${k}` }); });
  for (const [name, x] of Object.entries(rule.extract ?? {})) {
    if ('regex' in x) { const m = regexProblem(x.regex); if (m) out.push({ path: `/extract/${name}/regex`, message: m }); }
  }
  rule.actions.forEach((a, j) => {
    if ('group' in a) {
      for (const m of titleProblems(rule, a.group.title)) out.push({ path: `/actions/${j}/group/title`, message: m });
      if (!COLORS.has(a.group.color) && templateVars(a.group.color).length === 0) {
        out.push({ path: `/actions/${j}/group/color`, message: `must be one of ${[...COLORS].join(', ')}, or a {template}` });
      }
    } else if ('close' in a && a.close.after !== undefined && !DURATION.test(a.close.after)) {
      out.push({ path: `/actions/${j}/close/after`, message: 'must be a duration like 30s, 15m, 2h or 1d' });
    }
  });
  return out;
}

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
    if (!isObj(r) || r.enabled !== true || !validateRule(r) || ruleProblems(r as unknown as Rule).length === 0) return r;
    names.push(typeof r.name === 'string' && r.name !== '' ? r.name : String(r.id));
    return { ...r, enabled: false };
  });
  if (!names.length) return { config: input, warnings: [] };
  return {
    config: { ...input, rules },
    warnings: [`${names.length} rule(s) disabled: ${names.join(', ')} — fix them on the Rules page.`],
  };
}

/** "<instancePath> <message>", with the offending property or allowed values when ajv names them. */
export function formatSchemaError(e: ValidateError): string {
  const p = e.params ?? {};
  let detail = '';
  if (typeof p.additionalProperty === 'string') detail = `: ${p.additionalProperty}`;
  else if (Array.isArray(p.allowedValues)) detail = `: ${p.allowedValues.map(String).join(', ')}`;
  return `${e.instancePath || '/'} ${e.message ?? 'invalid'}${detail}`;
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
    if (r.enabled) for (const p of ruleProblems(r)) errors.push(`/rules/${i}${p.path} ${p.message}`);
  });
  config.order.forEach((k, i) => { if (config.order.indexOf(k) !== i) errors.push(`/order/${i} duplicate key: ${k}`); });
  for (const t of config.dedupe.urlTransforms) {
    if (regexProblem(t.pattern, t.flags)) errors.push(`invalid urlTransform pattern: ${t.pattern}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, config };
}
