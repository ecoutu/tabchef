import { describe, expect, it, vi } from 'vitest';
import {
  effectiveNeeds, matchesPattern, PermissionsManager, pausedReason, type WatchScripting,
} from '../../src/engine/permissions';
import { createWatchScripting, WATCH_SCRIPT_ID, type WatchRegistrationApi } from '../../src/engine/watch-registration';
import { ProgramCache } from '../../src/engine/program-cache';
import { PageFacts } from '../../src/engine/page-facts';
import { Reconciler } from '../../src/engine/reconciler';
import { configRev, createHandler, type HandlerDeps, type RecipeListItem } from '../../src/engine/messages';
import { builtinRecipes } from '../../src/recipes/load';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Program, Recipe, RecipeRef, Rule } from '../../src/core/lang/types';
import type { Config } from '../../src/core/types';

const MEET = 'https://meet.google.com/*';
const ui = { id: 'ext', url: 'chrome-extension://ext/options.html' };

const groupRecipe = (id: string, url: string, title: string, over: Partial<Recipe> = {}): Recipe => ({
  recipe: id, version: 1, name: id, description: id,
  rules: [{ id: 'g', name: 'g', enabled: true, match: { url }, actions: [{ group: { title, color: 'blue' } }] }],
  ...over,
});
const meet = groupRecipe('meet', 'meet.google.com/*', 'Meet', {
  needs: { hosts: [MEET] },
  params: { label: { type: 'string', default: 'x', label: 'Label' }, delay: { type: 'duration', default: '2s', label: 'Delay' } },
});
const gh = groupRecipe('gh', 'github.com/*', 'GitHub');
const ref = (id: string, enabled: boolean): RecipeRef => ({ id, enabled, params: {}, source: 'builtin' });
const BUILTINS = { meet, gh };

function scriptingFake() {
  let registered: string[] = [];
  const s = {
    register: vi.fn(async (o: string[]) => { const prev = registered; registered = [...o]; return prev; }),
    unregister: vi.fn(async () => { const prev = registered; registered = []; return prev; }),
    inject: vi.fn<(ids: number[]) => Promise<void>>(async () => {}),
  } satisfies WatchScripting;
  return { s, registered: () => registered };
}

function setup(recipes: RecipeRef[] = [ref('meet', true), ref('gh', true)], rules: Rule[] = [], builtins: Record<string, Recipe> = BUILTINS) {
  const port = new FakeBrowserPort();
  port.addWindow(1);
  let cfg: Config = { ...defaultConfig(), recipes, rules, order: rules.map((r) => `user/${r.id}`) };
  const store = {
    get: async () => cfg,
    set: vi.fn(async (c: Config) => { cfg = c; }),
    update: vi.fn(async (fn: (c: Config) => Config) => { cfg = fn(cfg); return cfg; }),
    backups: async () => [], restore: async () => {}, status: async () => ({ syncing: true }),
  };
  const scripting = scriptingFake();
  const onPausedChanged = vi.fn();
  // ProgramCache <-> manager: the cache compiles with the manager's paused set; the manager reads needs from it.
  const holder: { pm?: PermissionsManager } = {};
  const programs = new ProgramCache(() => store.get(), { builtins, paused: () => holder.pm?.paused() ?? [], warn: () => {} });
  const getProgram = () => programs.get();
  const pm = new PermissionsManager(port, getProgram, scripting.s, { onPausedChanged });
  holder.pm = pm;
  const deps: HandlerDeps = {
    runtimeId: 'ext', extensionOrigin: 'chrome-extension://ext', store, port,
    getSettings: async () => (await getProgram()).dedupe,
    safety: {
      pause: vi.fn(), resume: vi.fn(), isPaused: () => false, lock: vi.fn(), unlock: vi.fn(), isLocked: () => false,
      lockedTabIds: () => [], undo: vi.fn(async () => {}),
    },
    recentlyClosed: { ready: Promise.resolve(), list: () => [], add: () => 'id' },
    whyLog: { ready: Promise.resolve(), all: () => [], forTab: () => [], add: () => {} },
    ask: { listPending: async () => [], resolvePending: vi.fn(async () => {}) },
    recipes: { builtins, permissions: pm },
  };
  const grant = (...xs: string[]) => { for (const x of xs) port.granted.add(x); };
  const revoke = (...xs: string[]) => { for (const x of xs) port.granted.delete(x); };
  const tab = (id: number, url: string, o = {}) => port.addTab({
    id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...o,
  });
  return { port, pm, scripting, onPausedChanged, handle: createHandler(deps), getCfg: () => cfg, getProgram, grant, revoke, tab };
}

