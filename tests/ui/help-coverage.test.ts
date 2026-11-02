// @vitest-environment jsdom
// Every labelled setting on the options pages has a help tip: a <label> must sit in a Field or LinesField that also
// holds an "About …" button. A new setting without one fails here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
vi.mock('../../src/ui/permissions', async (orig) => ({
  ...(await orig<typeof import('../../src/ui/permissions')>()),
  readPermissions: async () => ({ scripting: false, notifications: false, origins: [] }),
  onPermissionsChanged: () => () => {},
}));
const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Dedupe from '../../src/entrypoints/options/Dedupe.svelte';
import Recipes from '../../src/entrypoints/options/Recipes.svelte';
import RuleFields from '../../src/entrypoints/options/RuleFields.svelte';
import { defaultConfig } from '../../src/core/config/defaults';
import { ruleForm } from '../../src/ui/rules-model';
import { builtinRecipes } from '../../src/recipes/load';
import type { Rule } from '../../src/core/lang/types';
import type { RecipeListItem } from '../../src/engine/messages';

afterEach(cleanup);

const unhelped = (): string[] => [...document.querySelectorAll('label')]
  .filter((l) => !l.closest('.field, .lf')?.querySelector('button[aria-label^="About "]'))
  .map((l) => l.textContent!.trim().slice(0, 60));

describe('every options setting has a help tip', () => {
  it('Duplicates page (with its permissions panel)', () => {
    render(Dedupe, { config: defaultConfig(), dirty: false, saving: false, serverErrors: [], onChange: vi.fn(), onSave: vi.fn() });
    expect(unhelped()).toEqual([]);
  });

  it('rule form, with every section open', () => {
    const rule: Rule = {
      id: 'r', name: 'R', enabled: true, match: { url: 'a.com/*' },
      actions: [{ group: { title: 'A', color: 'blue' } }, { close: { after: '3s', mode: 'suggest' } }],
    };
    render(RuleFields, { rule, form: ruleForm(rule)!, index: 0, tabs: [], serverErrors: [], onPatch: vi.fn() });
    expect(unhelped()).toEqual([]);
  });

  it('Recipes page, every built-in recipe with params', async () => {
    const builtins = builtinRecipes();
    const items: RecipeListItem[] = Object.values(builtins).map((b) => ({
      id: b.recipe, source: 'builtin', enabled: true, params: {}, name: b.name, description: b.description,
      paramDefs: b.params ?? {}, needs: { origins: [], permissions: [] }, status: { ok: true, missing: { origins: [], permissions: [] } }, rules: {},
    }));
    send.mockImplementation(async (req: { type: string }) => (req.type === 'recipes.list' ? { ok: true, data: { recipes: items, rev: 'r' } } : { ok: true, data: null }));
    render(Recipes, { saved: defaultConfig(), baseRev: 'r', dirty: false, onApplied: vi.fn() });
    await screen.findByRole('region', { name: 'Finished' });
    expect(unhelped()).toEqual([]);
  });
});
