import { describe, it, expect } from 'vitest';
import { validateRecipe } from '../../../src/core/lang/schema';

const project = { key: '{key}', title: '{key}', color: 'blue', container: 'group', join: ['rules'] };
const recipe = (p: Record<string, unknown>): Record<string, unknown> => ({
  recipe: 'demo', version: 1, name: 'Demo', description: 'A demo', project: p,
  rules: [{ id: 'r', name: 'R', enabled: true, match: { url: 'github.com/*' }, actions: [{ assignProject: { key: 'K-1' } }] }],
});

describe('recipe project schema (M4 T1)', () => {
  it('accepts a project with an unknown field', () => {
    expect(validateRecipe(recipe({ ...project, futureThing: 1 })).ok).toBe(true);
  });
  it('accepts the v2 fields', () => {
    const v2 = { ...project, container: 'window', join: ['rules', 'opener', 'window', 'manual'], placement: ['existing', 'new', 'home:work'], onOpenElsewhere: 'leave', onSwitchAway: 'minimize', start: 'on-request' };
    expect(validateRecipe(recipe(v2)).ok).toBe(true);
  });
  it('rejects bad values of the v2 fields', () => {
    for (const bad of [{ placement: ['nowhere'] }, { onOpenElsewhere: 'x' }, { onSwitchAway: 'x' }, { start: 'x' }, { container: 'tab' }]) {
      expect(validateRecipe(recipe({ ...project, ...bad })).ok).toBe(false);
    }
  });
});
