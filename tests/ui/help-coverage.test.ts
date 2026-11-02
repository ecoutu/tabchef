// @vitest-environment jsdom
// Every labelled setting on the options pages has a help tip: a <label> must be the label of a Field or LinesField
// (its direct child, not a label nested in the control slot) whose own "About …" button sits beside it. A new setting
// without one fails here. Every options component with a <label> is either rendered below (COVERED) or listed in
// EXCLUDED with the reason it is not a settings page, so adding one is a conscious choice.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import Rules from '../../src/entrypoints/options/Rules.svelte';
import { defaultConfig } from '../../src/core/config/defaults';
import { ruleForm } from '../../src/ui/rules-model';
import { builtinRecipes } from '../../src/recipes/load';
import type { Rule } from '../../src/core/lang/types';
import type { Config } from '../../src/core/types';
import type { RecipeListItem } from '../../src/engine/messages';

afterEach(cleanup);

const OPTIONS_DIR = resolve(import.meta.dirname, '../../src/entrypoints/options');
/** Options components whose labels the cases below render. */
const COVERED = ['Dedupe', 'Permissions', 'Recipes', 'RuleFields', 'Rules', 'Field', 'LinesField'];
/** Options components with labels that are not settings, and why. */
const EXCLUDED: Record<string, string> = {
  History: 'filters over the log, not settings',
  Import: 'a one-off import form (source, file, pasted JSON), not settings',
  Backups: 'a file picker for restoring a backup, not a setting',
  NewRule: 'a quick-create wizard; the rule it makes is then edited in the rule form (RuleFields), which is covered',
  RuleYaml: 'the YAML editor of a whole rule, not one setting',
};

/** The "About …" button that belongs to label `l`: beside it in its Field, or in the head of its LinesField. */
function tipOf(l: HTMLLabelElement): Element | null {
  const box = l.parentElement;
  if (box?.matches('.field')) return box.querySelector(':scope > .help-tip > button[aria-label^="About "]');
  if (box?.matches('.lf > .head')) return box.querySelector(':scope > .help-tip > button[aria-label^="About "]');
  return null;
}

/** Every label on the page and the ones without a tip. */
function audit(): { count: number; unhelped: string[] } {
  const labels = [...document.querySelectorAll('label')];
  return { count: labels.length, unhelped: labels.filter((l) => !tipOf(l)).map((l) => l.textContent!.trim().slice(0, 60)) };
}

const item = (o: Partial<RecipeListItem> & Pick<RecipeListItem, 'id' | 'name' | 'paramDefs'>): RecipeListItem => ({
  source: 'builtin', enabled: true, params: {}, description: '', needs: { origins: [], permissions: [] },
  status: { ok: true, missing: { origins: [], permissions: [] } }, rules: {}, ...o,
});

describe('every options setting has a help tip', () => {
  it('every options component with a <label> is covered here or excluded with a reason', () => {
    const withLabels = readdirSync(OPTIONS_DIR).filter((f) => f.endsWith('.svelte'))
      .filter((f) => readFileSync(join(OPTIONS_DIR, f), 'utf8').split('\n').some((l) => !/^\s*\/\//.test(l) && /<label\b/.test(l)))
      .map((f) => f.replace(/\.svelte$/, ''));
    expect(withLabels.filter((c) => !COVERED.includes(c) && !(c in EXCLUDED))).toEqual([]);
    for (const c of Object.keys(EXCLUDED)) expect(withLabels, `${c} (EXCLUDED) has no <label> any more`).toContain(c);
  });

  it('Duplicates page (with its permissions panel)', () => {
    render(Dedupe, { config: defaultConfig(), dirty: false, saving: false, serverErrors: [], onChange: vi.fn(), onSave: vi.fn() });
    const a = audit();
    expect(a.count).toBeGreaterThanOrEqual(11);
    expect(a.unhelped).toEqual([]);
  });

  it('rule form, with every section open', () => {
    const rule: Rule = {
      id: 'r', name: 'R', enabled: true, match: { url: 'a.com/*' },
      actions: [{ group: { title: 'A', color: 'blue' } }, { close: { after: '3s', mode: 'suggest' } }],
    };
    render(RuleFields, { rule, form: ruleForm(rule)!, index: 0, tabs: [], serverErrors: [], onPatch: vi.fn() });
    const a = audit();
    expect(a.count).toBeGreaterThanOrEqual(14);
    expect(a.unhelped).toEqual([]);
  });

  it('Rules page: the row bar of a user rule and of a recipe rule', () => {
    send.mockResolvedValue({ ok: false, error: 'x' });
    const user: Rule = { id: 'u', name: 'U', enabled: true, match: { url: 'a.com/*' }, actions: [{ group: { title: 'A', color: 'blue' } }] };
    const config: Config = { ...defaultConfig(), rules: [user], order: ['user/u'] };
    render(Rules, { config, tabs: [], dirty: false, saving: false, serverErrors: [], onChange: vi.fn(), onSave: vi.fn() });
    expect(screen.getByRole('button', { name: 'About Enabled' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About On (this recipe rule)' })).toBeTruthy();
    const a = audit();
    expect(a.count).toBeGreaterThanOrEqual(14);
    expect(a.unhelped).toEqual([]);
  });

  it('Recipes page: every built-in recipe with params, and one param of each kind', async () => {
    const builtins = builtinRecipes();
    const items: RecipeListItem[] = Object.values(builtins).map((b) => item({
      id: b.recipe, name: b.name, description: b.description, paramDefs: b.params ?? {},
    }));
    items.push(item({
      id: 'kinds', name: 'Every kind', source: 'user',
      paramDefs: {
        s: { type: 'string', default: 'x', label: 'A string', help: 'string help' },
        n: { type: 'number', default: 1, label: 'A number', help: 'number help' },
        b: { type: 'boolean', default: false, label: 'A boolean', help: 'boolean help' },
        e: { type: 'string', default: 'a', enum: ['a', 'b'], label: 'An enum', help: 'enum help' },
        d: { type: 'duration', default: '3s', label: 'A duration', help: 'duration help' },
        l: { type: 'string[]', default: ['x'], label: 'A list', help: 'list help' },
      },
    }));
    send.mockImplementation(async (req: { type: string }) => (req.type === 'recipes.list' ? { ok: true, data: { recipes: items, rev: 'r' } } : { ok: true, data: null }));
    render(Recipes, { saved: defaultConfig(), baseRev: 'r', dirty: false, onApplied: vi.fn() });
    await screen.findByRole('region', { name: 'Finished' });
    await screen.findByRole('region', { name: 'Every kind' });
    for (const label of ['A string', 'A number', 'A boolean', 'An enum', 'A duration', 'A list']) {
      expect(screen.getByRole('button', { name: `About ${label}` }), label).toBeTruthy();
    }
    const a = audit();
    expect(a.count).toBeGreaterThanOrEqual(11);
    expect(a.unhelped).toEqual([]);
  });
});
