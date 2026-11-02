// @vitest-environment jsdom
// Recipes page (M2 T15). Enable follows ruling R5: requestNeeds FIRST (synchronously, in the click's user gesture),
// then preview.change for the config with the recipe enabled, then on Apply recipes.enable {id, params, baseRev}.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { browser } from 'wxt/browser';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config } from '../../src/core/types';
import type { Recipe, RecipeRef } from '../../src/core/lang/types';
import type { RecipeListItem } from '../../src/engine/messages';
import type { PreviewResult } from '../../src/core/lang/preview';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
const permListeners = vi.hoisted(() => ({ list: [] as (() => void)[] }));
vi.mock('../../src/ui/permissions', async (orig) => ({
  ...(await orig<typeof import('../../src/ui/permissions')>()),
  onPermissionsChanged: (cb: () => void) => { permListeners.list.push(cb); return () => { permListeners.list = permListeners.list.filter((x) => x !== cb); }; },
}));
import Recipes from '../../src/entrypoints/options/Recipes.svelte';

const MEET = 'https://meet.google.com/*';
const PAUSED = 'Paused: needs access to meet.google.com';
const none = { origins: [] as string[], permissions: [] as string[] };
const finishedDefaults = {
  delay: '3s', mode: 'auto',
  callbackPatterns: ['http://localhost:*/*callback*', 'http://127.0.0.1:*/*callback*', '*/oauth/*/success*', '*/oauth2/*/callback*'],
  meetEndedTexts: ['You left the meeting', "You've left the call", 'The call has ended'],
  redirectPatterns: [],
};

function finishedItem(over: Partial<RecipeListItem> = {}, meetOk = false): RecipeListItem {
  return {
    id: 'finished', source: 'builtin', enabled: false, params: {}, name: 'Finished',
    description: 'Closes OAuth callback tabs, redirect tabs you listed, and Google Meet tabs once the call has ended.',
    paramDefs: {
      delay: { type: 'duration', default: '3s', label: 'Close after' },
      mode: { type: 'string', default: 'auto', enum: ['auto', 'suggest'], label: 'Close automatically or suggest in the Finished list' },
      callbackPatterns: { type: 'string[]', default: finishedDefaults.callbackPatterns, label: 'OAuth callback URL patterns' },
      meetEndedTexts: { type: 'string[]', default: finishedDefaults.meetEndedTexts, label: 'Page text that means a Meet call has ended' },
      redirectPatterns: { type: 'string[]', default: [], label: 'Redirect landing URL patterns (none by default)' },
    },
    needs: none, status: { ok: true, missing: none },
    rules: {
      'finished/meet-ended': {
        needs: { origins: [MEET], permissions: ['scripting'] },
        status: meetOk ? { ok: true, missing: none } : { ok: false, missing: { origins: [MEET], permissions: ['scripting'] }, reason: PAUSED },
      },
    },
    ...over,
  };
}

const effects: PreviewResult = { moves: [], closes: [{ tabId: 3, title: 'Callback', ruleKey: 'finished/oauth-callback', afterMs: 3000 }], groupsCreated: [], unchanged: 0, anchorsOpened: 0, dryRun: false };
const noEffects: PreviewResult = { moves: [], closes: [], groupsCreated: [], unchanged: 2, anchorsOpened: 0, dryRun: false };

let log: string[];
let items: RecipeListItem[];
let previewReply: { ok: true; data: PreviewResult } | { ok: false; error: string };
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  log = [];
  items = [finishedItem()];
  previewReply = { ok: true, data: noEffects };
  request = vi.fn((p: unknown) => { log.push(`request ${JSON.stringify(p)}`); return Promise.resolve(true); });
  (browser.permissions as unknown as { request: typeof request }).request = request;
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    log.push(req.type);
    if (req.type === 'recipes.list') return { ok: true, data: { recipes: items, rev: 'r1' } };
    if (req.type === 'preview.change') return previewReply;
    return { ok: true, data: null };
  });
});
afterEach(cleanup);

const props = (over: Partial<{ saved: Config; baseRev: string; dirty: boolean; onApplied: () => void }> = {}) =>
  ({ saved: defaultConfig(), baseRev: 'r1', dirty: false, onApplied: vi.fn(), ...over });
