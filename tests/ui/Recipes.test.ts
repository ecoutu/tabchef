// @vitest-environment jsdom
// Recipes page (M2 T15). Enable follows ruling R5: requestNeeds FIRST (synchronously, in the click's user gesture),
// then preview.change for the config with the recipe enabled, then on Apply recipes.enable {id, params, baseRev}.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/svelte';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
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
import { RECIPES_GUIDE_URL } from '../../src/ui/routes';

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
/** Render the page and expand every card once the list loads (cards start collapsed unless they need attention, #248). */
async function renderOpen(p: ReturnType<typeof props>) {
  const r = render(Recipes, p);
  await screen.findAllByRole('region');
  for (const t of document.querySelectorAll<HTMLButtonElement>('button.toggle[aria-expanded="false"]')) await fireEvent.click(t);
  return r;
}
const sent = (type: string) => send.mock.calls.map((c) => c[0]).filter((r) => r.type === type);

describe('Recipes: cards', () => {
  it('the intro links to the guide to recipes and rules, in a new tab', () => {
    render(Recipes, props());
    const a = screen.getByRole('link', { name: 'Guide to recipes and rules' }) as HTMLAnchorElement;
    expect(a.href).toBe(RECIPES_GUIDE_URL);
    expect(a.target).toBe('_blank');
  });

  it('a rule that can never match (redirect patterns left empty) reads Inactive, not Active', async () => {
    items = [finishedItem({ enabled: true }, true)];
    const saved = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true } : r)) };
    await renderOpen(props({ saved }));
    const c = await card('Finished');
    expect(c.querySelector('[data-rule="finished/redirect"]')!.textContent).toContain('Inactive: no URL patterns');
    expect(c.querySelector('[data-rule="finished/oauth-callback"]')!.textContent).toContain('Active');
  });

  it('a Meet rule whose page texts were cleared reads Inactive ("no patterns"), not Active', async () => {
    items = [finishedItem({ enabled: true }, true)];
    const saved = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true, params: { meetEndedTexts: [] } } : r)) };
    await renderOpen(props({ saved }));
    const c = await card('Finished');
    expect(c.querySelector('[data-rule="finished/meet-ended"]')!.textContent).toContain('Inactive: no patterns');
  });

  it('every param of the built-in Finished recipe has a help tip from its ParamDef', async () => {
    const { builtinRecipes } = await import('../../src/recipes/load');
    const defs = builtinRecipes().finished!.params!;
    items = [finishedItem({ paramDefs: defs })];
    await renderOpen(props());
    await card('Finished');
    for (const def of Object.values(defs)) {
      expect(def.help, def.label).toBeTruthy();
      const btn = screen.getByRole('button', { name: `About ${def.label}` });
      expect(document.getElementById(btn.getAttribute('aria-describedby')!)?.textContent).toBe(def.help);
    }
  });

  it('cards start collapsed to name, status and description; the toggle shows and hides the rest (#248)', async () => {
    render(Recipes, props());
    const c = await card('Finished');
    const toggle = within(c).getByRole('button', { name: 'Finished' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(c.textContent).toContain('Closes OAuth callback tabs');
    expect(c.textContent).toContain('Off');
    expect(c.textContent).not.toContain('Needs access to meet.google.com');
    expect(within(c).queryByRole('button', { name: 'Enable' })).toBeNull();
    expect(within(c).queryByLabelText('Close after')).toBeNull();

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(c.textContent).toContain('Needs access to meet.google.com');

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(c).queryByRole('button', { name: 'Enable' })).toBeNull();
  });

  it('openId (#/recipes?open=<id>) opens only that card and scrolls to it once; an unknown id opens none (#248)', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      items = [finishedItem(), { ...finishedItem(), id: 'other', name: 'Other' }];
      render(Recipes, { ...props(), openId: 'other' });
      const other = await card('Other');
      await waitFor(() => expect(within(other).getByRole('button', { name: 'Other' }).getAttribute('aria-expanded')).toBe('true'));
      expect(within(other).getByRole('button', { name: 'Enable' })).toBeTruthy();
      expect(within(await card('Finished')).getByRole('button', { name: 'Finished' }).getAttribute('aria-expanded')).toBe('false');
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      expect(scroll.mock.contexts[0]).toBe(other);
      const lists = sent('recipes.list').length;
      for (const cb of permListeners.list) cb();
      await waitFor(() => expect(sent('recipes.list').length).toBeGreaterThan(lists));
      await new Promise((r) => setTimeout(r, 50));
      expect(scroll).toHaveBeenCalledTimes(1);
      cleanup();
      scroll.mockClear();
      render(Recipes, { ...props(), openId: 'nope' });
      await card('Finished');
      expect(screen.queryAllByRole('button', { expanded: true })).toEqual([]);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('a new openId opens and scrolls to that card too; dropping it (the Recipes tab) keeps open cards and their edits (#248)', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      items = [finishedItem(), { ...finishedItem(), id: 'other', name: 'Other' }];
      const { rerender } = render(Recipes, { ...props(), openId: 'finished' });
      const fin = await card('Finished');
      await waitFor(() => expect(within(fin).getByRole('button', { name: 'Finished' }).getAttribute('aria-expanded')).toBe('true'));
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      await fireEvent.input(within(fin).getByLabelText('Close after'), { target: { value: '7s' } });
      await rerender({ openId: 'other' });
      const other = screen.getByRole('region', { name: 'Other' });
      await waitFor(() => expect(within(other).getByRole('button', { name: 'Other' }).getAttribute('aria-expanded')).toBe('true'));
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
      expect(scroll.mock.contexts[1]).toBe(other);
      await rerender({ openId: undefined });
      expect(within(fin).getByRole('button', { name: 'Finished' }).getAttribute('aria-expanded')).toBe('true');
      expect((within(fin).getByLabelText('Close after') as HTMLInputElement).value).toBe('7s');
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('an open card stays open, with its edits, when the list reloads', async () => {
    render(Recipes, props());
    await fireEvent.click(within(await card('Finished')).getByRole('button', { name: 'Finished' }));
    await fireEvent.input(screen.getByLabelText('Close after'), { target: { value: '7s' } });
    const lists = sent('recipes.list').length;
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(sent('recipes.list').length).toBeGreaterThan(lists));
    expect(within(await card('Finished')).getByRole('button', { name: 'Finished' }).getAttribute('aria-expanded')).toBe('true');
    expect((screen.getByLabelText('Close after') as HTMLInputElement).value).toBe('7s');
  });

  it('shows name, description, needs, status and a params form generated from ParamDef', async () => {
    await renderOpen(props());
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
    await renderOpen(props({ saved: { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true } : r)) } }));
    const c = await card('Finished');
    const status = (x: Element) => [...x.childNodes].filter((n) => n.nodeName !== 'BUTTON' && n.nodeName !== 'A').map((n) => n.textContent).join('');
    const rows = [...c.querySelectorAll('[data-rule]')].map((x) => status(x).replace(/\s+/g, ' ').trim());
    expect(rows).toEqual([
      'Close OAuth callback tabs: Active',
      `Close Meet tabs after the call ends: ${PAUSED}`,
      'Close redirect landing tabs: Inactive: no URL patterns',
    ]);
    // #225: the paused rule can be unlocked from its row (no connection alternative: no Connections link).
    const meet = c.querySelector('[data-rule="finished/meet-ended"]')!;
    expect(meet.querySelector('button')!.textContent).toBe('Allow access');
    expect(meet.querySelector('a')).toBeNull();
    await fireEvent.click(meet.querySelector('button')!);
    expect(request).toHaveBeenCalledWith({ origins: [MEET], permissions: ['scripting'] });
  });

  it('a rule turned off in #/rules (ruleEnabled, R56) shows Off; one turned on shows Active', async () => {
    items = [finishedItem({ enabled: true }, true)];
    const saved = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true, ruleEnabled: { redirect: false } } : r)) };
    await renderOpen(props({ saved }));
    const c = await card('Finished');
    expect(c.querySelector('[data-rule="finished/redirect"]')!.textContent).toBe('Close redirect landing tabs: Off');
    cleanup();
    items = [{ ...finishedItem({ enabled: true }, true), id: 'github-prs', name: 'GitHub pull requests', paramDefs: {}, rules: {} }];
    const gh = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'github-prs' ? { ...r, ruleEnabled: { 'group-by-repo': true } } : r)) };
    await renderOpen(props({ saved: gh }));
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
    await renderOpen(props({ saved }));
    const c = await card('Mine');
    expect(ruleOn(ref, raw)).toBe(true);
    expect((ruleRows(saved).find((r) => r.key === 'mine/g') as { on: boolean }).on).toBe(true);
    expect(c.querySelector('[data-rule="mine/g"]')!.textContent).toBe('Group: Active');
  });

  it('shows a paused recipe\'s own reason', async () => {
    items = [finishedItem({ enabled: true, needs: { origins: ['https://x.example/*'], permissions: ['scripting'] }, status: { ok: false, missing: none, reason: 'Paused: needs access to x.example' } })];
    await renderOpen(props());
    expect((await card('Finished')).textContent).toContain('Paused: needs access to x.example');
  });
});

