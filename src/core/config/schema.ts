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
    // Empty titles are already reported by the schema (minLength).
    if (r.group.title !== '') for (const m of ruleTitleProblems(r)) errors.push(`/groupRules/${i}/group/title ${m}`);
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