describe('needs helpers', () => {
  it('a host need implies the scripting permission (R5)', () => {
    expect(effectiveNeeds({ origins: [MEET], permissions: [] })).toEqual({ origins: [MEET], permissions: ['scripting'] });
    expect(effectiveNeeds({ origins: [], permissions: ['notifications'] })).toEqual({ origins: [], permissions: ['notifications'] });
    expect(effectiveNeeds({ origins: [MEET], permissions: ['scripting'] }).permissions).toEqual(['scripting']);
  });

  it('pausedReason names the first missing origin by host, else the permission', () => {
    expect(pausedReason({ origins: [MEET], permissions: ['scripting'] })).toBe('Paused: needs access to meet.google.com');
    expect(pausedReason({ origins: [], permissions: ['scripting'] })).toBe('Paused: needs the scripting permission');
  });

  it('matchesPattern follows Chrome match patterns', () => {
    expect(matchesPattern(MEET, 'https://meet.google.com/abc-defg-hij')).toBe(true);
    expect(matchesPattern(MEET, 'http://meet.google.com/x')).toBe(false);
    expect(matchesPattern(MEET, 'https://evil.com/meet.google.com/')).toBe(false);
    expect(matchesPattern('*://*.google.com/*', 'http://meet.google.com/x')).toBe(true);
    expect(matchesPattern('*://*.google.com/*', 'https://google.com/')).toBe(true);
    expect(matchesPattern('https://*/*', 'https://a.example/x?y')).toBe(true);
    expect(matchesPattern('https://*/*', 'chrome://newtab/')).toBe(false);
    expect(matchesPattern('http://localhost/*', 'http://localhost:8080/cb')).toBe(true);
    expect(matchesPattern('https://a.com/pull/*', 'https://a.com/issues/1')).toBe(false);
    expect(matchesPattern('not a pattern', 'https://a.com/')).toBe(false);
    expect(matchesPattern(MEET, 'not a url')).toBe(false);
  });
});

