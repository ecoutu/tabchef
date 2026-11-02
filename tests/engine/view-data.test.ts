// Recipe views (M2 T17): views.list / view.data (read-only) and the view actions view.close / view.keep.
import { describe, expect, it, vi } from 'vitest';
import { badgeCount, createHandler, refreshBadge, type HandlerDeps } from '../../src/engine/messages';
import { pausedReason } from '../../src/engine/permissions';
import { afterConfigChange } from '../../src/engine/close-executor';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, RecipeRef } from '../../src/core/types';
import type { Recipe, Rule, View } from '../../src/core/lang/types';
import type { CloseSuggestion } from '../../src/engine/close-executor';
import { builtinRecipes } from '../../src/recipes/load';
import { compileProgram } from '../../src/core/lang/compile';

const ui = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
const content = { id: 'ext', tab: { id: 9 }, url: 'https://evil.example/' };
const MUTATING = new Set(['group', 'ungroup', 'moveTabs', 'moveGroup', 'updateGroup', 'closeTab', 'createTab', 'focusTab', 'setBadge']);
const CB = 'http://localhost:3000/auth/callback?code=1';
const MEET = 'https://meet.google.com/*';

type Loose = { ok: boolean; error?: string; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const enable = (c: Config, id: string, over: Partial<RecipeRef> = {}): Config => ({
  ...c, recipes: c.recipes.map((r) => (r.id === id ? { ...r, enabled: true, ...over } : r)),
});
const userRecipe = (id: string, rules: Rule[], views: View[], over: Partial<Recipe> = {}): RecipeRef => ({
  id, enabled: true, params: {}, source: 'user', body: { recipe: id, version: 1, name: id, description: id, rules, views, ...over },
});

function setup(o: { suggestions?: CloseSuggestion[]; granted?: (origin: string) => boolean; views?: boolean; beforeClose?: () => Promise<void> } = {}) {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  const mk = (id: number, url: string, x = {}) =>
    port.addTab({ id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...x });
  let cfg: Config = defaultConfig();
  const set = vi.fn(async (c: Config) => { cfg = c; });
  const added: unknown[] = [];
  const whyAdd = vi.fn();
  const locked = new Set<number>();
  const exempt = vi.fn(async () => {});
  const granted = o.granted ?? (() => true);
  const getProgram = async () => compileProgram(cfg, builtinRecipes()).program;
  const deps: HandlerDeps = {
    runtimeId: 'ext',
    extensionOrigin: 'chrome-extension://ext',
    store: {
      get: async () => cfg, set, backups: async () => [], restore: vi.fn(async () => {}),
      update: vi.fn(async (fn: (c: Config) => Config) => { const next = fn(cfg); await set(next); return next; }),
      status: async () => ({ syncing: true }),
    },
    port,
    getSettings: async () => (await getProgram()).dedupe,
    getProgram,
    safety: {
      pause: vi.fn(), resume: vi.fn(), isPaused: () => false, lock: (id) => { locked.add(id); }, unlock: (id) => { locked.delete(id); },
      isLocked: (id) => locked.has(id), lockedTabIds: () => [...locked], undo: vi.fn(async () => {}),
    },
    recentlyClosed: { ready: Promise.resolve(), list: () => [], add: (e) => { added.push(e); return 'id'; } },
    whyLog: { ready: Promise.resolve(), all: () => [], forTab: () => [], add: whyAdd },
    ask: { listPending: async () => [], resolvePending: vi.fn(async () => {}) },
    now: () => 42,
    ...(o.beforeClose && { beforeClose: o.beforeClose }),
    ...(o.views !== false && {
      views: {
        builtins: builtinRecipes(),
        getProgram,
        permissions: {
          check: async (n) => {
            const missing = n.origins.filter((x) => !granted(x));
            return missing.length
              ? { ok: false, missing: { origins: missing, permissions: [] }, reason: pausedReason({ origins: missing, permissions: [] }) }
              : { ok: true, missing: { origins: [], permissions: [] } };
          },
        },
        closes: { ready: Promise.resolve(), suggestions: () => o.suggestions ?? [], exempt },
      },
    }),
  };
  const handle = createHandler(deps);
  const setCfg = async (c: Config) => { cfg = c; };
  return { port, mk, deps, handle, set, added, whyAdd, locked, exempt, setCfg, getCfg: () => cfg };
}

const oauth: CloseSuggestion = { tabId: 3, url: CB, ruleKey: 'finished/oauth-callback', reason: 'Close OAuth callback tabs' };

describe('view.data', () => {
  it("view.data('finished') returns a suggested localhost tab", async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished', { params: { mode: 'suggest' } }));
    s.mk(1, 'https://example.com/'); s.mk(3, CB);
    const r = (await s.handle({ type: 'view.data', viewId: 'finished' }, ui)) as Loose;
    expect(r.ok).toBe(true);
    expect(r.data.kind).toBe('list');
    expect(r.data.rows).toEqual([
      expect.objectContaining({ tabId: 3, url: CB, title: 't3', suggested: true, reason: 'Close OAuth callback tabs' }),
    ]);
  });

  it('a suggestion for a tab that is gone is not listed', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    const r = (await s.handle({ type: 'view.data', viewId: 'finished' }, ui)) as Loose;
    expect(r.data.rows).toEqual([]);
  });

  it('list rows: showInView tabs filtered by `show` (tab.url matches localhost), grouped and sorted', async () => {
    const s = setup();
    const all: Rule = { id: 'all', name: 'All', enabled: true, match: { url: '*' }, actions: [{ showInView: { view: 'local' } }] };
    const view: View = {
      id: 'local', tab: 'Local', kind: 'list', actions: ['focus', 'close'],
      show: { field: 'tab.url', op: 'matches', value: 'localhost' }, groupBy: 'tab.windowId', sort: { field: 'tab.title', dir: 'desc' },
    };
    await s.setCfg({ ...defaultConfig(), recipes: [...defaultConfig().recipes, userRecipe('mine', [all], [view])] });
    s.mk(1, 'http://localhost:8080/a', { title: 'alpha' }); s.mk(2, 'https://example.com/', { title: 'beta' });
    s.mk(4, 'http://localhost:9090/b', { title: 'gamma' });
    const r = (await s.handle({ type: 'view.data', viewId: 'local' }, ui)) as Loose;
    expect(r.data.rows.map((x: { tabId: number; group?: string }) => [x.tabId, x.group])).toEqual([[4, '1'], [1, '1']]);
  });

  it('show reads extract.* (the showInView rule\'s captures and extracts)', async () => {
    const s = setup();
    const rule: Rule = { id: 'r', name: 'R', enabled: true, match: { url: 'github.com/:owner/:repo*' }, actions: [{ showInView: { view: 'gh' } }] };
    const view: View = { id: 'gh', tab: 'GH', kind: 'list', actions: ['focus'], show: { field: 'extract.owner', op: '==', value: 'acme' } };
    await s.setCfg({ ...defaultConfig(), recipes: [userRecipe('mine', [rule], [view])] });
    s.mk(1, 'https://github.com/acme/api'); s.mk(2, 'https://github.com/other/api');
    const r = (await s.handle({ type: 'view.data', viewId: 'gh' }, ui)) as Loose;
    expect(r.data.rows.map((x: { tabId: number }) => x.tabId)).toEqual([1]);
  });

  it("view.data('duplicates') agrees with the engine on per-rule dedupe overrides (T6 minor)", async () => {
    const s = setup();
    const off: Rule = { id: 'off', name: 'No dedupe', enabled: true, match: { url: 'a.example/*' }, actions: [{ dedupe: { mode: 'off' } }] };
    await s.setCfg({ ...defaultConfig(), rules: [off], order: ['user/off'] });
    s.mk(1, 'https://a.example/x'); s.mk(2, 'https://a.example/x'); s.mk(3, 'https://b.example/x'); s.mk(4, 'https://b.example/x');
    const r = (await s.handle({ type: 'view.data', viewId: 'duplicates' }, ui)) as Loose;
    expect(r.data.kind).toBe('duplicates');
    expect(r.data.sets.map((x: { tabs: { id: number }[] }) => x.tabs.map((t) => t.id))).toEqual([[3, 4]]);
    expect(((await s.handle({ type: 'dupes.list' }, ui)) as Loose).data.sets).toHaveLength(1);
    expect(await badgeCount({ ...s.deps, isLocked: () => false })).toBe(1);
  });

  it('read-only: views.list and view.data never act or write', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(1, 'https://a.example/x'); s.mk(2, 'https://a.example/x'); s.mk(3, CB);
    s.port.calls.length = 0;
    await s.handle({ type: 'views.list' }, ui);
    for (const viewId of ['duplicates', 'finished']) await s.handle({ type: 'view.data', viewId }, ui);
    expect(s.port.calls.filter((c) => MUTATING.has(c.method))).toEqual([]);
    expect(s.set).not.toHaveBeenCalled();
    expect(s.whyAdd).not.toHaveBeenCalled();
    expect(s.exempt).not.toHaveBeenCalled();
  });

  it('unknown view, malformed requests, foreign senders, missing deps', async () => {
    const s = setup();
    expect(await s.handle({ type: 'view.data', viewId: 'nope' }, ui)).toEqual({ ok: false, error: 'unknown view' });
    for (const bad of [{ type: 'view.data' }, { type: 'view.data', viewId: 1 }, { type: 'view.close', viewId: 'finished' },
      { type: 'view.keep', tabId: 1 }, { type: 'view.close', viewId: 'x', tabId: '1' }]) {
      expect(await s.handle(bad, ui)).toEqual({ ok: false, error: 'unknown request' });
    }
    expect(await s.handle({ type: 'views.list' }, content)).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.handle({ type: 'view.data', viewId: 'duplicates' }, content)).toEqual({ ok: false, error: 'forbidden' });
    const bare = setup({ views: false });
    expect(await bare.handle({ type: 'views.list' }, ui)).toEqual({ ok: false, error: 'views unavailable' });
    expect(await bare.handle({ type: 'view.data', viewId: 'duplicates' }, ui)).toEqual({ ok: false, error: 'views unavailable' });
  });
});