describe('Recipes: Enable (R5 flow)', () => {
  it('calls chrome.permissions.request inside the click handler, then previews, then sends recipes.enable', async () => {
    await renderOpen(props());
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
    await renderOpen(p);
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
    await renderOpen(props());
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('Could not preview: boom')).toBeTruthy();
    expect(sent('recipes.enable')).toHaveLength(0);
  });

  it('Meet denied: only rule-level needs, so it enables anyway (the meet rule shows paused)', async () => {
    request.mockImplementation(() => Promise.resolve(false));
    await renderOpen(props());
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
  });

  it('recipe-level needs denied: does not enable and says why', async () => {
    request.mockImplementation(() => Promise.resolve(false));
    items = [finishedItem({ needs: { origins: ['https://x.example/*'], permissions: ['scripting'] }, status: { ok: false, missing: { origins: ['https://x.example/*'], permissions: ['scripting'] }, reason: 'Paused: needs access to x.example' } })];
    await renderOpen(props());
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
    await renderOpen(p);
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(await screen.findByText(/Settings changed elsewhere/)).toBeTruthy();
    await waitFor(() => expect(p.onApplied).toHaveBeenCalled());
  });

  it('with unsaved rule edits, recipe changes are disabled', async () => {
    await renderOpen(props({ dirty: true }));
    expect(((await screen.findByRole('button', { name: 'Enable' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Save or discard your rule edits first/)).toBeTruthy();
  });
});

describe('Recipes: params and disable', () => {
  const enabledCfg = (): Config => ({ ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true, params: { delay: '5s' } } : r)) });

  it('Save settings sends the complete params object through preview then recipes.setParams (T8: setParams replaces)', async () => {
    items = [finishedItem({ enabled: true, params: { delay: '5s' } }, true)];
    await renderOpen(props({ saved: enabledCfg() }));
    const mode = (await screen.findByLabelText('Close automatically or suggest in the Finished list')) as HTMLSelectElement;
    await fireEvent.change(mode, { target: { value: 'suggest' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(sent('recipes.setParams')).toHaveLength(1));
    expect(sent('recipes.setParams')[0]).toEqual({ type: 'recipes.setParams', id: 'finished', params: { ...finishedDefaults, delay: '5s', mode: 'suggest' }, baseRev: 'r1' });
    expect(sent('preview.change')).toHaveLength(1);
  });

  it('shows a param error inline and blocks Enable', async () => {
    await renderOpen(props());
    await fireEvent.input(await screen.findByLabelText('Close after'), { target: { value: '5 seconds' } });
    expect(screen.getByText(/must be a duration/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enable' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a setting in error keeps its card open: the toggle is disabled until it is fixed (#248)', async () => {
    await renderOpen(props());
    const c = await card('Finished');
    const toggle = within(c).getByRole('button', { name: 'Finished' }) as HTMLButtonElement;
    await fireEvent.input(within(c).getByLabelText('Close after'), { target: { value: '5 seconds' } });
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe('Kept open while a setting here has an error');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(c).getByText(/must be a duration/)).toBeTruthy();
    await fireEvent.input(within(c).getByLabelText('Close after'), { target: { value: '5s' } });
    expect(toggle.disabled).toBe(false);
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('a card closed before its settings went bad from elsewhere stays open while the fix is typed (#248)', async () => {
    render(Recipes, props());
    const c = await card('Finished');
    const toggle = within(c).getByRole('button', { name: 'Finished' });
    await fireEvent.click(toggle);
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    items = [finishedItem({ params: { delay: 'soon' } })];
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    await fireEvent.input(within(c).getByLabelText('Close after'), { target: { value: '5s' } });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('stored settings in error open their card on load (#248)', async () => {
    items = [finishedItem({ params: { delay: 'soon' } })];
    render(Recipes, props());
    const c = await card('Finished');
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Finished' }).getAttribute('aria-expanded')).toBe('true'));
    expect(within(c).getByText(/must be a duration/)).toBeTruthy();
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
    await renderOpen(props({ saved }));
    await fireEvent.input(await screen.findByLabelText('Site patterns'), { target: { value: 'a.example' } });
    expect(screen.getByText(/a\.example: must be a Chrome match pattern/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enable' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Disable previews then sends recipes.disable', async () => {
    items = [finishedItem({ enabled: true }, true)];
    await renderOpen(props({ saved: enabledCfg() }));
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
    await renderOpen(props());
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
    await renderOpen(props());
    await fireEvent.input(await screen.findByLabelText('Close after'), { target: { value: '7s' } });
    const before = send.mock.calls.length;
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(send.mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 0));
    expect(delay()).toBe('7s');
  });

  it('a recipe whose stored params changed takes the stored values', async () => {
    await renderOpen(props());
    await fireEvent.input(await screen.findByLabelText('Close after'), { target: { value: '7s' } });
    items = [finishedItem({ params: { delay: '9s' } })];
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(delay()).toBe('9s'));
  });
});

describe('Recipes: capability levels (M3 T12)', () => {
  const GH = 'https://github.com/*';
  const JIRA = 'https://acme.atlassian.net/*';
  const levels: NonNullable<RecipeListItem['levels']> = [
    { id: 'titles', label: 'Titles', available: true },
    { id: 'page', label: 'Page details', available: false, needs: 'github.com, acme.atlassian.net', missing: { origins: [GH, JIRA], permissions: ['scripting'], connections: [] } },
    { id: 'connections', label: 'Connections', available: false, needs: 'GitHub or Jira connection', missing: { origins: [], permissions: [], connections: ['github', 'jira'] } },
  ];

  const texts = (c: HTMLElement) => [...c.querySelectorAll('.levels [data-level] .level-text')].map((r) => r.textContent);
  const lists = () => send.mock.calls.filter(([r]) => (r as { type: string }).type === 'recipes.list').length;

  it('renders each level with the exact copy', async () => {
    items = [finishedItem({ levels })];
    await renderOpen(props());
    const c = await card('Finished');
    await waitFor(() => expect(texts(c)).toEqual([
      'Titles: available',
      'Page details: locked, needs github.com, acme.atlassian.net',
      'Connections: locked, needs GitHub or Jira connection',
    ]));
  });

  it('a locked host level requests its hosts in the click and reloads once (through the permissions event); a locked connection level links to #/connections', async () => {
    items = [finishedItem({ levels })];
    await renderOpen(props());
    const c = await card('Finished');
    await waitFor(() => expect(c.querySelector('[data-level="page"] button')).not.toBeNull());
    expect(c.querySelector('[data-level="titles"] button, [data-level="titles"] a')).toBeNull();
    expect(c.querySelector('[data-level="connections"] button')).toBeNull();
    expect(c.querySelector('[data-level="connections"] a')!.getAttribute('href')).toBe('#/connections');
    log = [];
    const before = lists();
    await fireEvent.click(c.querySelector('[data-level="page"] button')!);
    expect(log[0]).toBe(`request ${JSON.stringify({ origins: [GH, JIRA], permissions: ['scripting'] })}`);
    await new Promise((r) => setTimeout(r, 0));
    expect(lists()).toBe(before); // the grant itself does not reload ...
    for (const cb of permListeners.list) cb(); // ... permissions.onAdded does, once
    await waitFor(() => expect(lists()).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 0));
    expect(lists()).toBe(before + 1);
  });

  it('a locked level missing only a permission (scripting) still has the Allow button, which requests it', async () => {
    const only = { id: 'page', label: 'Page details', available: false, needs: 'the scripting permission', missing: { origins: [], permissions: ['scripting'], connections: [] } };
    items = [finishedItem({ levels: [levels[0]!, only] })];
    await renderOpen(props());
    const c = await card('Finished');
    await waitFor(() => expect(c.querySelector('[data-level="page"] button')).not.toBeNull());
    log = [];
    await fireEvent.click(c.querySelector('[data-level="page"] button')!);
    expect(log[0]).toBe(`request ${JSON.stringify({ origins: [], permissions: ['scripting'] })}`);
  });

  it('an available level whose connection needs a new sign-in reads "available" and links to sign in again (M3-R89)', async () => {
    items = [finishedItem({ levels: [levels[0]!, { id: 'connections', label: 'Connections', available: true, reauth: ['github'] }] })];
    await renderOpen(props());
    const c = await card('Finished');
    await waitFor(() => expect(texts(c)).toEqual(['Titles: available', 'Connections: available']));
    const a = c.querySelector('[data-level="connections"] a')!;
    expect(a.textContent).toBe('Sign in again');
    expect(a.getAttribute('href')).toBe('#/connections');
    expect(c.querySelector('[data-level="connections"] .level-text')!.classList.contains('locked')).toBe(false);
    expect(c.querySelector('[data-level="titles"] a')).toBeNull();
  });

  it('a connections.changed broadcast reloads the list: the levels re-render; unmounting unsubscribes', async () => {
    items = [finishedItem({ levels })];
    const { unmount } = await renderOpen(props());
    const c = await card('Finished');
    await waitFor(() => expect(texts(c)[2]).toBe('Connections: locked, needs GitHub or Jira connection'));
    items = [finishedItem({ levels: levels.map((l) => (l.id === 'connections' ? { id: l.id, label: l.label, available: true } : l)) })];
    const trigger = (m: unknown) => (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> }).trigger(m);
    await trigger({ type: 'other' });
    await trigger({ type: 'connections.changed', id: 'github' });
    await waitFor(() => expect(texts(c)[2]).toBe('Connections: available'));
    const before = lists();
    unmount();
    await trigger({ type: 'connections.changed', id: 'github' });
    await new Promise((r) => setTimeout(r, 0));
    expect(lists()).toBe(before);
  });

  it('a running recipe whose connection needs a new sign-in starts open, says "Needs attention", and follows connections.changed (#248)', async () => {
    const reauth = { id: 'connections', label: 'Connections', available: true, reauth: ['github'] };
    items = [finishedItem({ enabled: true, levels: [levels[0]!, reauth] })];
    render(Recipes, props());
    const c = await card('Finished');
    await waitFor(() => expect(c.querySelector('.attention')?.textContent).toBe('Needs attention'));
    expect(within(c).getByRole('button', { name: 'Finished' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(c).getByRole('link', { name: 'Sign in again' })).toBeTruthy();
    items = [finishedItem({ enabled: true, levels: [levels[0]!, { id: 'connections', label: 'Connections', available: true }] })];
    const trigger = (m: unknown) => (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> }).trigger(m);
    await trigger({ type: 'connections.changed', id: 'github' });
    await waitFor(() => expect(c.querySelector('.attention')).toBeNull());
    expect(within(c).getByRole('button', { name: 'Finished' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('a locked level on a running recipe is an optional upgrade: no "Needs attention" (#248)', async () => {
    items = [finishedItem({ enabled: true, levels })];
    render(Recipes, props());
    const c = await card('Finished');
    expect(c.querySelector('.attention')).toBeNull();
  });
});

describe('Recipes: a rule paused for "a connection or a host" (#225)', () => {
  const GH = 'https://github.com/*';
  const REASON = 'Paused: needs the GitHub connection, or needs access to github.com';
  /** Merged PRs as recipes.list sends it on a fresh install: pr-state's own needs are only `anyOf` alternatives, so its
   * `needs` is empty; its status lists what the alternatives miss. */
  function mergedItem(over: Partial<RecipeListItem> = {}, prStateOk = false): RecipeListItem {
    return {
      id: 'merged-prs', source: 'builtin', enabled: false, params: {}, name: 'Merged PRs',
      description: 'Lists open tabs of merged GitHub pull requests in the popup\'s Merged tab, and can close them.',
      paramDefs: {}, needs: none, status: { ok: true, missing: none },
      rules: {
        'merged-prs/pr-state': {
          needs: none,
          status: prStateOk ? { ok: true, missing: none, level: 0 } : { ok: false, missing: { origins: [GH], permissions: ['scripting'] }, reason: REASON },
        },
      },
      ...over,
    };
  }
  const withMerged = (enabled: boolean): Config => {
    const c = defaultConfig();
    return { ...c, recipes: c.recipes.map((r) => (r.id === 'merged-prs' ? { ...r, enabled } : r)) };
  };
  const row = (c: HTMLElement) => c.querySelector('[data-rule="merged-prs/pr-state"]') as HTMLElement;

  it('Enable requests github.com (and scripting) in the click when neither github.com nor the GitHub connection is there', async () => {
    items = [mergedItem()];
    await renderOpen(props({ saved: withMerged(false) }));
    const c = await card('Merged PRs');
    const clicked = fireEvent.click(within(c).getByRole('button', { name: 'Enable' }));
    expect(request).toHaveBeenCalledWith({ origins: [GH], permissions: ['scripting'] }); // synchronously, in the gesture
    await clicked;
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
  });

  it('Enable asks for nothing when the rule already runs (the GitHub connection is set up)', async () => {
    items = [mergedItem({}, true)];
    await renderOpen(props({ saved: withMerged(false) }));
    const c = await card('Merged PRs');
    await fireEvent.click(within(c).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
    expect(request).not.toHaveBeenCalled();
  });

  it('a denied prompt still enables (a rule-level need): the paused rule offers Allow access and Set up a connection', async () => {
    request.mockImplementation((p: unknown) => { log.push(`request ${JSON.stringify(p)}`); return Promise.resolve(false); });
    items = [mergedItem()];
    const list = send.getMockImplementation()!;
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'recipes.enable') items = [mergedItem({ enabled: true })];
      return list(req);
    });
    await renderOpen(props({ saved: withMerged(false) }));
    const c = await card('Merged PRs');
    await fireEvent.click(within(c).getByRole('button', { name: 'Enable' }));
    expect(request).toHaveBeenCalledWith({ origins: [GH], permissions: ['scripting'] });
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
    await waitFor(() => expect(c.querySelector('.status')!.textContent).toBe('On'));
    expect(within(c).getByRole('status').textContent).toBe('Enabled.');
    expect(row(c).textContent).toContain(REASON);
    expect(within(row(c)).getByRole('link', { name: 'Set up a connection' }).getAttribute('href')).toBe('#/connections');
    log = [];
    await fireEvent.click(within(row(c)).getByRole('button', { name: 'Allow access' }));
    expect(log[0]).toBe(`request ${JSON.stringify({ origins: [GH], permissions: ['scripting'] })}`);
  });

  const DENIED = 'Read pull request state: Not allowed: needs the GitHub connection, or needs access to github.com (permission denied).';

  it('a denied Allow access on the rule row says so on the card', async () => {
    request.mockImplementation(() => Promise.resolve(false));
    items = [mergedItem({ enabled: true })];
    await renderOpen(props({ saved: withMerged(true) }));
    const c = await card('Merged PRs');
    await waitFor(() => expect(row(c).textContent).toContain(REASON));
    await fireEvent.click(within(row(c)).getByRole('button', { name: 'Allow access' }));
    expect((await within(c).findByRole('alert')).textContent).toBe(DENIED);
  });

  it('a failed Allow access (the request rejects) says so too', async () => {
    request.mockImplementation(() => Promise.reject(new Error('boom')));
    items = [mergedItem({ enabled: true })];
    await renderOpen(props({ saved: withMerged(true) }));
    const c = await card('Merged PRs');
    await waitFor(() => expect(row(c).textContent).toContain(REASON));
    await fireEvent.click(within(row(c)).getByRole('button', { name: 'Allow access' }));
    expect((await within(c).findByRole('alert')).textContent).toBe(DENIED);
  });

  it('auto-close-merged, turned on in #/rules and needing only the GitHub connection, offers only the Connections link', async () => {
    const ONLY_CONN = 'Paused: needs the GitHub connection';
    items = [mergedItem({ enabled: true, rules: {
      ...mergedItem().rules,
      'merged-prs/auto-close-merged': { needs: none, status: { ok: false, missing: none, reason: ONLY_CONN } },
    } })];
    const c0 = defaultConfig();
    const saved = { ...c0, recipes: c0.recipes.map((r) => (r.id === 'merged-prs' ? { ...r, enabled: true, ruleEnabled: { 'auto-close-merged': true } } : r)) };
    await renderOpen(props({ saved }));
    const c = await card('Merged PRs');
    const auto = () => c.querySelector('[data-rule="merged-prs/auto-close-merged"]') as HTMLElement;
    await waitFor(() => expect(auto().textContent).toContain(ONLY_CONN));
    expect(within(auto()).getByRole('link', { name: 'Set up a connection' }).getAttribute('href')).toBe('#/connections');
    expect(auto().querySelector('button')).toBeNull();
  });

  it('a running rule offers neither', async () => {
    items = [mergedItem({ enabled: true }, true)];
    await renderOpen(props({ saved: withMerged(true) }));
    const c = await card('Merged PRs');
    await waitFor(() => expect(row(c).textContent).toContain('Active'));
    expect(row(c).querySelector('button, a')).toBeNull();
  });

  it('an enabled recipe with a paused rule starts open with its unlock, and says "Needs attention" next to On (#248)', async () => {
    items = [mergedItem({ enabled: true })];
    render(Recipes, props({ saved: withMerged(true) }));
    const c = await card('Merged PRs');
    expect(c.querySelector('.status')!.textContent).toBe('On');
    expect(c.querySelector('.attention')?.textContent).toBe('Needs attention');
    expect(within(c).getByRole('button', { name: 'Merged PRs' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(c).getByRole('button', { name: 'Allow access' })).toBeTruthy();
    expect(within(c).getByRole('link', { name: 'Set up a connection' })).toBeTruthy();
  });

  it('a card opened for attention stays open, with its edits, after the attention clears once it was edited (#248)', async () => {
    items = [mergedItem({ enabled: true, paramDefs: { days: { type: 'number', default: 1, label: 'Days' } } })];
    render(Recipes, props({ saved: withMerged(true) }));
    const c = await card('Merged PRs');
    await fireEvent.input(within(c).getByLabelText('Days'), { target: { value: '5' } });
    items = [mergedItem({ enabled: true, paramDefs: { days: { type: 'number', default: 1, label: 'Days' } } }, true)];
    const lists = sent('recipes.list').length;
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(sent('recipes.list').length).toBeGreaterThan(lists));
    await waitFor(() => expect(c.querySelector('.attention')).toBeNull());
    expect(within(c).getByRole('button', { name: 'Merged PRs' }).getAttribute('aria-expanded')).toBe('true');
    expect((within(c).getByLabelText('Days') as HTMLInputElement).value).toBe('5');
  });

  it('collapsing a card that needs attention keeps it collapsed across reloads; the hint stays (#248)', async () => {
    items = [mergedItem({ enabled: true })];
    render(Recipes, props({ saved: withMerged(true) }));
    const c = await card('Merged PRs');
    await fireEvent.click(within(c).getByRole('button', { name: 'Merged PRs' }));
    expect(within(c).queryByRole('button', { name: 'Allow access' })).toBeNull();
    const lists = sent('recipes.list').length;
    for (const cb of permListeners.list) cb();
    await waitFor(() => expect(sent('recipes.list').length).toBeGreaterThan(lists));
    expect(within(c).getByRole('button', { name: 'Merged PRs' }).getAttribute('aria-expanded')).toBe('false');
    expect(c.querySelector('.attention')?.textContent).toBe('Needs attention');
  });

  it('no "Needs attention" when the rule runs, or when the recipe is off (#248)', async () => {
    items = [mergedItem({ enabled: true }, true)];
    render(Recipes, props({ saved: withMerged(true) }));
    expect((await card('Merged PRs')).querySelector('.attention')).toBeNull();
    cleanup();
    items = [mergedItem()];
    render(Recipes, props({ saved: withMerged(false) }));
    const c = await card('Merged PRs');
    expect(c.querySelector('.status')!.textContent).toBe('Off');
    expect(c.querySelector('.attention')).toBeNull();
    expect(within(c).getByRole('button', { name: 'Merged PRs' }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Recipes: a recipe with levels whose PR rule is paused (#225, GitHub issue projects / Jira ticket projects)', () => {
  const GH = 'https://github.com/*';
  const REASON = 'Paused: needs the GitHub connection, or needs access to github.com';
  const levels: NonNullable<RecipeListItem['levels']> = [
    { id: 'titles', label: 'Titles', available: true },
    { id: 'page', label: 'Page details', available: false, needs: 'github.com', missing: { origins: [GH], permissions: ['scripting'], connections: [] } },
    { id: 'connections', label: 'Connections', available: false, needs: 'GitHub connection', missing: { origins: [], permissions: [], connections: ['github'] } },
  ];
  function issueItem(over: Partial<RecipeListItem> = {}): RecipeListItem {
    return {
      id: 'github-issue', source: 'builtin', enabled: false, params: {}, name: 'GitHub issue projects', description: 'Issue projects.',
      paramDefs: {}, needs: none, status: { ok: true, missing: none }, levels,
      rules: {
        'github-issue/issue': { needs: none, status: { ok: true, missing: none, level: 2 } },
        'github-issue/pr': { needs: none, status: { ok: false, missing: { origins: [GH], permissions: ['scripting'] }, reason: REASON } },
      },
      ...over,
    };
  }
  const withIssue = (enabled: boolean): Config => {
    const c = defaultConfig();
    return { ...c, recipes: c.recipes.map((r) => (r.id === 'github-issue' ? { ...r, enabled } : r)) };
  };

  it('Enable requests the paused rule\'s missing hosts in the click; a denied prompt still enables', async () => {
    request.mockImplementation((p: unknown) => { log.push(`request ${JSON.stringify(p)}`); return Promise.resolve(false); });
    items = [issueItem()];
    await renderOpen(props({ saved: withIssue(false) }));
    const c = await card('GitHub issue projects');
    const clicked = fireEvent.click(within(c).getByRole('button', { name: 'Enable' }));
    expect(request).toHaveBeenCalledWith({ origins: [GH], permissions: ['scripting'] }); // synchronously, in the gesture
    await clicked;
    await waitFor(() => expect(sent('recipes.enable')).toHaveLength(1));
  });

  it('its rule rows show no buttons or links (the levels offer them)', async () => {
    items = [issueItem({ enabled: true })];
    await renderOpen(props({ saved: withIssue(true) }));
    const c = await card('GitHub issue projects');
    const pr = () => c.querySelector('[data-rule="github-issue/pr"]') as HTMLElement;
    await waitFor(() => expect(pr().textContent).toContain(REASON));
    expect(c.querySelector('.rules button, .rules a')).toBeNull();
    expect(c.querySelector('[data-level="page"] button')).not.toBeNull();
  });

  it('a denied level Allow access says so on the card', async () => {
    request.mockImplementation(() => Promise.resolve(false));
    items = [issueItem({ enabled: true })];
    await renderOpen(props({ saved: withIssue(true) }));
    const c = await card('GitHub issue projects');
    await waitFor(() => expect(c.querySelector('[data-level="page"] button')).not.toBeNull());
    await fireEvent.click(c.querySelector('[data-level="page"] button')!);
    expect((await within(c).findByRole('alert')).textContent).toBe('Page details: Not allowed: needs github.com (permission denied).');
  });

  it('its paused PR rule leaves the hint to the levels: no "Needs attention" (#248)', async () => {
    items = [issueItem({ enabled: true })];
    render(Recipes, props({ saved: withIssue(true) }));
    expect((await card('GitHub issue projects')).querySelector('.attention')).toBeNull();
  });
});
