import type { Config, RecipeRef } from '../types';

/** Built-in recipe ids, in their default order. */
export const BUILTIN_RECIPES = ['duplicates', 'github-prs', 'finished'] as const;
const DEFAULT_ENABLED: Record<(typeof BUILTIN_RECIPES)[number], boolean> = { duplicates: true, 'github-prs': true, finished: false };

export function builtinRecipeRefs(enabled: Partial<Record<(typeof BUILTIN_RECIPES)[number], boolean>> = {}): RecipeRef[] {
  return BUILTIN_RECIPES.map((id) => ({ id, enabled: enabled[id] ?? DEFAULT_ENABLED[id], params: {}, source: 'builtin' }));
}

export function defaultConfig(): Config {
  return {
    version: 2,
    rules: [],
    recipes: builtinRecipeRefs(),
    // Built-in recipe rules are appended at compile time (M2 T4); their bodies are src/recipes/builtin/*.yaml.
    order: [],
    tables: {},
    dedupe: {
      mode: 'always-switch',
      keep: 'existing',
      stripParams: ['utm_*', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      stripFragment: true,
      ignoreTrailingSlash: true,
      canonicalizers: [], // github-prs is a recipe now (M2 T6)
      followFragment: true,
      allowDuplicates: [],
      alwaysSwitchSites: [],
      includeIncognito: false,
      scope: 'all-windows',
      urlTransforms: [],
      fragmentOverrides: [],
      matchTitle: false,
      titleOverrides: [],
    },
    dryRun: false,
  };
}
