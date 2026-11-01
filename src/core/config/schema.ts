import type { Config } from '../types';
import schema from './config.schema.json';
import { validate } from './validate-config.generated.js';

export const configJsonSchema = schema;

export type ValidationResult = { ok: true; config: Config } | { ok: false; errors: string[] };

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
  for (const r of config.groupRules) {
    if (seen.has(r.id)) errors.push(`duplicate rule id: ${r.id}`);
    seen.add(r.id);
  }
  for (const t of config.dedupe.urlTransforms) {
    try {
      new RegExp(t.pattern, t.flags);
    } catch {
      errors.push(`invalid urlTransform pattern: ${t.pattern}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config };
}
