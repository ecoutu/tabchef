// Problems of rules, regexes, patterns, durations, titles and the dedupe lists, and ajv errors as Problems. Shared by
// config validation (schema.ts), recipe validation (lang/schema.ts) and the compiler; a leaf of the import graph.
import type { DedupeSettings, GroupColor } from '../types';
import type { Comparison, Cond, Rule } from '../lang/types';
import { compilePattern, MAX_REGEX_LEN, PatternError, patternCaptures } from '../match/pattern';
import { slowRegexProblem } from '../match/regex-safety';
import { DURATION } from '../lang/duration';
import { parseTemplate, TemplateError, templateTables, templateVars } from '../match/template';
import type { ValidateError } from './validate-config.generated.js';

/** The 9 Chrome tab-group colors. */
export const COLORS: ReadonlySet<string> = new Set<string>(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] satisfies GroupColor[]);
const DURATION_MSG = 'must be a duration like 500ms, 30s, 15m, 2h or 1d';
/** Caps on what the watch content script can report (MAX_FACT_TEXT in src/engine/messages.ts; core can't import it). */
export const MAX_PAGE_TEXT = 500;
export const MAX_EXTRACT_NAME = 64;
const PAGE_TEXT_MSG = `must be at most ${MAX_PAGE_TEXT} characters`;

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
export function templateProblem(t: string, tables?: Tables): string | undefined {
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

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * A `field` condition (M3): `source.<n>` must name one of the rule's source fields and `extract.<n>` one of its
 * extracts; `{ago: d}` goes with `<` / `>` and a duration; `in` takes a list, `matches` a regex (capped, must compile).
 */
function fieldProblems(rule: Rule, c: Comparison, path: string, out: Problem[]): void {
  const dot = c.field.indexOf('.');
  const kind = c.field.slice(0, dot);
  const name = c.field.slice(dot + 1);
  const has = (o: object | undefined) => o !== undefined && Object.prototype.hasOwnProperty.call(o, name);
  if (kind === 'source' && !has(rule.source?.fields)) out.push({ path: `${path}/field`, message: `rule has no source field "${name}"` });
  if (kind === 'extract' && !has(rule.extract)) out.push({ path: `${path}/field`, message: `rule has no extract "${name}"` });
  const v = c.value;
  if (isObj(v) && 'ago' in v) {
    if (Object.keys(v).length !== 1) out.push({ path: `${path}/value`, message: 'must be {ago: <duration>}' });
    else if (c.op !== '<' && c.op !== '>') out.push({ path: `${path}/value`, message: '{ago} compares with < or > only' });
    else if (typeof v.ago !== 'string' || !DURATION.test(v.ago)) out.push({ path: `${path}/value/ago`, message: DURATION_MSG });
  } else if (c.op === 'matches') {
    const m = typeof v === 'string' ? regexProblem(v, undefined, true) : 'must be a regex string';
    if (m) out.push({ path: `${path}/value`, message: m });
  } else if (c.op === 'in') {
    if (!Array.isArray(v)) out.push({ path: `${path}/value`, message: 'must be a list' });
  } else if (typeof v === 'object' && v !== null) {
    out.push({ path: `${path}/value`, message: 'must be a string, number, boolean, null or {ago: <duration>}' });
  }
}

function condProblems(c: Cond, path: string, out: Problem[], rule?: Rule): void {
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
    for (const k of ['gt', 'lt'] as const) {
      const v = c.age[k];
      if (v !== undefined && !DURATION.test(v)) out.push({ path: `${path}/age/${k}`, message: DURATION_MSG });
    }
  } else if ('pageText' in c) {
    // I2: the watch reports needles up to MAX_FACT_TEXT (src/engine/messages.ts); a longer one could never match.
    const long = (n: string) => n.length > MAX_PAGE_TEXT;
    if (Array.isArray(c.pageText)) c.pageText.forEach((n, i) => { if (long(n)) out.push({ path: `${path}/pageText/${i}`, message: PAGE_TEXT_MSG }); });
    else if (long(c.pageText)) out.push({ path: `${path}/pageText`, message: PAGE_TEXT_MSG });
  } else if ('field' in c) {
    if (rule) fieldProblems(rule, c.field, `${path}/field`, out);
  } else if ('opener' in c) condProblems(c.opener, `${path}/opener`, out, rule);
  else if ('not' in c) condProblems(c.not, `${path}/not`, out, rule);
  else if ('all' in c) c.all.forEach((x, i) => condProblems(x, `${path}/all/${i}`, out, rule));
  else if ('any' in c) c.any.forEach((x, i) => condProblems(x, `${path}/any/${i}`, out, rule));
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
  condProblems(rule.match, '/match', out, rule);
  if (rule.trigger?.every !== undefined && !DURATION.test(rule.trigger.every)) out.push({ path: '/trigger/every', message: DURATION_MSG });
  // Uniqueness is checked here, not with JSON-schema uniqueItems: ajv's standalone code for it needs a runtime require().
  rule.trigger?.on.forEach((k, j, all) => { if (all.indexOf(k) !== j) out.push({ path: `/trigger/on/${j}`, message: `duplicate trigger: ${k}` }); });
  for (const [name, x] of Object.entries(rule.extract ?? {})) {
    if (name.length > MAX_EXTRACT_NAME) out.push({ path: `/extract/${name}`, message: `extract name too long (max ${MAX_EXTRACT_NAME} characters)` });
    if ('regex' in x) { const m = regexProblem(x.regex, undefined, true); if (m) out.push({ path: `/extract/${name}/regex`, message: m }); }
    if ('jiraKey' in x) {
      if (x.from.startsWith('source.') && !Object.prototype.hasOwnProperty.call(rule.source?.fields ?? {}, x.from.slice(7))) {
        out.push({ path: `/extract/${name}/from`, message: `rule has no source field "${x.from.slice(7)}"` });
      }
      if (x.jiraKey.pattern !== undefined) { const m = regexProblem(x.jiraKey.pattern, undefined, true); if (m) out.push({ path: `/extract/${name}/jiraKey/pattern`, message: m }); }
    }
  }
  for (const [arg, t] of Object.entries(rule.source?.args ?? {})) {
    const m = templateProblem(t, tables) ?? varProblems(rule, t)[0];
    if (m) out.push({ path: `/source/args/${arg}`, message: m });
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
    } else if ('assignProject' in a) {
      const tp = templateProblem(a.assignProject.key, tables);
      for (const m of tp ? [tp] : varProblems(rule, a.assignProject.key)) out.push({ path: `/actions/${j}/assignProject/key`, message: m });
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
