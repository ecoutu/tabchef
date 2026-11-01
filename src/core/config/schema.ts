import type { Config, GroupRule } from '../types';
import { patternCaptures } from '../match/pattern';
import { templateVars } from '../match/template';
import schema from './config.schema.json';
import { validate } from './validate-config.generated.js';

export const configJsonSchema = schema;

export type ValidationResult = { ok: true; config: Config } | { ok: false; errors: string[] };

/**
 * Title problems of one rule: an empty title, or a `{var}` some pattern does not capture (that URL would render an
 * empty or partial title). Patterns that do not compile are reported elsewhere and skipped here.
 */
export function ruleTitleProblems(rule: GroupRule): string[] {
  const title = rule.group.title;
  if (title === '') return ['must not be empty'];
  const patterns = Array.isArray(rule.match.url) ? rule.match.url : [rule.match.url];
  const out: string[] = [];
  for (const v of templateVars(title)) {
    for (const p of patterns) {
      const caps = patternCaptures(p);
      if (caps && !caps.has(v)) out.push(`uses {${v}}, which pattern "${p}" does not capture`);
    }
  }
  return out;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** True when a raw rule has the shape ruleTitleProblems needs (title string; url string or string[]). */
function isTitleCheckable(r: Record<string, unknown>): r is Record<string, unknown> & GroupRule {
  const url = isObj(r.match) ? r.match.url : undefined;
  return isObj(r.group) && typeof r.group.title === 'string'
    && (typeof url === 'string' || (Array.isArray(url) && url.every((u) => typeof u === 'string')));
}

/**
 * Load-path repair for stored data (sync, lastGood, backups): an enabled rule with title problems is DISABLED, never
 * dropped, so a config saved by an older, laxer version still loads instead of falling back to defaults (which the
 * next edit would then write over sync). Strict checks apply to enabled rules only, so the result validates.
 * Malformed input is returned unchanged for validateConfig to report. Does not mutate its input.
 */
export function repairConfig(input: unknown): { config: unknown; warnings: string[] } {
  if (!isObj(input) || !Array.isArray(input.groupRules)) return { config: input, warnings: [] };
  const names: string[] = [];
  const groupRules = input.groupRules.map((r: unknown) => {
    if (!isObj(r) || r.enabled !== true || !isTitleCheckable(r) || ruleTitleProblems(r).length === 0) return r;
    names.push(typeof r.name === 'string' && r.name !== '' ? r.name : String(r.id));
    return { ...r, enabled: false };
  });
  if (!names.length) return { config: input, warnings: [] };
  return {
    config: { ...input, groupRules },
    warnings: [`${names.length} rule(s) disabled: ${names.join(', ')} — fix them on the Rules page.`],
  };
}

/**
 * Strict validation for saves and imports. Title checks (non-empty, every {var} captured by every pattern) apply to
 * enabled rules only: a disabled rule never renders a title, and stored data may hold such rules (see repairConfig).
 */
export function validateConfig(input: unknown): ValidationResult {
  if (!validate(input)) {
    return {
      ok: false,
      errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`),
    };
  }
  const config = input as unknown as Config;
  const errors: string[] = [];
  const seen = new Set<string>();
  config.groupRules.forEach((r, i) => {
    if (seen.has(r.id)) errors.push(`duplicate rule id: ${r.id}`);
    seen.add(r.id);
    if (r.enabled) for (const m of ruleTitleProblems(r)) errors.push(`/groupRules/${i}/group/title ${m}`);
  });
  for (const t of config.dedupe.urlTransforms) {
    try {
      new RegExp(t.pattern, t.flags);
    } catch {
      errors.push(`invalid urlTransform pattern: ${t.pattern}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config };
}
