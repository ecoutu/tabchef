// Built-in recipes (M2 T5). The YAML files are converted to JSON at build time by the `tabchef:yaml-json` Vite plugin
// (wxt.config.ts), so the `yaml` library never reaches the service-worker bundle (D30). Each recipe is validated when
// this module loads: an invalid built-in throws here, at startup and in every test that imports it, never later.
import { validateRecipe } from '../core/lang/schema';
import type { Recipe } from '../core/lang/types';

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

/**
 * Validated recipes keyed by file name (`./builtin/<id>.yaml`), which must equal the recipe id. Throws on the first
 * invalid file, listing its errors as `path: message`. Exported for tests.
 */
export function loadRecipes(modules: Record<string, unknown>): Record<string, Recipe> {
  const out: Record<string, Recipe> = {};
  for (const [file, data] of Object.entries(modules)) {
    const id = /([^/]+)\.yaml$/.exec(file)?.[1] ?? file;
    const r = validateRecipe(data);
    if (!r.ok) throw new Error(`built-in recipe ${file} is invalid:\n${r.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
    if (r.recipe.recipe !== id) throw new Error(`built-in recipe ${file}: recipe id "${r.recipe.recipe}" must match the file name`);
    out[id] = deepFreeze(r.recipe);
  }
  return Object.freeze(out);
}

const BUILTINS = loadRecipes(import.meta.glob<unknown>('./builtin/*.yaml', { eager: true, import: 'default' }));

/** The built-in recipe bodies, keyed by recipe id. Frozen; shared by every caller. */
export function builtinRecipes(): Record<string, Recipe> {
  return BUILTINS;
}