describe('views.list', () => {
  type Sum = { id: string; tab: string; kind: string; count: number; paused?: string; notice?: string; actions: string[] };
  const list = async (s: ReturnType<typeof setup>) => ((await s.handle({ type: 'views.list' }, ui)) as Loose).data as Sum[];

  it('one entry per declared view, with counts: duplicates = closable extras + pending, finished = rows', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(1, 'https://a.example/x'); s.mk(2, 'https://a.example/x'); s.mk(5, 'https://a.example/x'); s.mk(3, CB);
    const views = await list(s);
    expect(views.map((v) => [v.id, v.tab, v.kind, v.count])).toEqual([['duplicates', 'Duplicates', 'duplicates', 2], ['finished', 'Finished', 'list', 1]]);
    expect(views[1]!.actions).toEqual(['focus', 'close', 'keep']);
  });

  it('R58: the Duplicates view stays while dedupe is active, even with the duplicates recipe disabled', async () => {
    const s = setup();
    const off = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'duplicates' ? { ...r, enabled: false } : r)) };
    await s.setCfg(off);
    expect((await list(s)).map((v) => v.id)).toEqual(['duplicates']);
    await s.setCfg({ ...off, dedupe: { ...off.dedupe, mode: 'off' } });
    expect((await list(s)).map((v) => v.id)).toEqual([]);
  });

  it('R45: a paused recipe fades its view with the reason; a paused feeding rule is a notice', async () => {
    const s = setup({ granted: (x) => x !== MEET });
    const meetOnly: Rule = { id: 'm', name: 'M', enabled: true, match: { url: 'meet.google.com/*' }, actions: [{ showInView: { view: 'calls' } }] };
    await s.setCfg({
      ...enable(defaultConfig(), 'finished'),
      recipes: [...enable(defaultConfig(), 'finished').recipes,
        userRecipe('meet', [meetOnly], [{ id: 'calls', tab: 'Calls', kind: 'list', actions: ['focus'] }], { needs: { hosts: [MEET] } })],
    });
    const views = await list(s);
    const calls = views.find((v) => v.id === 'calls')!;
    expect(calls.paused).toBe('Paused: needs access to meet.google.com');
    const finished = views.find((v) => v.id === 'finished')!;
    expect(finished.paused).toBeUndefined(); // the OAuth and redirect rules still run
    expect(finished.notice).toBe('Paused: needs access to meet.google.com');
  });
});