describe('PermissionsManager', () => {
  it('a recipe needing meet.google.com without the grant: not ok, and recipes.enable is rejected', async () => {
    const t = setup([ref('meet', false), ref('gh', true)]);
    const r = await t.handle({ type: 'recipes.enable', id: 'meet' }, ui);
    expect(r).toEqual({ ok: false, error: 'missing permissions' });
    expect(t.getCfg().recipes.find((x) => x.id === 'meet')!.enabled).toBe(false);

    const t2 = setup();
    await t2.pm.onChanged();
    const st = await t2.pm.status();
    expect(st.meet).toEqual({
      ok: false, missing: { origins: [MEET], permissions: ['scripting'] }, reason: 'Paused: needs access to meet.google.com',
    });
    expect(st.gh).toEqual({ ok: true, missing: { origins: [], permissions: [] } });
  });

  it('after onAdded the status is ok and the watch registers for that origin; recipes.enable then succeeds', async () => {
    const t = setup([ref('meet', false), ref('gh', true)]);
    t.grant(MEET, 'scripting');
    const before = configRev(t.getCfg());
    expect(await t.handle({ type: 'recipes.enable', id: 'meet', baseRev: before }, ui)).toEqual({ ok: true, data: null });
    expect(t.getCfg().recipes.find((x) => x.id === 'meet')!.enabled).toBe(true);
    await t.pm.onChanged(); // store.onChange
    expect((await t.pm.status()).meet).toEqual({ ok: true, missing: { origins: [], permissions: [] } });
    expect(t.scripting.s.register).toHaveBeenLastCalledWith([MEET]);
    expect(t.pm.covers('https://meet.google.com/abc')).toBe(true);
    expect(t.pm.covers('https://github.com/x')).toBe(false);
  });

  it('newly covered origins are injected into open, non-discarded, non-frozen tabs', async () => {
    const t = setup();
    t.tab(1, 'https://meet.google.com/a');
    t.tab(2, 'https://meet.google.com/b', { discarded: true });
    t.tab(3, 'https://github.com/x');
    t.tab(4, 'https://meet.google.com/c', { frozen: true });
    t.grant(MEET, 'scripting');
    await t.pm.onChanged();
    expect(t.scripting.s.inject).toHaveBeenCalledWith([1]);
    t.scripting.s.inject.mockClear();
    await t.pm.onChanged(); // unchanged: nothing new to inject
    expect(t.scripting.s.inject).not.toHaveBeenCalled();
  });

  it('enable is rejected for an unknown or broken recipe and on a stale baseRev', async () => {
    const t = setup([ref('meet', false), ref('gh', false)]);
    expect(await t.handle({ type: 'recipes.enable', id: 'nope' }, ui)).toEqual({ ok: false, error: 'unknown recipe' });
    expect(await t.handle({ type: 'recipes.enable', id: 'gh', baseRev: 'stale' }, ui)).toEqual({ ok: false, error: 'conflict' });
    expect(t.getCfg().recipes.find((x) => x.id === 'gh')!.enabled).toBe(false);
    expect(await t.handle({ type: 'recipes.enable', id: 'gh' }, ui)).toEqual({ ok: true, data: null });
    expect(await t.handle({ type: 'recipes.disable', id: 'gh' }, ui)).toEqual({ ok: true, data: null });
    expect(t.getCfg().recipes.find((x) => x.id === 'gh')!.enabled).toBe(false);
  });

  it('Review Focus #2: revoking an origin pauses its recipe, re-registers without it, other recipes keep grouping, nothing throws', async () => {
    const t = setup([ref('meet', true), ref('gh', true), { ...ref('other', true), source: 'user', body: groupRecipe('other', 'other.example/*', 'O', { needs: { hosts: ['https://other.example/*'] } }) }]);
    t.grant(MEET, 'https://other.example/*', 'scripting');
    await t.pm.onChanged();
    expect(t.scripting.registered().sort()).toEqual([MEET, 'https://other.example/*']);
    expect(t.pm.paused().size).toBe(0);
    t.onPausedChanged.mockClear();

    t.revoke(MEET); // permissions.onRemoved
    await expect(t.pm.onChanged()).resolves.toBeUndefined();
    expect([...t.pm.paused()]).toEqual(['meet']);
    expect(t.onPausedChanged).toHaveBeenCalledTimes(1);
    expect(t.scripting.registered()).toEqual(['https://other.example/*']);
    expect(t.pm.covers('https://meet.google.com/x')).toBe(false);
    const p = await t.getProgram();
    expect(p.rules.map((r) => r.key)).toEqual(['gh/g', 'other/g']);
    expect(p.needs.meet).toEqual({ origins: [MEET], permissions: [] }); // needs listed for paused items too
    expect((await t.pm.status()).meet!.reason).toBe('Paused: needs access to meet.google.com');

    t.tab(1, 'https://github.com/a');
    t.tab(2, 'https://github.com/b');
    t.tab(3, 'https://meet.google.com/x');
    await new Reconciler(t.port, t.getProgram).flush();
    const s = await t.port.snapshot();
    const gid = s.tabs.find((x) => x.id === 1)!.groupId;
    expect(gid).toBeGreaterThan(-1);
    expect(s.tabs.find((x) => x.id === 2)!.groupId).toBe(gid);
    expect(s.tabs.find((x) => x.id === 3)!.groupId).toBe(-1);

    // Last origin gone too: the registration is removed as a whole.
    t.revoke('https://other.example/*');
    await t.pm.onChanged();
    expect(t.scripting.s.unregister).toHaveBeenCalled();
    expect(t.scripting.registered()).toEqual([]);
  });

  it('without the scripting API (permission not granted) the sync is a no-op, never a throw', async () => {
    const t = setup();
    const getApi = vi.fn((): WatchRegistrationApi | undefined => undefined);
    const holder: { pm?: PermissionsManager } = {};
    const programs = new ProgramCache(async () => ({ ...defaultConfig(), recipes: [ref('meet', true), ref('gh', true)] }), {
      builtins: BUILTINS, paused: () => holder.pm?.paused() ?? [], warn: () => {},
    });
    t.grant(MEET, 'scripting');
    const pm = new PermissionsManager(t.port, () => programs.get(), createWatchScripting(getApi));
    holder.pm = pm;
    await expect(pm.onChanged()).resolves.toBeUndefined();
    expect(getApi).toHaveBeenCalled();
    expect(pm.covers('https://meet.google.com/x')).toBe(false); // nothing could be registered
  });

  it('a failing registration call is reported, not thrown', async () => {
    const t = setup();
    t.grant(MEET, 'scripting');
    t.scripting.s.register.mockRejectedValueOnce(new Error('Duplicate script ID'));
    const warn = vi.fn();
    const pm = new PermissionsManager(t.port, t.getProgram, t.scripting.s, { warn });
    await expect(pm.onChanged()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('ready resolves after the first sync, with the paused set filled', async () => {
    const t = setup();
    let settled = false;
    void t.pm.ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // no sync yet
    expect(t.pm.paused().size).toBe(0);
    void t.pm.onChanged();
    await t.pm.ready;
    expect([...t.pm.paused()]).toEqual(['meet']);
  });

  it('ready resolves even when the first sync fails or scripting is missing (nothing waits forever)', async () => {
    const t = setup();
    const failing = new PermissionsManager(t.port, async () => { throw new Error('boom'); }, t.scripting.s, { warn: () => {} });
    void failing.onChanged();
    await expect(failing.ready).resolves.toBeUndefined();
    const noScripting = new PermissionsManager(t.port, t.getProgram, createWatchScripting(() => undefined), { warn: () => {} });
    void noScripting.onChanged();
    await expect(noScripting.ready).resolves.toBeUndefined();
  });

  it('an unmet rule-level need pauses only that rule key (R5); the recipe itself stays ok', async () => {
    const port = new FakeBrowserPort();
    const program: Program = {
      rules: [], views: [], tables: {}, dedupe: defaultConfig().dedupe,
      needs: { finished: { origins: [], permissions: [] }, 'finished/meet-ended': { origins: [MEET], permissions: [] } },
    };
    const s = scriptingFake();
    const pm = new PermissionsManager(port, async () => program, s.s);
    await pm.onChanged();
    expect([...pm.paused()]).toEqual(['finished/meet-ended']);
    const st = await pm.status();
    expect(st.finished!.ok).toBe(true);
    expect(st['finished/meet-ended']).toMatchObject({ ok: false, reason: 'Paused: needs access to meet.google.com' });
    expect(s.s.register).not.toHaveBeenCalled();
  });

  it('covers() is optimistic until the first sync (the persisted registration is unknown)', () => {
    const pm = new PermissionsManager(new FakeBrowserPort(), async () => { throw new Error('x'); }, scriptingFake().s);
    expect(pm.covers('https://meet.google.com/x')).toBe(true);
    expect(pm.covers('chrome://newtab/')).toBe(false);
  });

  it('coversKnown() is evidence-only (I1): false while the registration is unknown or after a failed sync', async () => {
    const t = setup();
    t.grant(MEET, 'scripting');
    const fresh = new PermissionsManager(t.port, t.getProgram, t.scripting.s, { warn: () => {} });
    expect(fresh.coversKnown('https://meet.google.com/x')).toBe(false); // before the first sync
    expect(fresh.covers('https://meet.google.com/x')).toBe(true); // the hold stays optimistic
    await fresh.onChanged();
    expect(fresh.coversKnown('https://meet.google.com/x')).toBe(true);
    expect(fresh.coversKnown('https://github.com/x')).toBe(false);
    // A failed register: what is registered is unknown again.
    t.scripting.s.register.mockRejectedValueOnce(new Error('Duplicate script ID'));
    t.grant('https://other.example/*');
    await fresh.onChanged();
    expect(fresh.coversKnown('https://meet.google.com/x')).toBe(false);
    await fresh.onChanged();
    expect(fresh.coversKnown('https://meet.google.com/x')).toBe(true);
    // A failed evaluation: unknown too.
    let fail = false;
    const flaky = new PermissionsManager(t.port, async () => { if (fail) throw new Error('boom'); return t.getProgram(); }, t.scripting.s, { warn: () => {} });
    await flaky.onChanged();
    expect(flaky.coversKnown('https://meet.google.com/x')).toBe(true);
    fail = true;
    await flaky.onChanged();
    expect(flaky.coversKnown('https://meet.google.com/x')).toBe(false);
  });

  it('recipes.list returns refs with their needs and status', async () => {
    const t = setup([ref('meet', false), ref('gh', true)]);
    const r = await t.handle({ type: 'recipes.list' }, ui) as { ok: true; data: { rev: string; recipes: { id: string; enabled: boolean; name: string; needs: unknown; status: unknown }[] } };
    expect(r.ok).toBe(true);
    expect(r.data.rev).toBe(configRev(t.getCfg()));
    expect(r.data.recipes.map((x) => [x.id, x.enabled, x.name])).toEqual([['meet', false, 'meet'], ['gh', true, 'gh']]);
    expect(r.data.recipes[0]!.needs).toEqual({ origins: [MEET], permissions: ['scripting'] });
    expect(r.data.recipes[0]!.status).toMatchObject({ ok: false, missing: { origins: [MEET], permissions: ['scripting'] } });
  });

  it('Finished enables with Meet denied (R5); recipes.list carries the meet rule\'s paused status (R45)', async () => {
    const t = setup([ref('finished', false)], [], builtinRecipes());
    const before = (await t.handle({ type: 'recipes.list' }, ui) as { ok: true; data: { recipes: RecipeListItem[] } }).data.recipes[0]!;
    expect(before.needs).toEqual({ origins: [], permissions: [] });
    expect(before.status.ok).toBe(true);
    expect(before.rules).toEqual({
      'finished/meet-ended': {
        needs: { origins: [MEET], permissions: ['scripting'] },
        status: { ok: false, missing: { origins: [MEET], permissions: ['scripting'] }, reason: 'Paused: needs access to meet.google.com' },
      },
    });
    expect(await t.handle({ type: 'recipes.enable', id: 'finished' }, ui)).toEqual({ ok: true, data: null });
    await t.pm.onChanged();
    expect([...t.pm.paused()]).toEqual(['finished/meet-ended']);
    const keys = (await t.getProgram()).rules.map((r) => r.key);
    expect(keys).toEqual(['finished/oauth-callback', 'finished/redirect']);
  });

  it('recipes.enable with params (R5 flow, T15) validates them and stores them with enabled in one update', async () => {
    const t = setup([ref('finished', false)], [], builtinRecipes());
    expect(await t.handle({ type: 'recipes.enable', id: 'finished', params: { delay: 5 } }, ui))
      .toEqual({ ok: false, error: 'invalid params', errors: ['param delay: must be a duration like 500ms, 30s, 15m, 2h or 1d'] });
    expect(t.getCfg().recipes[0]!.enabled).toBe(false);
    const params = { delay: '9s', mode: 'suggest' };
    expect(await t.handle({ type: 'recipes.enable', id: 'finished', params, baseRev: configRev(t.getCfg()) }, ui)).toEqual({ ok: true, data: null });
    expect(t.getCfg().recipes[0]).toMatchObject({ enabled: true, params });
  });

  it('recipes.setParams validates against ParamDef and names the param', async () => {
    const t = setup();
    expect(await t.handle({ type: 'recipes.setParams', id: 'meet', params: { delay: 5 } }, ui))
      .toEqual({ ok: false, error: 'invalid params', errors: ['param delay: must be a duration like 500ms, 30s, 15m, 2h or 1d'] });
    expect(await t.handle({ type: 'recipes.setParams', id: 'meet', params: { bogus: 1 } }, ui))
      .toEqual({ ok: false, error: 'invalid params', errors: ['unknown param: bogus'] });
    expect(await t.handle({ type: 'recipes.setParams', id: 'meet', params: { delay: '5s' } }, ui)).toEqual({ ok: true, data: null });
    expect(t.getCfg().recipes.find((x) => x.id === 'meet')!.params).toEqual({ delay: '5s' });
  });
});

describe('R44: user rules using page facts widen the watch to every granted host', () => {
  const GH = 'https://github.com/*';
  const userRule = (id: string, over: Partial<Rule>): Rule => ({
    id, name: id, enabled: true, match: { url: 'github.com/*' }, actions: [{ group: { title: 'G', color: 'red' } }], ...over,
  });
  const pageTextRule = userRule('pt', { match: { all: [{ url: 'github.com/*' }, { pageText: 'Merged' }] } });
  const selectorRule = userRule('sel', { extract: { branch: { selector: '.head-ref' } }, actions: [{ group: { title: '{branch}', color: 'red' } }] });

  it('a user pageText rule plus a granted host: the registration includes that host, and covers() follows', async () => {
    const t = setup([ref('meet', true)], [pageTextRule]);
    t.grant(MEET, GH, 'scripting');
    await t.pm.onChanged();
    expect(t.scripting.registered()).toEqual([GH, MEET]);
    expect(t.pm.covers('https://github.com/a/b/pull/1')).toBe(true);
    // ... so the 5 s page-facts hold is armed there again (Task 7 behavior restored).
    const pf = new PageFacts({ session: { get: async () => undefined, set: async () => {} }, now: () => 0, covers: (u) => t.pm.covers(u) });
    pf.onCommitted(1, 'https://github.com/a/b/pull/1');
    expect(pf.awaiting(1)).toBe(true);
  });

  it('without such a rule the granted host is excluded, and covers() is false there', async () => {
    const t = setup([ref('meet', true)], [userRule('plain', {})]);
    t.grant(MEET, GH, 'scripting');
    await t.pm.onChanged();
    expect(t.scripting.registered()).toEqual([MEET]);
    expect(t.pm.covers('https://github.com/a/b/pull/1')).toBe(false);
    const pf = new PageFacts({ session: { get: async () => undefined, set: async () => {} }, now: () => 0, covers: (u) => t.pm.covers(u) });
    pf.onCommitted(1, 'https://github.com/a/b/pull/1');
    expect(pf.awaiting(1)).toBe(false);
  });

  it('a selector-extract user rule also triggers the union', async () => {
    const t = setup([ref('meet', false)], [selectorRule]);
    t.grant(GH, 'scripting');
    await t.pm.onChanged();
    expect(t.scripting.registered()).toEqual([GH]);
    expect(t.pm.covers('https://github.com/x')).toBe(true);
  });

  it('a disabled page-facts user rule does not widen the watch', async () => {
    const t = setup([ref('meet', false)], [{ ...pageTextRule, enabled: false }]);
    t.grant(GH, 'scripting');
    await t.pm.onChanged();
    expect(t.scripting.registered()).toEqual([]);
  });

  it('the union needs scripting: without it nothing is registered', async () => {
    const t = setup([ref('meet', false)], [pageTextRule]);
    t.grant(GH);
    await t.pm.onChanged();
    expect(t.scripting.registered()).toEqual([]);
    expect(t.pm.covers('https://github.com/x')).toBe(false);
  });
});

describe('createWatchScripting', () => {
  it('replaces the tabchef-watch registration as a whole and injects via executeScript', async () => {
    let scripts: { id: string; matches?: string[] }[] = [];
    const api: WatchRegistrationApi = {
      getRegistered: async () => scripts,
      register: vi.fn(async (s) => { scripts = [...s]; }),
      update: vi.fn(async (s) => { scripts = [...s]; }),
      unregister: vi.fn(async () => { scripts = []; }),
      inject: vi.fn(async () => {}),
    };
    const w = createWatchScripting(() => api);
    await w.register([MEET]);
    await w.register([MEET, 'https://a.com/*']);
    expect(scripts).toMatchObject([{ id: WATCH_SCRIPT_ID, matches: [MEET, 'https://a.com/*'] }]);
    await w.inject!([1, 2]);
    expect(api.inject).toHaveBeenCalledTimes(2);
    await w.unregister();
    expect(scripts).toEqual([]);
  });
});
