import { describe, it, expect } from 'vitest';
import { compileProgram } from '../../../src/core/lang/compile';
import { PROJECT_DEFAULTS } from '../../../src/core/projects/types';
import { defaultConfig } from '../../../src/core/config/defaults';
import { builtinRecipes } from '../../../src/recipes/load';
import type { Recipe, RecipeRef } from '../../../src/core/lang/types';

const ref = (id: string): RecipeRef => ({ id, enabled: true, params: {}, source: 'builtin' });
const recipe = (project: Record<string, unknown>): Recipe => ({
  recipe: 'p', version: 1, name: 'p', description: 'p',
  project: { key: '{key}', title: '{key}', color: 'blue', container: 'group', join: ['rules'], ...project },
  rules: [{ id: 's', name: 's', enabled: true, match: { url: 'github.com/*' }, actions: [{ assignProject: { key: 'ABC-1' } }] }],
} as Recipe);
const compile = (b: Record<string, Recipe>, id: string) => compileProgram({ ...defaultConfig(), recipes: [ref(id)] }, b);

describe('compileProgram: M4 T1 project v2', () => {
  it('accepts a project with an unknown field and warns', () => {
    const { program, errors, warnings } = compile({ p: recipe({ futureThing: 1 }) }, 'p');
    expect(errors).toEqual([]);
    expect(warnings).toEqual([{ key: 'p', error: 'project field futureThing is not supported by this version' }]);
    expect(program.projects?.[0]).not.toHaveProperty('futureThing');
  });
  it('fills defaults', () => {
    const { program, warnings } = compile(builtinRecipes(), 'jira-ticket-either');
    expect(warnings).toEqual([]);
    expect(program.projects?.[0]).toMatchObject({
      placement: ['existing', 'current'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload', start: 'auto',
    });
  });
  it('keeps declared values over the defaults', () => {
    const { program } = compile({ p: recipe({ placement: ['new'], start: 'on-request' }) }, 'p');
    expect(program.projects?.[0]).toMatchObject({ placement: ['new'], start: 'on-request', onSwitchAway: 'unload' });
  });
  it('rejects window container before T15', () => {
    const { program, errors } = compile({ p: recipe({ container: 'window' }) }, 'p');
    expect(errors).toEqual([{ key: 'p', error: 'window projects are not supported yet' }]);
    expect(program.rules).toEqual([]);
    expect(program).not.toHaveProperty('projects');
  });
  it.each([['null', null], ['a string', 'x'], ['a number', 3], ['an array', []]])('ignores a malformed project (%s) without throwing', (_n, bad) => {
    const r = { ...recipe({}), project: bad } as unknown as Recipe;
    const { program } = compile({ p: r }, 'p');
    expect(program).not.toHaveProperty('projects');
  });
  it.each([['null', null], ['a string', 'x'], ['a number', 3], ['an array', []]])('rejects an assignProject rule when project is malformed (%s)', (_n, bad) => {
    const r = { ...recipe({}), project: bad } as unknown as Recipe;
    const { program, errors } = compile({ p: r }, 'p');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ key: 'p/s' });
    expect(errors[0]!.error).toContain('assignProject: the recipe declares no project');
    expect(program.rules).toEqual([]);
  });
  it('gives each compiled project its own placement array', () => {
    const { program } = compile(builtinRecipes(), 'jira-ticket-either');
    const a = program.projects![0]!;
    const b = compile({ p: recipe({}) }, 'p').program.projects![0]!;
    expect(a.placement).not.toBe(b.placement);
    expect(a.placement).not.toBe(PROJECT_DEFAULTS.placement);
    a.placement.push('new');
    expect(PROJECT_DEFAULTS.placement).toEqual(['existing', 'current']);
    expect(b.placement).toEqual(['existing', 'current']);
  });
});