describe('view actions (user-initiated: they apply under global dry run, R50)', () => {
  it('view.keep dismisses the suggestion through CloseExecutor.exempt (no re-suggest for that URL)', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg({ ...enable(defaultConfig(), 'finished'), dryRun: true });
    s.mk(3, CB);
    expect(await s.handle({ type: 'view.keep', viewId: 'finished', tabId: 3 }, ui)).toEqual({ ok: true, data: null });
    expect(s.exempt).toHaveBeenCalledWith(3, CB);
    expect(await s.handle({ type: 'view.keep', viewId: 'finished', tabId: 99 }, ui)).toEqual({ ok: false, error: 'not in view' });
  });

  it('M3: view.close issued before locks load waits for them, so a tab locked in storage is not closed', async () => {
    let load!: () => void;
    const loaded = new Promise<void>((r) => { load = r; });
    const s = setup({ suggestions: [oauth], beforeClose: () => loaded });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(3, CB);
    const r = s.handle({ type: 'view.close', viewId: 'finished', tabId: 3 }, ui);
    await new Promise((x) => setTimeout(x, 0));
    s.locked.add(3);
    load();
    expect(await r).toEqual({ ok: false, error: 'tab is locked' });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([3]);
  });

  it('view.close closes a row tab and records it (also under dry run); never a locked tab or a tab outside the view', async () => {
    const s = setup({ suggestions: [oauth, { tabId: 4, url: `${CB}2`, ruleKey: 'finished/oauth-callback', reason: 'Close OAuth callback tabs' }] });
    await s.setCfg({ ...enable(defaultConfig(), 'finished'), dryRun: true });
    s.mk(3, CB); s.mk(4, `${CB}2`); s.mk(5, 'https://example.com/');
    s.locked.add(4);
    expect(await s.handle({ type: 'view.close', viewId: 'finished', tabId: 3 }, ui)).toEqual({ ok: true, data: null });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([4, 5]);
    expect(s.added[0]).toMatchObject({ url: CB, reason: 'Close OAuth callback tabs', ruleId: 'finished/oauth-callback' });
    expect(s.whyAdd).toHaveBeenCalledWith(expect.objectContaining({ tabId: 3, action: 'view-close' }));
    expect(await s.handle({ type: 'view.close', viewId: 'finished', tabId: 4 }, ui)).toEqual({ ok: false, error: 'tab is locked' });
    expect(await s.handle({ type: 'view.close', viewId: 'finished', tabId: 5 }, ui)).toEqual({ ok: false, error: 'not in view' });
    s.mk(6, `${CB}6`, { pinned: true });
    expect(await s.handle({ type: 'view.close', viewId: 'finished', tabId: 6 }, ui)).toEqual({ ok: false, error: 'not in view' }); // not suggested
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([4, 5, 6]);
  });

  it('view.close never closes a pinned tab; actions the view does not declare are refused', async () => {
    const s = setup({ suggestions: [{ ...oauth, tabId: 6 }] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(6, CB, { pinned: true });
    expect(await s.handle({ type: 'view.close', viewId: 'finished', tabId: 6 }, ui)).toEqual({ ok: false, error: 'tab is pinned' });
    expect(await s.handle({ type: 'view.keep', viewId: 'duplicates', tabId: 6 }, ui)).toEqual({ ok: false, error: 'action not allowed' });
  });
});

describe('toolbar badge (R20): M1 badgeCount + Finished suggestions, nothing counted twice', () => {
  it('a tab both a duplicate extra and suggested counts in each view once; a suggestion counts once', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(2, CB); s.mk(3, CB); // tab 3: a duplicate extra of tab 2, and a Finished suggestion
    await refreshBadge({ ...s.deps, isLocked: () => false });
    expect(s.port.badge).toBe('2');
    const views = ((await s.handle({ type: 'views.list' }, ui)) as Loose).data as { count: number }[];
    expect(views.reduce((n, v) => n + v.count, 0)).toBe(2); // the popup header total agrees with the badge
  });
});

