import { defaultConfig } from '../../src/core/config/defaults';
import { groupRuleToRule, v1DedupeDefaults } from '../../src/core/config/migrate';
import type { Config, ConfigV1, GroupRule } from '../../src/core/types';

/** An M1 (v1) config: the given group rules plus M1's dedupe defaults (no M2 fields). */
export function v1Config(groupRules: GroupRule[] = [], dedupe: Partial<ConfigV1['dedupe']> = {}): ConfigV1 {
  return { version: 1, groupRules, dedupe: { ...v1DedupeDefaults(), ...dedupe } };
}

/** A v2 config whose user rules are the given M1 group rules (same ids), in order. */
export function withGroupRules(groupRules: GroupRule[], base: Config = defaultConfig()): Config {
  return {
    ...base,
    rules: [...base.rules, ...groupRules.map((g) => groupRuleToRule(g))],
    order: [...base.order, ...groupRules.map((g) => `user/${g.id}`)],
  };
}
