import type { Config, RecipeRef } from '../types';

/** Built-in recipe ids, in their default order. */
export const BUILTIN_RECIPES = ['duplicates', 'github-prs', 'finished', 'merged-prs', 'jira-ticket-title', 'jira-ticket-branch', 'jira-ticket-either', 'github-issue', 'manual-project'] as const;
/**
 * The jira-ticket variants conflict with each other (M3-R17); all three start disabled (user decision, 2026-11-03), and so
 * does github-issue, so upgrading regroups no one's tabs.
 */
const DEFAULT_ENABLED: Record<(typeof BUILTIN_RECIPES)[number], boolean> = {
  duplicates: true, 'github-prs': true, finished: false, 'merged-prs': false,
  'jira-ticket-title': false, 'jira-ticket-branch': false, 'jira-ticket-either': false,
  'github-issue': false,
  // No rules: nothing happens until the user creates a project (M4 T6).
  'manual-project': true,
};

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