describe('R59 / R60: Finished shown whenever suggestions exist; the badge counts only shown views', () => {
  const total = async (s: ReturnType<typeof setup>) =>
    (((await s.handle({ type: 'views.list' }, ui)) as Loose).data as { count: number }[]).reduce((n, v) => n + v.count, 0);

  it('R59: finished disabled, a suggestion from a user suggest-mode rule → Finished shows and the badge counts it', async () => {
    const user: CloseSuggestion = { tabId: 3, url: CB, ruleKey: 'user/cb', reason: 'Callback' };
    const s = setup({ suggestions: [user] });
    const rule: Rule = { id: 'cb', name: 'Callback', enabled: true, match: { url: 'localhost:*/*' }, actions: [{ close: { mode: 'suggest' } }] };
    await s.setCfg({ ...defaultConfig(), rules: [rule], order: ['user/cb'] }); // finished is disabled by default
    s.mk(3, CB);
    const views = ((await s.handle({ type: 'views.list' }, ui)) as Loose).data as { id: string; count: number }[];
    expect(views.map((v) => [v.id, v.count])).toEqual([['duplicates', 0], ['finished', 1]]);
    const r = (await s.handle({ type: 'view.data', viewId: 'finished' }, ui)) as Loose;
    expect(r.data.rows).toEqual([expect.objectContaining({ tabId: 3, suggested: true, reason: 'Callback', ruleKey: 'user/cb' })]);
    await refreshBadge({ ...s.deps, getConfig: s.deps.store.get, isLocked: () => false });
    expect(s.port.badge).toBe('1');
    expect(await total(s)).toBe(1);
  });

  it('R59: without suggestions a disabled finished recipe shows no Finished view', async () => {
    const s = setup();
    expect((((await s.handle({ type: 'views.list' }, ui)) as Loose).data as { id: string }[]).map((v) => v.id)).toEqual(['duplicates']);
  });

  it('R60: dedupe off and duplicates disabled → the badge excludes duplicates and matches the popup total', async () => {
    const s = setup({ suggestions: [oauth] });
    const c = enable(defaultConfig(), 'finished');
    await s.setCfg({ ...c, dedupe: { ...c.dedupe, mode: 'off' }, recipes: c.recipes.map((r) => (r.id === 'duplicates' ? { ...r, enabled: false } : r)) });
    s.mk(1, 'https://a.example/x'); s.mk(2, 'https://a.example/x'); s.mk(3, CB);
    await refreshBadge({ ...s.deps, getConfig: s.deps.store.get, isLocked: () => false });
    expect(s.port.badge).toBe('1'); // the Finished suggestion only; the a.example duplicate is not counted
    expect(await total(s)).toBe(1);
    // A handler-triggered refresh (view.keep) uses the same rule.
    s.port.badge = '';
    await s.handle({ type: 'view.keep', viewId: 'finished', tabId: 3 }, ui);
    expect(s.port.badge).toBe('1');
  });

  it('R60: with the Duplicates view shown, the badge is its count plus the list views, equal to the popup total', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(1, 'https://a.example/x'); s.mk(2, 'https://a.example/x'); s.mk(3, CB);
    await refreshBadge({ ...s.deps, getConfig: s.deps.store.get, isLocked: () => false });
    expect(s.port.badge).toBe('2');
    expect(await total(s)).toBe(2);
  });
});

