// Merged PRs (M3 T13): the first built-in recipe on connections. The pr-state rule reads each open PR tab's state
// (GitHub API, else the PR page), the Merged view lists merged PRs, and the opt-in auto-close-merged rule closes them.
import { describe, expect, it, vi } from 'vitest';
import { compileProgram } from '../../src/core/lang/compile';
import { evaluateTab } from '../../src/core/lang/evaluate';
import { defaultConfig } from '../../src/core/config/defaults';
import { createHandler, refreshBadge, type HandlerDeps } from '../../src/engine/messages';
import { PermissionsManager, pausedReason, type NeedStatus } from '../../src/engine/permissions';
import { ProgramCache } from '../../src/engine/program-cache';
import { refreshPeriodMinutes, SourceService } from '../../src/engine/sources';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import { checkFile } from '../../scripts/validate-recipes';
import type { Config, RecipeRef, TabSnap } from '../../src/core/types';
import type { NeedsEntry, Recipe, TabFacts } from '../../src/core/lang/types';
import type { ApiRequest, ConnectionState } from '../../src/core/connections/types';

type Loose = { ok: boolean; error?: string; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const ui = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
const GH = 'https://github.com/*';
const NOW = Date.parse('2026-11-02T10:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PR_STATE = 'merged-prs/pr-state';
const AUTO = 'merged-prs/auto-close-merged';
const prUrl = (n: number) => `https://github.com/acme/api/pull/${n}`;

const body = () => builtinRecipes()['merged-prs'] as Recipe;
const withMerged = (over: Partial<RecipeRef> = {}, base: Config = defaultConfig()): Config => ({
  ...base, recipes: base.recipes.map((r) => (r.id === 'merged-prs' ? { ...r, enabled: true, ...over } : r)),
});
const tab = (id: number, url: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id, windowId: 1, index: id, url, title: `t${id}`, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});
type Entry = { data?: Record<string, unknown>; stale?: boolean };

describe('merged-prs recipe: shape', () => {
  it('ships the plan params (refreshEvery min 1m) with help text', () => {
    const p = body().params!;
    expect(p.includeClosed).toEqual(expect.objectContaining({ type: 'boolean', default: false }));
    expect(p.autoCloseAfter).toEqual(expect.objectContaining({ type: 'duration', default: '24h' }));
    expect(p.refreshEvery).toEqual(expect.objectContaining({ type: 'duration', default: '5m', min: '1m' }));
    for (const d of Object.values(p)) expect(d.help).toEqual(expect.any(String));
  });

  it('pr-state: the plan match, needs, source, trigger and showInView', () => {
    const r = body().rules.find((x) => x.id === 'pr-state')!;
    expect(r.enabled).toBe(true);
    expect(r.match).toEqual({ url: 'github.com/:owner/:repo/pull/:num*' });
    expect(r.needs).toEqual({ anyOf: [{ connections: ['github'] }, { hosts: [GH] }] });
    expect(r.source).toEqual({
      connection: 'github', query: 'github.pull_request', args: { owner: '{owner}', repo: '{repo}', number: '{num}' },
      fields: { state: 'state', mergedAt: 'mergedAt' }, fallback: { adapter: 'github.prPage' },
    });
    expect(r.trigger).toEqual({ on: ['created', 'committed', 'sourceUpdated'] });
    expect(r.actions).toEqual([{ showInView: { view: 'merged' } }]);
  });

  it('auto-close-merged: off by default; M3-R77 copies pr-state\'s source and trigger (rule-scoped source.*)', () => {
    const [pr, auto] = ['pr-state', 'auto-close-merged'].map((id) => body().rules.find((x) => x.id === id)!);
    expect(auto!.enabled).toBe(false);
    // M3-R94: the PR page never yields mergedAt, so the close needs the connection; no page alternative.
    expect(auto!.needs).toEqual({ anyOf: [{ connections: ['github'] }] });
    expect(auto!.source).toEqual(pr!.source);
    expect(auto!.trigger).toEqual(pr!.trigger);
    expect(auto!.match).toEqual({ all: [
      { url: 'github.com/:owner/:repo/pull/:num*' },
      { field: { field: 'source.state', op: '==', value: 'merged' } },
      { field: { field: 'source.mergedAt', op: '<', value: { ago: '{params.autoCloseAfter}' } } },
    ] });
    expect(auto!.actions).toEqual([{ close: { mode: 'auto' } }]);
  });

  it('the Merged view', () => {
    expect(body().views).toEqual([{
      id: 'merged', tab: 'Merged', kind: 'list', rules: ['pr-state'],
      show: { any: [
        { field: 'source.state', op: '==', value: 'merged' },
        { all: [{ field: 'params.includeClosed', op: '==', value: true }, { field: 'source.state', op: '==', value: 'closed' }] },
      ] },
      sort: { field: 'source.mergedAt', dir: 'desc' },
      actions: ['focus', 'close', 'close-all'],
    }]);
  });

  it('M3-R94: autoCloseAfter\'s help says the GitHub connection is required', () => {
    expect(body().params!.autoCloseAfter!.help).toContain('Needs the GitHub connection');
  });

  it('M3-R94: without the connection, github.com granted, auto-close-merged is "Paused: needs the GitHub connection"; pr-state reads the page', async () => {
    const port = new FakeBrowserPort();
    port.granted.add(GH).add('scripting');
    const cfg = withMerged({ ruleEnabled: { 'auto-close-merged': true } });
    const holder: { pm?: PermissionsManager } = {};
    const programs = new ProgramCache(async () => cfg, { builtins: builtinRecipes(), paused: () => holder.pm?.paused() ?? [], warn: () => {} });
    let conn: ConnectionState = 'not-configured';
    const pm = new PermissionsManager(port, () => programs.get(), { register: async () => [], unregister: async () => [], inject: async () => {} }, {
      connections: async () => [{ id: 'github', label: 'GitHub', state: conn }],
    });
    holder.pm = pm;
    await pm.onChanged();
    expect((await pm.status())['merged-prs']!.rules![AUTO]).toEqual({ level: -1, paused: 'Paused: needs the GitHub connection' });
    expect(await pm.levelFor(PR_STATE)).toBe('page');
    expect(await pm.levelFor(AUTO)).toBeUndefined();
    conn = 'ok';
    await pm.onChanged();
    expect(await pm.levelFor(AUTO)).toBe('connection');
  });

  it('validates (npm run validate:recipes) and is disabled by default', () => {
    expect(checkFile('src/recipes/builtin/merged-prs.yaml')).toEqual([]);
    expect(defaultConfig().recipes.find((r) => r.id === 'merged-prs')?.enabled).toBe(false);
  });

  it('a refreshEvery below 1m is a param error', () => {
    const { errors } = compileProgram(withMerged({ params: { refreshEvery: '30s' } }), builtinRecipes());
    expect(errors).toEqual([{ key: 'merged-prs', error: 'param refreshEvery: must be at least 1m' }]);
  });
});

describe('merged-prs: auto-close-merged', () => {
  const evalAuto = (entry: Entry | undefined, on = true) => {
    const { program, errors } = compileProgram(withMerged(on ? { ruleEnabled: { 'auto-close-merged': true } } : {}), builtinRecipes());
    expect(errors).toEqual([]);
    const f: TabFacts = { tab: tab(1, prUrl(1)), ...(entry && { source: { [AUTO]: entry, [PR_STATE]: entry } }) };
    return evaluateTab(program, f, NOW);
  };
  it('merged 25h ago → close (auto); merged 1h ago → no close', () => {
    expect(evalAuto({ data: { state: 'merged', mergedAt: iso(NOW - 25 * H) } }).close).toEqual(expect.objectContaining({ key: AUTO, mode: 'auto' }));
    expect(evalAuto({ data: { state: 'merged', mergedAt: iso(NOW - 1 * H) } }).close).toBeUndefined();
  });
  it('unknown (no state: pickFields drops it, M3-R45) or no data → no close; disabled by default → no close', () => {
    expect(evalAuto({ data: {} }).close).toBeUndefined();
    expect(evalAuto(undefined).close).toBeUndefined();
    expect(evalAuto({ data: { state: 'merged', mergedAt: iso(NOW - 25 * H) } }, false).close).toBeUndefined();
  });
});

/** A popup handler over a fake port with the merged-prs recipe enabled; per-tab source entries for pr-state. */
function setup(o: { params?: Record<string, unknown>; source?: Record<number, Entry>; granted?: boolean; formEditedIds?: number[] } = {}) {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  const mk = (id: number, n: number, x: Partial<TabSnap> = {}) => port.addTab({
    id, windowId: 1, url: prUrl(n), title: `PR ${n}`, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...x,
  });
  const cfg = withMerged({ params: o.params ?? {} });
  const added: { reason: string; url: string }[] = [];
  const locked = new Set<number>();
  const getProgram = async () => compileProgram(cfg, builtinRecipes()).program;
  const check = async (n: NeedsEntry): Promise<NeedStatus> => {
    if (o.granted !== false || !n.anyOf?.length) return { ok: true, missing: { origins: [], permissions: [] } };
    const missing = { origins: n.anyOf.flatMap((a) => a.origins), permissions: [] };
    return { ok: false, missing, reason: pausedReason(missing) };
  };
  const facts = (id: number): Partial<TabFacts> => (o.source?.[id] ? { source: { [PR_STATE]: o.source[id]! } } : {});
  const deps: HandlerDeps = {
    runtimeId: 'ext', extensionOrigin: 'chrome-extension://ext',
    store: {
      get: async () => cfg, set: vi.fn(), backups: async () => [], restore: vi.fn(), update: vi.fn(), status: async () => ({ syncing: true }),
    },
    port, getProgram,
    getSettings: async () => (await getProgram()).dedupe,
    safety: {
      pause: vi.fn(), resume: vi.fn(), isPaused: () => false, lock: (id) => { locked.add(id); }, unlock: vi.fn(),
      isLocked: (id) => locked.has(id), lockedTabIds: () => [...locked], undo: vi.fn(async () => {}),
    },
    isFormEdited: (id) => (o.formEditedIds ?? []).includes(id),
    recentlyClosed: { ready: Promise.resolve(), list: () => [], add: (e) => { added.push(e); return 'id'; } },
    whyLog: { ready: Promise.resolve(), all: () => [], forTab: () => [], add: vi.fn() },
    ask: { listPending: async () => [], resolvePending: vi.fn(async () => {}) },
    now: () => NOW,
    views: {
      builtins: builtinRecipes(), getProgram, facts, permissions: { check },
      connections: async () => [{ id: 'github', label: 'GitHub' }],
    },
  };
  return { port, mk, deps, handle: createHandler(deps), added, locked };
}

const rowsOf = async (s: ReturnType<typeof setup>) =>
  ((await s.handle({ type: 'view.data', viewId: 'merged' }, ui)) as Loose).data.rows as { tabId: number; source?: Record<string, unknown>; stale?: true }[];

describe('merged-prs: the Merged view', () => {
  const four: Record<number, Entry> = {
    1: { data: { state: 'merged', mergedAt: iso(NOW - 2 * H) } },
    2: { data: { state: 'open' } },
    3: { data: {}, stale: true }, // a 'none' entry: state 'unknown' is never a field value (M3-R45)
    4: { data: { state: 'closed' } },
  };
  it('lists only the merged PR; with includeClosed merged + closed (mergedAt desc, missing last)', async () => {
    const s = setup({ source: four });
    for (const id of [1, 2, 3, 4]) s.mk(id, id);
    expect((await rowsOf(s)).map((r) => r.tabId)).toEqual([1]);
    const c = setup({ source: four, params: { includeClosed: true } });
    for (const id of [4, 3, 2, 1]) c.mk(id, id);
    expect((await rowsOf(c)).map((r) => r.tabId)).toEqual([1, 4]);
  });

  it('rows carry the source data (state pill); sorted by mergedAt desc', async () => {
    const s = setup({ source: { 1: { data: { state: 'merged', mergedAt: iso(NOW - 5 * H) } }, 2: { data: { state: 'merged', mergedAt: iso(NOW - H) } } } });
    s.mk(1, 1); s.mk(2, 2);
    const rows = await rowsOf(s);
    expect(rows.map((r) => r.tabId)).toEqual([2, 1]);
    expect(rows[0]!.source).toEqual({ state: 'merged', mergedAt: iso(NOW - H) });
    expect(rows[0]!.stale).toBeUndefined();
  });

  it('Review Focus #1/#4: unknown and stale-without-data rows are never listed; a stale merged row is, marked stale', async () => {
    const s = setup({ source: { 1: { stale: true }, 2: { data: {}, stale: true }, 3: { data: { state: 'merged' }, stale: true } } });
    s.mk(1, 1); s.mk(2, 2); s.mk(3, 3); s.mk(5, 5); // tab 5: no entry at all
    const rows = await rowsOf(s);
    expect(rows.map((r) => [r.tabId, r.stale])).toEqual([[3, true]]);
  });

  it('close-all with one locked merged tab closes the others, reports 1 skipped, records each with reason merged-pr', async () => {
    const merged = { data: { state: 'merged', mergedAt: iso(NOW - H) } };
    const s = setup({ source: { 1: merged, 2: merged, 3: merged } });
    s.mk(1, 1); s.mk(2, 2); s.mk(3, 3);
    s.locked.add(2);
    const rows = await rowsOf(s);
    const r = (await s.handle({ type: 'view.close', viewId: 'merged', tabs: rows.map((x) => ({ tabId: x.tabId, url: prUrl(x.tabId) })) }, ui)) as Loose;
    expect(r).toEqual({ ok: true, data: { closed: 2, skipped: 1 } });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([2]);
    expect(s.added.map((e) => [e.url, e.reason])).toEqual([[prUrl(1), 'merged-pr'], [prUrl(3), 'merged-pr']]);
  });

  it('M3-R78: close-all skips pinned, locked and form-edited tabs ("N skipped"), not audible ones; a single Close of a form-edited tab is refused', async () => {
    const merged = { data: { state: 'merged' } };
    const s = setup({ source: { 1: merged, 2: merged, 3: merged, 4: merged }, formEditedIds: [1] });
    s.mk(1, 1); s.mk(2, 2, { pinned: true }); s.mk(3, 3); s.mk(4, 4, { audible: true });
    s.locked.add(3);
    expect(await s.handle({ type: 'view.close', viewId: 'merged', tabId: 1, url: prUrl(1) }, ui)).toEqual({ ok: false, error: 'tab has unsaved form edits' });
    const r = (await s.handle({ type: 'view.close', viewId: 'merged', tabs: [1, 2, 3, 4].map((tabId) => ({ tabId })) }, ui)) as Loose;
    expect(r.data).toEqual({ closed: 1, skipped: 3 });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('M3-R78: a throwing closeTab in close-all is skipped and logged', async () => {
    const merged = { data: { state: 'merged' } };
    const s = setup({ source: { 1: merged, 2: merged } });
    s.mk(1, 1); s.mk(2, 2);
    const close = s.port.closeTab.bind(s.port);
    s.port.closeTab = async (id: number) => { if (id === 1) throw new Error('No tab with id: 1'); return close(id); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = (await s.handle({ type: 'view.close', viewId: 'merged', tabs: [{ tabId: 1 }, { tabId: 2 }] }, ui)) as Loose;
    expect(r.data).toEqual({ closed: 1, skipped: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('close-all'), expect.any(Error));
    warn.mockRestore();
  });

  it('the badge includes the merged count', async () => {
    const merged = { data: { state: 'merged' } };
    const s = setup({ source: { 1: merged, 2: merged, 3: { data: { state: 'open' } } } });
    s.mk(1, 1); s.mk(2, 2); s.mk(3, 3);
    await refreshBadge({ ...s.deps, isLocked: () => false, getConfig: () => s.deps.store.get() });
    expect(s.port.badge).toBe('2');
  });

  it('locked: pr-state paused (no connection, no host) → summary.locked with the connection and the hosts', async () => {
    const s = setup({ granted: false });
    s.mk(1, 1);
    const list = ((await s.handle({ type: 'views.list' }, ui)) as Loose).data as { id: string; locked?: unknown; paused?: string }[];
    const v = list.find((x) => x.id === 'merged')!;
    expect(v.paused).toBe(pausedReason({ origins: [GH], permissions: [] }));
    expect(v.locked).toEqual({ text: 'Needs GitHub access', connections: [{ id: 'github', label: 'GitHub' }], hosts: ['github.com'], origins: [GH], permissions: [] });
  });
});

describe('merged-prs: sources', () => {
  it('pr-state and auto-close-merged share one cache entry: the PR is fetched once, both rule keys see it', async () => {
    const program = compileProgram(withMerged({ ruleEnabled: { 'auto-close-merged': true } }), builtinRecipes()).program;
    const snap = { tabs: [tab(1, prUrl(7))], groups: [], windows: [{ id: 1, type: 'normal' as const, focused: true }] };
    const fetch = vi.fn(async (_id: string, req: ApiRequest) => {
      const prs = [...(req.json as { query: string }).query.matchAll(/(p\d+): pullRequest/g)].map((m) => m[1]!);
      const repo = /(r\d+): repository/.exec((req.json as { query: string }).query)![1]!;
      const pr = { state: 'MERGED', merged: true, mergedAt: '2026-10-01T00:00:00Z', isDraft: false, url: prUrl(7) };
      return { ok: true as const, status: 200, data: { data: { [repo]: Object.fromEntries(prs.map((p) => [p, pr])) } } };
    });
    const data: Record<string, unknown> = {};
    const svc = new SourceService({
      conn: { fetch, status: async () => [{ id: 'github', state: 'ok' as const, ssoRequired: [], scopes: [] }], defs: async () => [] },
      getProgram: () => program,
      levelFor: async () => 'connection',
      port: { snapshot: async () => structuredClone(snap), hasPermission: async () => false },
      facts: { get: () => undefined },
      local: { get: async () => ({}), set: async (x: Record<string, unknown>) => { Object.assign(data, x); } },
      now: () => NOW,
      onUpdated: () => {},
    });
    await svc.refresh('manual');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...(fetch.mock.calls[0]![1].json as { query: string }).query.matchAll(/pullRequest\(/g)]).toHaveLength(1);
    const f = svc.factsFor(1)!;
    expect(f[PR_STATE]?.data).toEqual({ state: 'merged', mergedAt: '2026-10-01T00:00:00Z' });
    expect(f[AUTO]?.data).toEqual(f[PR_STATE]?.data);
  });

  it('M3-R75: refreshPeriodMinutes is the smallest refreshEvery among enabled recipes (default 5)', () => {
    expect(refreshPeriodMinutes(compileProgram(defaultConfig(), builtinRecipes()).program)).toBe(5);
    expect(refreshPeriodMinutes(compileProgram(withMerged(), builtinRecipes()).program)).toBe(5);
    expect(refreshPeriodMinutes(compileProgram(withMerged({ params: { refreshEvery: '2m' } }), builtinRecipes()).program)).toBe(2);
    expect(refreshPeriodMinutes(compileProgram(withMerged({ params: { refreshEvery: '90s' } }), builtinRecipes()).program)).toBe(1.5);
    // a second recipe with a larger period does not raise it
    const other: RecipeRef = {
      id: 'other', enabled: true, params: {}, source: 'user',
      body: { recipe: 'other', version: 1, name: 'O', description: 'O', params: { refreshEvery: { type: 'duration', default: '10m', label: 'R' } }, rules: [] },
    };
    const c = withMerged({ params: { refreshEvery: '3m' } });
    expect(refreshPeriodMinutes(compileProgram({ ...c, recipes: [...c.recipes, other] }, builtinRecipes()).program)).toBe(3);
    // M3-R78: a param named refreshEvery that is not a duration param does not count
    const str: RecipeRef = {
      id: 'str', enabled: true, params: {}, source: 'user',
      body: { recipe: 'str', version: 1, name: 'S', description: 'S', params: { refreshEvery: { type: 'string', default: '1m', label: 'R' } }, rules: [] },
    };
    expect(refreshPeriodMinutes(compileProgram({ ...defaultConfig(), recipes: [...defaultConfig().recipes, str] }, builtinRecipes()).program)).toBe(5);
  });
});