const card = async (name: string) => (await screen.findByRole('region', { name })) as HTMLElement;
const sent = (type: string) => send.mock.calls.map((c) => c[0]).filter((r) => r.type === type);

describe('Recipes: cards', () => {
  it('every param of the built-in Finished recipe has a help tip from its ParamDef', async () => {
    const { builtinRecipes } = await import('../../src/recipes/load');
    const defs = builtinRecipes().finished!.params!;
    items = [finishedItem({ paramDefs: defs })];
    render(Recipes, props());
    await card('Finished');
    for (const def of Object.values(defs)) {
      expect(def.help, def.label).toBeTruthy();
      const btn = screen.getByRole('button', { name: `About ${def.label}` });
      expect(document.getElementById(btn.getAttribute('aria-describedby')!)?.textContent).toBe(def.help);
    }
  });

  it('shows name, description, needs, status and a params form generated from ParamDef', async () => {
    render(Recipes, props());
    const c = await card('Finished');
    expect(c.textContent).toContain('Closes OAuth callback tabs');
    expect(c.textContent).toContain('Needs access to meet.google.com');
    expect(c.textContent).toContain('Off');
    expect((screen.getByLabelText('Close after') as HTMLInputElement).value).toBe('3s');
    const mode = screen.getByLabelText('Close automatically or suggest in the Finished list') as HTMLSelectElement;
    expect([...mode.options].map((o) => o.value)).toEqual(['auto', 'suggest']);
    expect((screen.getByLabelText('OAuth callback URL patterns') as HTMLTextAreaElement).value.split('\n')).toEqual(finishedDefaults.callbackPatterns);
  });

  it('renders per-recipe and per-rule status from recipes.list (R45): meet rule paused, oauth rule active', async () => {
    items = [finishedItem({ enabled: true })];
    render(Recipes, props({ saved: { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true } : r)) } }));
    const c = await card('Finished');
    const rows = [...c.querySelectorAll('[data-rule]')].map((x) => x.textContent!.replace(/\s+/g, ' ').trim());
    expect(rows).toEqual([
      'Close OAuth callback tabs: Active',
      `Close Meet tabs after the call ends: ${PAUSED}`,
      'Close redirect landing tabs: Active',
    ]);
  });

  it('a rule turned off in #/rules (ruleEnabled, R56) shows Off; one turned on shows Active', async () => {
    items = [finishedItem({ enabled: true }, true)];
    const saved = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true, ruleEnabled: { redirect: false } } : r)) };
    render(Recipes, props({ saved }));
    const c = await card('Finished');
    expect(c.querySelector('[data-rule="finished/redirect"]')!.textContent).toBe('Close redirect landing tabs: Off');
    cleanup();
    items = [{ ...finishedItem({ enabled: true }, true), id: 'github-prs', name: 'GitHub pull requests', paramDefs: {}, rules: {} }];
    const gh = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'github-prs' ? { ...r, ruleEnabled: { 'group-by-repo': true } } : r)) };
    render(Recipes, props({ saved: gh }));
    const g = await card('GitHub pull requests');
    expect(g.querySelector('[data-rule="github-prs/group-by-repo"]')!.textContent).toBe('Group GitHub tabs by repository: Active');
  });

  it('R57: rule status uses ruleOn, like the engine: a body rule without `enabled` counts as on', async () => {
    const { ruleOn } = await import('../../src/core/lang/compile');
    const { ruleRows } = await import('../../src/ui/rules-model');
    const raw = { id: 'g', name: 'Group', match: { url: '*' }, actions: [{ group: { title: 'S', color: 'blue' } }] } as unknown as Recipe['rules'][number];
    const body: Recipe = { recipe: 'mine', version: 1, name: 'Mine', description: 'd', rules: [raw] };
    const ref: RecipeRef = { id: 'mine', enabled: true, params: {}, source: 'user', body };
    const saved: Config = { ...defaultConfig(), recipes: [ref] };
    items = [{ id: 'mine', source: 'user', enabled: true, params: {}, name: 'Mine', description: 'd', paramDefs: {}, needs: none, status: { ok: true, missing: none }, rules: {} }];
    render(Recipes, props({ saved }));
    const c = await card('Mine');
    expect(ruleOn(ref, raw)).toBe(true);
    expect((ruleRows(saved).find((r) => r.key === 'mine/g') as { on: boolean }).on).toBe(true);
    expect(c.querySelector('[data-rule="mine/g"]')!.textContent).toBe('Group: Active');
  });

  it('shows a paused recipe\'s own reason', async () => {
    items = [finishedItem({ enabled: true, needs: { origins: ['https://x.example/*'], permissions: ['scripting'] }, status: { ok: false, missing: none, reason: 'Paused: needs access to x.example' } })];
    render(Recipes, props());
    expect((await card('Finished')).textContent).toContain('Paused: needs access to x.example');
  });
});

