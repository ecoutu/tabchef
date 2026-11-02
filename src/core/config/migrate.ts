import type { ConfigV1, ConfigV2, DedupeSettingsV1, GroupRule } from '../types';
import type { Action, GroupAction, Rule } from '../lang/types';
import { builtinRecipeRefs, defaultConfig } from './defaults';
import { validateConfigV1 } from './validate-config.generated.js';

/** v2 rule and recipe ids (also each half of a rule key 'user/<id>'). Mirrors rule.schema.json $defs/id. */
export const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_ID = 64;

export const userKey = (id: string): string => `user/${id}`;

/**
 * Maps `raw` to the v2 id pattern (lowercase; other characters become '-'; trimmed to 64), unique within `taken`
 * (suffix -2, -3, ...). Adds the result to `taken`.
 */
export function sanitizeRuleId(raw: string, taken: Set<string>): string {
  let base = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').replace(/-+$/, '').slice(0, MAX_ID);
  if (!RULE_ID_PATTERN.test(base)) base = 'rule';
  let id = base;
  for (let n = 2; taken.has(id); n++) {
    const suffix = `-${n}`;
    id = base.slice(0, MAX_ID - suffix.length) + suffix;
  }
  taken.add(id);
  return id;
}

/** An M1 group rule as a v2 rule: url-only match, one group action, plus a dedupe action for a per-rule override. */
export function groupRuleToRule(g: GroupRule, id: string = g.id): Rule {
  const group: GroupAction = {
    title: g.group.title, color: g.group.color,
    ...(g.group.collapsed !== undefined && { collapsed: g.group.collapsed }),
    ...(g.sortGroups !== undefined && { sortGroups: g.sortGroups }),
    ...(g.strict !== undefined && { strict: g.strict }),
    ...(g.merge !== undefined && { merge: g.merge }),
  };
  const actions: Action[] = [{ group }, ...(g.dedupe ? [{ dedupe: { mode: g.dedupe } }] : [])];
  return { id, name: g.name, enabled: g.enabled, match: { url: g.match.url }, actions };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

const M2_DEDUPE_FIELDS = new Set(['fragmentOverrides', 'matchTitle', 'titleOverrides']);

/** M1's dedupe defaults: the current defaults without the M2 fields. */
export function v1DedupeDefaults(): DedupeSettingsV1 {
  return Object.fromEntries(Object.entries(defaultConfig().dedupe).filter(([k]) => !M2_DEDUPE_FIELDS.has(k))) as unknown as DedupeSettingsV1;
}

/**
 * A stored v1 config with fields missing from older M1 builds filled with M1 defaults (stored values win), as M1's
 * own load path did. This is what the v1 backup holds (ruling R2a). Non-objects are returned unchanged.
 */
export function fillConfigV1(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  return { groupRules: [], ...raw, dedupe: { ...v1DedupeDefaults(), ...(isObj(raw.dedupe) ? raw.dedupe : {}) } };
}

/** Forward-compatible: fill v2 fields missing from an older stored v2 config with defaults (stored values win). */
export function fillConfigDefaults(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const d = defaultConfig();
  return { ...d, ...raw, dedupe: { ...d.dedupe, ...(isObj(raw.dedupe) ? raw.dedupe : {}) } };
}

export type MigrateResult = { ok: true; config: ConfigV2; migratedFrom?: 1 } | { ok: false; errors: string[] };

function fromV1(c: ConfigV1): ConfigV2 {
  const taken = new Set<string>();
  const rules = c.groupRules.map((g) => groupRuleToRule(g, sanitizeRuleId(g.id, taken)));
  const d = defaultConfig();
  return {
    version: 2,
    rules,
    recipes: builtinRecipeRefs({ 'github-prs': c.dedupe.canonicalizers.includes('githubPr') }),
    // User rules keep their M1 priority; built-in recipe keys are appended at compile time (M2 T4).
    order: rules.map((r) => userKey(r.id)),
    tables: {},
    dedupe: { ...c.dedupe, fragmentOverrides: d.dedupe.fragmentOverrides, matchTitle: d.dedupe.matchTitle, titleOverrides: d.dedupe.titleOverrides },
    dryRun: false,
  };
}

/**
 * Brings a stored config to v2. A v1 config is default-filled, checked against the M1 schema, and converted; a v2
 * config passes through unchanged (callers fill defaults and validate it). Pure; does not mutate its input.
 */
export function migrateConfig(input: unknown): MigrateResult {
  if (!isObj(input)) return { ok: false, errors: ['config must be an object'] };
  if (input.version === 2) return { ok: true, config: input as unknown as ConfigV2 };
  if (input.version !== 1) return { ok: false, errors: [`unsupported config version: ${JSON.stringify(input.version)}`] };
  const v1 = fillConfigV1(input);
  if (!validateConfigV1(v1)) {
    return { ok: false, errors: (validateConfigV1.errors ?? []).map((e) => `v1 ${e.instancePath || '/'} ${e.message ?? 'invalid'}`) };
  }
  return { ok: true, config: fromV1(v1 as ConfigV1), migratedFrom: 1 };
}