describe('T17 fix round 1', () => {
  it('fix 1: a config change alone (no tab event) refreshes the badge through afterConfigChange; it equals the popup total', async () => {
    const s = setup({ suggestions: [oauth] });
    const c = enable(defaultConfig(), 'finished');
    await s.setCfg(c);
    s.mk(1, 'https://a.example/x'); s.mk(2, 'https://a.example/x'); s.mk(3, CB);
    const badge = () => refreshBadge({ ...s.deps, getConfig: s.deps.store.get, isLocked: () => false });
    await badge();
    expect(s.port.badge).toBe('2');
    await s.setCfg({ ...c, dedupe: { ...c.dedupe, mode: 'off' }, recipes: c.recipes.map((r) => (r.id === 'duplicates' ? { ...r, enabled: false } : r)) });
    let refreshed: Promise<void> | undefined;
    await afterConfigChange(async () => {}, { evaluateAll: async () => {} }, () => { refreshed = badge(); });
    await refreshed;
    expect(s.port.badge).toBe('1');
    const views = ((await s.handle({ type: 'views.list' }, ui)) as Loose).data as { count: number }[];
    expect(views.reduce((n, v) => n + v.count, 0)).toBe(1);
  });

  it('R61: a suggested tab that navigated (before the executor cleared it) is not listed, closed or exempted', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(3, 'https://example.com/new-page'); // the suggestion was made at CB; the tab is elsewhere now
    expect(((await s.handle({ type: 'view.data', viewId: 'finished' }, ui)) as Loose).data.rows).toEqual([]);
    expect(await s.handle({ type: 'view.close', viewId: 'finished', tabId: 3 }, ui)).toEqual({ ok: false, error: 'tab has navigated' });
    expect(await s.handle({ type: 'view.keep', viewId: 'finished', tabId: 3 }, ui)).toEqual({ ok: false, error: 'tab has navigated' });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([3]);
    expect(s.exempt).not.toHaveBeenCalled();
    expect(s.added).toEqual([]);
  });

  it('R61: same page after normalization (tracking params) still matches', async () => {
    const s = setup({ suggestions: [oauth] });
    await s.setCfg(enable(defaultConfig(), 'finished'));
    s.mk(3, `${CB}&utm_source=x`);
    expect(((await s.handle({ type: 'view.data', viewId: 'finished' }, ui)) as Loose).data.rows).toHaveLength(1);
  });

  it('R61: the row URL the popup showed is checked at action time: a showInView row whose tab navigated is refused', async () => {
    const s = setup();
    const all: Rule = { id: 'all', name: 'All', enabled: true, match: { url: '*' }, actions: [{ showInView: { view: 'any' } }] };
    await s.setCfg({ ...defaultConfig(), recipes: [userRecipe('mine', [all], [{ id: 'any', tab: 'Any', kind: 'list', actions: ['close'] }])] });
    s.mk(1, 'https://example.com/new');
    expect(await s.handle({ type: 'view.close', viewId: 'any', tabId: 1, url: 'https://example.com/old' }, ui)).toEqual({ ok: false, error: 'tab has navigated' });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([1]);
    expect(await s.handle({ type: 'view.close', viewId: 'any', tabId: 1, url: 'https://example.com/new' }, ui)).toEqual({ ok: true, data: null });
    expect(await s.handle({ type: 'view.close', viewId: 'any', tabId: 1, url: 7 }, ui)).toEqual({ ok: false, error: 'unknown request' });
  });
});
