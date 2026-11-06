// M4 T6: the built-in Manual projects recipe.
import { describe, expect, it } from 'vitest';
import { builtinRecipes } from '../../src/recipes/load';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import { fillConfigDefaults } from '../../src/core/config/migrate';
import type { Config } from '../../src/core/types';

const ID = 'manual-project';

describe('the manual-project recipe', () => {
  it('has no rules; its project is named by the user, grey, a group, joined by hand only and started on request', () => {
    expect(builtinRecipes()[ID]).toMatchObject({
      recipe: ID, rules: [],
      project: { key: '{name}', title: '{name}', color: 'grey', container: 'group', join: ['manual'], start: 'on-request' },
    });
  });

  it('is on in a new config and compiles to a project def with no rules', () => {
    const c = defaultConfig();
    expect(c.recipes.find((r) => r.id === ID)).toEqual({ id: ID, enabled: true, params: {}, source: 'builtin' });
    const { program, errors, warnings } = compileProgram(c, builtinRecipes());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(program.rules.filter((r) => r.recipeId === ID)).toEqual([]);
    expect(program.projects?.find((d) => d.recipeId === ID)).toEqual({
      recipeId: ID, key: '{name}', title: '{name}', color: 'grey', container: 'group', join: ['manual'],
      placement: ['existing', 'current'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload', start: 'on-request',
    });
  });

  it('a config stored before it existed gets it appended, off, like any later built-in (R68)', () => {
    const d = defaultConfig();
    const old = { ...d, recipes: d.recipes.filter((r) => r.id !== ID) };
    expect((fillConfigDefaults(old) as Config).recipes.at(-1)).toEqual({ id: ID, enabled: false, params: {}, source: 'builtin' });
  });
});