describe('Recipes: Enable (R5 flow)', () => {
  it('calls chrome.permissions.request inside the click handler, then previews, then sends recipes.enable', async () => {
    render(Recipes, props());
    const btn = await screen.findByRole('button', { name: 'Enable' });
    const clicked = fireEvent.click(btn);
    // Synchronously, inside the click (user gesture): nothing awaited before it.
    expect(request).toHaveBeenCalledWith({ origins: [MEET], permissions: ['scripting'] });
    await clicked;
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
    expect(log.filter((x) => x !== 'recipes.list')).toEqual([`request ${JSON.stringify({ origins: [MEET], permissions: ['scripting'] })}`, 'preview.change', 'recipes.enable']);
    expect(sent('recipes.enable')[0]).toEqual({ type: 'recipes.enable', id: 'finished', params: finishedDefaults, baseRev: 'r1' });
    const previewed = sent('preview.change')[0].config as Config;
    expect(previewed.recipes.find((r) => r.id === 'finished')).toMatchObject({ enabled: true, params: finishedDefaults });
  });

  it('with effects, opens the preview dialog; Apply enables, Cancel sends nothing', async () => {
    previewReply = { ok: true, data: effects };
    const p = props();
    render(Recipes, p);
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent('recipes.enable')).toHaveLength(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
    await waitFor(() => expect(p.onApplied).toHaveBeenCalled());
  });

  it('a failed preview shows the error and does not enable', async () => {
    previewReply = { ok: false, error: 'boom' };
    render(Recipes, props());
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('Could not preview: boom')).toBeTruthy();
    expect(sent('recipes.enable')).toHaveLength(0);
  });

  it('Meet denied: only rule-level needs, so it enables anyway (the meet rule shows paused)', async () => {
    request.mockImplementation(() => Promise.resolve(false));
    render(Recipes, props());
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
  });

  it('recipe-level needs denied: does not enable and says why', async () => {
    request.mockImplementation(() => Promise.resolve(false));
    items = [finishedItem({ needs: { origins: ['https://x.example/*'], permissions: ['scripting'] }, status: { ok: false, missing: { origins: ['https://x.example/*'], permissions: ['scripting'] }, reason: 'Paused: needs access to x.example' } })];
    render(Recipes, props());
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('Not enabled: needs access to x.example (permission denied).')).toBeTruthy();
    expect(sent('preview.change')).toHaveLength(0);
    expect(sent('recipes.enable')).toHaveLength(0);
  });

  it('a conflict on enable says settings changed and reloads', async () => {
    const p = props();
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'recipes.list') return { ok: true, data: { recipes: items, rev: 'r1' } };
      if (req.type === 'preview.change') return { ok: true, data: noEffects };
      return { ok: false, error: 'conflict' };
    });
    render(Recipes, p);
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText(/Settings changed elsewhere/)).toBeTruthy();
    await waitFor(() => expect(p.onApplied).toHaveBeenCalled());
  });

  it('with unsaved rule edits, recipe changes are disabled', async () => {
    render(Recipes, props({ dirty: true }));
    expect(((await screen.findByRole('button', { name: 'Enable' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Save or discard your rule edits first/)).toBeTruthy();
  });
});

describe('Recipes: params and disable', () => {
  const enabledCfg = (): Config => ({ ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true, params: { delay: '5s' } } : r)) });

  it('Save settings sends the complete params object through preview then recipes.setParams (T8: setParams replaces)', async () => {
    items = [finishedItem({ enabled: true, params: { delay: '5s' } }, true)];
    render(Recipes, props({ saved: enabledCfg() }));
    const mode = (await screen.findByLabelText('Close automatically or suggest in the Finished list')) as HTMLSelectElement;
    await fireEvent.change(mode, { target: { value: 'suggest' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(sent('recipes.setParams')).toHaveLength(1));
    expect(sent('recipes.setParams')[0]).toEqual({ type: 'recipes.setParams', id: 'finished', params: { ...finishedDefaults, delay: '5s', mode: 'suggest' }, baseRev: 'r1' });
    expect(sent('preview.change')).toHaveLength(1);
  });

  it('shows a param error inline and blocks Enable', async () => {
    render(Recipes, props());
    await fireEvent.input(await screen.findByLabelText('Close after'), { target: { value: '5 seconds' } });
    expect(screen.getByText(/must be a duration/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enable' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('validates host params (used in needs.hosts) as match patterns (T10 carry)', async () => {
    const body: Recipe = {
      recipe: 'sites', version: 1, name: 'Sites', description: 'Groups my sites.',
      params: { sites: { type: 'string[]', default: ['https://a.example/*'], label: 'Site patterns' } },
      needs: { hosts: '{params.sites}' as unknown as string[] },
      rules: [{ id: 'g', name: 'Group', enabled: true, match: { url: '*' }, actions: [{ group: { title: 'S', color: 'blue' } }] }],
    };
    const saved: Config = { ...defaultConfig(), recipes: [{ id: 'sites', enabled: false, params: {}, source: 'user', body }] };
    items = [{ id: 'sites', source: 'user', enabled: false, params: {}, name: 'Sites', description: 'Groups my sites.', paramDefs: body.params!,
      needs: { origins: ['https://a.example/*'], permissions: ['scripting'] }, status: { ok: false, missing: none, reason: 'Paused: needs access to a.example' }, rules: {} }];
    render(Recipes, props({ saved }));
    await fireEvent.input(await screen.findByLabelText('Site patterns'), { target: { value: 'a.example' } });
    expect(screen.getByText(/a\.example: must be a Chrome match pattern/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enable' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Disable previews then sends recipes.disable', async () => {
    items = [finishedItem({ enabled: true }, true)];
    render(Recipes, props({ saved: enabledCfg() }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(sent('recipes.disable')).toHaveLength(1));
    expect(sent('recipes.disable')[0]).toEqual({ type: 'recipes.disable', id: 'finished', baseRev: 'r1' });
    expect((sent('preview.change')[0].config as Config).recipes.find((r) => r.id === 'finished')!.enabled).toBe(false);
  });
});

describe('Recipes: unsaved param edits survive reloads (fix round 1)', () => {
  const gh = (enabled: boolean): RecipeListItem => ({ id: 'github-prs', source: 'builtin', enabled, params: {}, name: 'GitHub pull requests', description: 'PRs.',
    paramDefs: {}, needs: none, status: { ok: true, missing: none }, rules: {} });
  const delay = () => (screen.getByLabelText('Close after') as HTMLInputElement).value;

  it('edits on card A survive enabling card B (B\'s Apply reloads the list)', async () => {
    items = [finishedItem(), gh(false)];
    render(Recipes, props());
    await fireEvent.input(await screen.findByLabelText('Close after'), { target: { value: '7s' } });
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'recipes.list') return { ok: true, data: { recipes: items, rev: 'r2' } };
      if (req.type === 'preview.change') return { ok: true, data: noEffects };
      if (req.type === 'recipes.enable') { items = [finishedItem(), gh(true)]; return { ok: true, data: null }; }
      return { ok: true, data: null };
    });
    const ghCard = await card('GitHub pull requests');
    await fireEvent.click(ghCard.querySelector('button.primary')!);
    await waitFor(() => expect(ghCard.querySelector('button.primary')).toBeNull()); // reloaded: B is enabled now
    expect(delay()).toBe('7s');
  });

  it('edits survive a permissions change (onAdded / onRemoved reload)', async () => {
    render(Recipes, props());
    await fireEvent.input(await screen.findByLabelText('Close after'), { target: { value: '7s' } });
    const before = send.mock.calls.length;
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(send.mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 0));
    expect(delay()).toBe('7s');
  });

  it('a recipe whose stored params changed takes the stored values', async () => {
    render(Recipes, props());
    await fireEvent.input(await screen.findByLabelText('Close after'), { target: { value: '7s' } });
    items = [finishedItem({ params: { delay: '9s' } })];
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(delay()).toBe('9s'));
  });
});
