// The Recipes page model (M2 T15): what Enable requests, the config a recipe change would store (for preview.change),
// and client-side param checks.
import type { Config, RecipeRef } from '../core/types';
import type { ParamDef, Recipe } from '../core/lang/types';
import type { RecipeListItem } from '../engine/messages';
import type { Needs } from '../engine/permissions';
import { conflictingRecipes, paramProblem } from '../core/lang/compile';
import { matchPatternProblem } from '../core/lang/schema';

/** Everything Enable requests in one prompt: the recipe's own needs plus every rule-level need (Meet for Finished). */
export function requestedNeeds(item: RecipeListItem): Needs {
  const all = [item.needs, ...Object.values(item.rules).map((r) => r.needs)];
  return { origins: [...new Set(all.flatMap((n) => n.origins))], permissions: [...new Set(all.flatMap((n) => n.permissions))] };
}

/**
 * `c` with recipe `id`'s ref patched: the config that enable / disable / setParams would store. Enabling (with the
 * built-in bodies) also turns off the recipes it conflicts with, as recipes.enable does (M3-R17).
 */
export function withRecipe(c: Config, id: string, patch: Partial<Pick<RecipeRef, 'enabled' | 'params'>>, builtins?: Record<string, Recipe>): Config {
  const off = patch.enabled === true && builtins ? conflictingRecipes(c, id, builtins) : [];
  return { ...c, recipes: c.recipes.map((r) => (r.id === id ? { ...r, ...patch } : off.includes(r.id) ? { ...r, enabled: false } : r)) };
}

/** The complete params object (user values, else defaults): setParams / enable replace the whole object (T8). */
export function completeParams(defs: Record<string, ParamDef>, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(defs)) {
    const v = Object.hasOwn(params, name) ? params[name] : def.default;
    out[name] = v === undefined ? v : JSON.parse(JSON.stringify(v)); // params are JSON; a copy the form may edit
  }
  return out;
}

const EXACT = /^\{params\.([A-Za-z_]\w*)\}$/;

/** Params that fill a `needs.hosts` (recipe-level or rule-level): their values must be Chrome match patterns. */
export function hostParams(body: Recipe | undefined): Set<string> {
  const out = new Set<string>();
  const scan = (hosts: unknown): void => {
    for (const h of Array.isArray(hosts) ? hosts : [hosts]) {
      const m = typeof h === 'string' ? EXACT.exec(h) : null;
      if (m) out.add(m[1]!);
    }
  };
  if (!body) return out;
  scan(body.needs?.hosts);
  for (const r of body.rules) scan(r.needs?.hosts);
  return out;
}

/**
 * Client-side param errors by name: the ParamDef check the background runs (type, enum), plus, for host params, the
 * match-pattern check compileProgram does not run on user values (T10 carry). The background re-checks on send.
 */
export function paramErrors(defs: Record<string, ParamDef>, values: Record<string, unknown>, hosts: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(defs)) {
    const v = values[name];
    const m = paramProblem(def, v);
    if (m) { out[name] = m; continue; }
    if (hosts.has(name)) {
      const bad = (Array.isArray(v) ? v : [v]).filter((h): h is string => typeof h === 'string')
        .map((h) => { const p = matchPatternProblem(h); return p ? `${h}: ${p}` : ''; }).filter((x) => x !== '');
      if (bad.length) out[name] = bad.join('; ');
    }
  }
  return out;
}
