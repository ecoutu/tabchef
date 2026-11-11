// SourceService (M3 T11): a fake ConnectionManager (GraphQL / Jira responses from tables) and a fake clock.
import { describe, expect, it, vi } from 'vitest';
import { CACHE_MAX, freshnessMs, POPUP_THROTTLE_MS, SOURCE_CACHE_KEY, SourceService, type SourceServiceDeps } from '../../src/engine/sources';
import type { ApiRequest, ApiResult, ConnectionDef, ConnectionState } from '../../src/core/connections/types';
import type { CompiledRule, Program, Rule, SourceSpec, TabFacts } from '../../src/core/lang/types';
import type { Snapshot, TabSnap } from '../../src/core/types';
import type { NeedsKind } from '../../src/core/lang/needs';

const MIN = 60_000;
const GITHUB: ConnectionDef = {
  id: 'github', kind: 'github', label: 'GitHub', baseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com',
  hosts: ['https://github.com/*', 'https://api.github.com/*'], auth: 'token', scopes: [],
};
const JIRA: ConnectionDef = {
  id: 'jira', kind: 'jira', label: 'Jira', baseUrl: 'https://acme.atlassian.net', apiBaseUrl: 'https://acme.atlassian.net',
  hosts: ['https://acme.atlassian.net/*'], auth: 'token', scopes: [], jira: { site: 'acme.atlassian.net', tokenKind: 'classic' },
};

const prSource: SourceSpec = {
  connection: 'github', query: 'github.pull_request', args: { owner: '{owner}', repo: '{repo}', number: '{num}' },
  fields: { state: 'state', mergedAt: 'mergedAt' }, fallback: { adapter: 'github.prPage' },
};
const prRule: Rule = {
  id: 'pr', name: 'PR', enabled: true, source: prSource,
  // A field condition: requestsFor treats it as true to get the captures.
  match: { all: [{ url: 'github.com/:owner/:repo/pull/:num' }, { not: { field: { field: 'source.state', op: '==', value: 'merged' } } }] },
  actions: [{ group: { title: 'PRs', color: 'blue' } }],
};
const issueRule: Rule = {
  id: 'issue', name: 'Issue', enabled: true,
  source: { connection: 'jira', query: 'jira.issue', args: { key: '{key}' }, fields: { status: 'status', cat: 'statusCategory' }, fallback: { adapter: 'jira.issuePage' } },
  match: { url: '*.atlassian.net/browse/:key' }, actions: [{ group: { title: 'Issues', color: 'red' } }],
};
const program = (...rules: Rule[]): Program => ({
  rules: rules.map((rule, index): CompiledRule => ({ key: `rec/${rule.id}`, rule, recipeId: 'rec', index, dryRun: false })),
  views: [], tables: {}, dedupe: { mode: 'exact', followFragment: false, keepFragment: false, matchTitle: false } as unknown as Program['dedupe'], needs: {},
});

const tab = (id: number, url: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id, windowId: 1, index: id, url, title: `t${id}`, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});
const prTab = (id: number, n = id, o: Partial<TabSnap> = {}, repo = 'acme/api') => tab(id, `https://github.com/${repo}/pull/${n}`, o);

/** storage.local stand-in (KeyValueArea). */
function memLocal() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in data).map((x) => [x, structuredClone(data[x])]))),
    set: vi.fn(async (o: Record<string, unknown>) => { Object.assign(data, structuredClone(o)); }),
    remove: vi.fn(async () => {}),
  };
}

/** A GraphQL PR-state response for the query's aliases, states from `states` ('owner/repo#n' → GitHub state). */
function prResponse(req: ApiRequest, states: Map<string, string>): ApiResult {
  const { query, variables } = req.json as { query: string; variables: Record<string, unknown> };
  const data: Record<string, Record<string, unknown>> = {};
  let repo = '';
  for (const m of query.matchAll(/(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\)|(p\d+): pullRequest\(number: \$(k\d+)\)/g)) {
    if (m[1]) {
      repo = m[1];
      data[repo] = { _key: `${String(variables[m[2]!])}/${String(variables[m[3]!])}` };
    } else {
      const key = `${String(data[repo]!._key)}#${String(variables[m[5]!])}`;
      const state = states.get(key) ?? 'OPEN';
      data[repo]![m[4]!] = { state, merged: state === 'MERGED', mergedAt: state === 'MERGED' ? '2026-10-01T00:00:00Z' : null, isDraft: false, url: `https://github.com/${key.replace('#', '/pull/')}` };
    }
  }
  for (const r of Object.values(data)) delete r._key;
  return { ok: true, status: 200, data: { data } };
}
const prsIn = (req: ApiRequest) => [...(req.json as { query: string }).query.matchAll(/pullRequest\(/g)].length;

interface Setup {
  tabs?: TabSnap[]; rules?: Rule[]; states?: Map<string, string>; conn?: Record<string, ConnectionState>;
  facts?: Record<number, NonNullable<TabFacts['page']>>; granted?: boolean; canSend?: boolean; local?: ReturnType<typeof memLocal>;
  fetch?: (id: string, req: ApiRequest) => Promise<ApiResult>;
  /** Per rule key, the kind of alternative it runs at (PermissionsManager.levelFor); default: every rule at its connection. */
  levels?: Record<string, NeedsKind | undefined>;
  /** Program.refreshEvery (the recipes' "check every" settings), by recipe id; none: the default period. */
  refreshEvery?: Record<string, string>;
}
function setup(o: Setup = {}) {
  let now = Date.parse('2026-11-02T10:00:00Z');
  const snap: Snapshot = { tabs: o.tabs ?? [], groups: [], windows: [{ id: 1, type: 'normal', focused: true }] };
  const states = o.states ?? new Map<string, string>();
  const conn = { github: 'ok', jira: 'ok', ...o.conn } as Record<string, ConnectionState>;
  const fetch = vi.fn(o.fetch ?? (async (_id: string, req: ApiRequest) => prResponse(req, states)));
  const local = o.local ?? memLocal();
  const canSend = vi.fn(async () => ({ ok: o.canSend ?? true }));
  const facts = { get: vi.fn((id: number) => o.facts?.[id]) };
  const onUpdated = vi.fn();
  const deps: SourceServiceDeps = {
    conn: {
      fetch,
      status: vi.fn(async (id?: string) => Object.entries(conn).filter(([k]) => id === undefined || k === id).map(([k, state]) => ({ id: k, state, ssoRequired: [], scopes: [] }))),
      defs: vi.fn(async () => [GITHUB, JIRA]),
    },
    limiter: { canSend },
    getProgram: async () => ({ ...program(...(o.rules ?? [prRule])), ...(o.refreshEvery && { refreshEvery: o.refreshEvery }) }),
    levelFor: vi.fn(async (k: string) => (o.levels && Object.hasOwn(o.levels, k) ? o.levels[k] : 'connection')),
    port: { snapshot: vi.fn(async () => structuredClone(snap)), hasPermission: vi.fn(async () => o.granted ?? false) },
    facts,
    local,
    now: () => now,
    onUpdated,
  };
  const svc = new SourceService(deps);
  return {
    svc, deps, fetch, local, canSend, facts, onUpdated, snap, conn, states,
    advance: (ms: number) => { now += ms; },
    make: () => new SourceService(deps),
  };
}
const stateOf = (svc: SourceService, tabId: number, key = 'rec/pr') => svc.factsFor(tabId)?.[key];

describe('SourceService: batching', () => {
  it('120 open PR tabs → 3 GraphQL calls (50/50/20)', async () => {
    const t = setup({ tabs: Array.from({ length: 120 }, (_, i) => prTab(i + 1)) });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(3);
    expect(t.fetch.mock.calls.map(([, req]) => prsIn(req))).toEqual([50, 50, 20]);
    const [id, req] = t.fetch.mock.calls[0]!;
    expect(id).toBe('github');
    expect(req).toMatchObject({ method: 'POST', path: '/graphql', background: true });
    expect(stateOf(t.svc, 7)).toMatchObject({ via: 'api', data: { state: 'open' }, stale: false });
  });

  it('owner/repo are case-normalized: Acme/API and acme/api are one PR in one alias (M3-R61)', async () => {
    const t = setup({ tabs: [prTab(1, 7, {}, 'Acme/API'), prTab(2, 7)] });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(prsIn(t.fetch.mock.calls[0]![1])).toBe(1);
    expect((t.fetch.mock.calls[0]![1].json as { variables: Record<string, unknown> }).variables).toMatchObject({ o0: 'acme', n0: 'api' });
    expect(stateOf(t.svc, 1)?.data).toEqual({ state: 'open' });
    expect(stateOf(t.svc, 2)?.data).toEqual({ state: 'open' });
  });

  it('requestsFor skips exempt URLs and includes discarded and frozen tabs; field conditions count as true', async () => {
    const t = setup();
    const snap: Snapshot = { ...t.snap, tabs: [prTab(1), prTab(2, 2, { discarded: true }), prTab(3, 3, { frozen: true }), tab(4, 'chrome://newtab/'), tab(5, 'https://example.com/')] };
    const reqs = t.svc.requestsFor(snap, program(prRule));
    expect(reqs.map((r) => r.tabId)).toEqual([1, 2, 3]);
    expect(reqs[0]).toMatchObject({ ruleKey: 'rec/pr', connection: 'github', query: 'github.pull_request' });
  });
});

describe('SourceService: cache and refresh', () => {
  it("#198: with 'check every' at 1 min, an open PR older than 1 min is refetched on the alarm refresh; a merged one never", async () => {
    const t = setup({ tabs: [prTab(1), prTab(2)], states: new Map([['acme/api#1', 'MERGED']]), refreshEvery: { 'merged-prs': '1m' } });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.advance(30_000);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1); // still fresh
    for (let i = 0; i < 10; i++) {
      t.advance(MIN);
      await t.svc.refresh('alarm');
    }
    expect(t.fetch).toHaveBeenCalledTimes(11);
    expect(t.fetch.mock.calls.slice(1).every(([, req]) => prsIn(req) === 1 && (req.json as { variables: Record<string, unknown> }).variables.k0 === 2)).toBe(true);
  });

  it('#198: an alarm firing a moment early still refetches what the last one fetched (no skipped period)', async () => {
    const t = setup({ tabs: [prTab(1)], refreshEvery: { 'merged-prs': '1m' } });
    await t.svc.refresh('alarm');
    t.advance(MIN - 500);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it('#198: without a "check every" setting, an open PR is still reused for 5 min', async () => {
    const t = setup({ tabs: [prTab(1)] });
    await t.svc.refresh('alarm');
    t.advance(MIN);
    await t.svc.refresh('alarm');
    t.advance(3 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.advance(MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("#198: freshnessMs caps the status lookups at the 'check every' period, not the key search or Jira projects", () => {
    const p = (refreshEvery?: Record<string, string>) => ({ ...program(prRule), ...(refreshEvery && { refreshEvery }) });
    for (const q of ['github.pull_request', 'github.issue', 'jira.issue'] as const) {
      expect(freshnessMs(q, p())).toBe(5 * MIN);
      expect(freshnessMs(q, p({ a: '1m' }))).toBe(MIN);
      expect(freshnessMs(q, p({ a: '2m', b: '30m' }))).toBe(2 * MIN);
      expect(freshnessMs(q, p({ a: '30m' }))).toBe(5 * MIN); // never longer than the query's own TTL
    }
    expect(freshnessMs('github.search_prs_by_key', p({ a: '1m' }))).toBe(15 * MIN);
    expect(freshnessMs('jira.projects', p({ a: '1m' }))).toBe(24 * 60 * MIN);
  });

  it('a merged PR is fetched once and never refetched over 1 h of alarms; an open PR is refetched after 5 min', async () => {
    const t = setup({ tabs: [prTab(1), prTab(2)], states: new Map([['acme/api#1', 'MERGED']]) });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ data: { state: 'merged', mergedAt: '2026-10-01T00:00:00Z' }, final: true });
    t.advance(4 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1); // the open one is still fresh
    for (let i = 0; i < 12; i++) {
      t.advance(5 * MIN);
      await t.svc.refresh('alarm');
    }
    expect(t.fetch).toHaveBeenCalledTimes(13);
    expect(t.fetch.mock.calls.slice(1).every(([, req]) => prsIn(req) === 1 && (req.json as { variables: Record<string, unknown> }).variables.k0 === 2)).toBe(true);
  });

  it('calls onUpdated with the tabs whose data changed, and not for an unchanged refetch', async () => {
    const t = setup({ tabs: [prTab(1), prTab(2)] });
    await t.svc.refresh('alarm');
    expect(t.onUpdated).toHaveBeenCalledWith([1, 2]);
    t.onUpdated.mockClear();
    t.advance(6 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.onUpdated).not.toHaveBeenCalled();
    t.states.set('acme/api#2', 'MERGED');
    t.advance(6 * MIN);
    await t.svc.refresh('alarm');
    expect(t.onUpdated).toHaveBeenCalledWith([2]);
  });

  it('Review Focus #1: needs-reauth keeps merged and open data with stale: true, never unknown; the flag flip is reported (M3-R92)', async () => {
    const t = setup({ tabs: [prTab(1), prTab(2)], states: new Map([['acme/api#1', 'MERGED']]) });
    await t.svc.refresh('alarm');
    t.onUpdated.mockClear();
    t.conn.github = 'needs-reauth';
    t.advance(6 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ data: { state: 'merged' }, stale: true, error: 'unauthorized', via: 'api' });
    expect(stateOf(t.svc, 2)).toMatchObject({ data: { state: 'open' }, stale: true, error: 'unauthorized', via: 'api' });
    // fresh -> stale reaches onUpdated, so pending closes on that data are cancelled at evaluation (M3-R90 / M3-R92).
    expect(t.onUpdated).toHaveBeenCalledWith([1, 2]);
    t.onUpdated.mockClear();
    t.advance(6 * MIN);
    await t.svc.refresh('alarm'); // still stale (same error): no change
    expect(t.onUpdated).not.toHaveBeenCalled();
  });

  it('M3-R92: a stale entry turning fresh with the same data (a re-auth) is reported, so a skipped close re-arms', async () => {
    const t = setup({ tabs: [prTab(1)], states: new Map([['acme/api#1', 'MERGED']]) });
    await t.svc.refresh('alarm');
    t.conn.github = 'needs-reauth';
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1)).toMatchObject({ data: { state: 'merged' }, stale: true });
    t.onUpdated.mockClear();
    t.conn.github = 'ok';
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1); // final: not refetched, only unstaled
    expect(stateOf(t.svc, 1)).toMatchObject({ data: { state: 'merged' }, stale: false });
    expect(t.onUpdated).toHaveBeenCalledWith([1]);
  });

  it('M3-R89: a rule kept at its connection level while needs-reauth reads the page where granted; the final merged entry stays stale', async () => {
    const mergedPage = { texts: [], extracts: { 'adapter:github.prPage.state': 'Status: Merged' }, formEdited: false };
    const t = setup({ tabs: [prTab(1), prTab(2)], states: new Map([['acme/api#1', 'MERGED']]), granted: true, facts: { 2: mergedPage } });
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 2)).toMatchObject({ via: 'api', data: { state: 'open' } });
    t.conn.github = 'needs-reauth'; // levelFor still answers 'connection' (PermissionsManager keeps the level)
    t.advance(6 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ data: { state: 'merged' }, stale: true, error: 'unauthorized', via: 'api' });
    expect(stateOf(t.svc, 2)).toMatchObject({ via: 'page', data: { state: 'merged' }, stale: false });
  });

  it('an API error keeps the previous data with stale and error set', async () => {
    const t = setup({ tabs: [prTab(1)] });
    await t.svc.refresh('alarm');
    t.fetch.mockImplementation(async () => ({ ok: false, kind: 'server', status: 502, message: 'Bad gateway' }));
    t.advance(6 * MIN);
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1)).toMatchObject({ data: { state: 'open' }, stale: true, error: 'server' });
  });

  it('Review Focus #2: with the background budget spent the alarm refresh makes no fetch; a popup refresh still fetches', async () => {
    const t = setup({ tabs: [prTab(1)], canSend: false });
    await t.svc.refresh('alarm');
    expect(t.canSend).toHaveBeenCalledWith('github', true, 'graphql');
    expect(t.fetch).not.toHaveBeenCalled();
    await t.svc.refresh('popup');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.fetch.mock.calls[0]![1].background).toBe(false);
  });

  it('popup refreshes are throttled to one per 30 s', async () => {
    const t = setup({ tabs: [prTab(1)], fetch: async () => ({ ok: false, kind: 'network', message: 'offline' }) });
    await t.svc.refresh('popup');
    t.advance(10_000);
    await t.svc.refresh('popup');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await t.svc.refresh('manual'); // not throttled: the error entry is refetched
    expect(t.fetch).toHaveBeenCalledTimes(2);
    t.advance(POPUP_THROTTLE_MS);
    await t.svc.refresh('popup');
    expect(t.fetch).toHaveBeenCalledTimes(3);
  });

  it('the cache survives a new SourceService (storage.local)', async () => {
    const t = setup({ tabs: [prTab(1)], states: new Map([['acme/api#1', 'MERGED']]) });
    await t.svc.refresh('alarm');
    const again = t.make();
    await again.ready;
    expect(stateOf(again, 1)).toMatchObject({ data: { state: 'merged' }, via: 'api' }); // indexed at load, before any refresh
    t.advance(60 * MIN);
    await again.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it(`evicts the least recently used entries above ${CACHE_MAX}`, async () => {
    const t = setup({ tabs: Array.from({ length: CACHE_MAX }, (_, i) => prTab(i + 1)) });
    await t.svc.refresh('alarm');
    t.snap.tabs = [prTab(1), prTab(CACHE_MAX + 1)];
    t.advance(MIN);
    await t.svc.refresh('alarm');
    const stored = t.local.data[SOURCE_CACHE_KEY] as [string, unknown][];
    expect(stored).toHaveLength(CACHE_MAX);
    const keys = stored.map(([k]) => k);
    expect(keys).toContain(`github|github.pull_request|acme/api#${CACHE_MAX + 1}`);
    expect(keys).toContain('github|github.pull_request|acme/api#1'); // used again: kept
    expect(keys).not.toContain('github|github.pull_request|acme/api#2'); // least recently used: evicted
  });
});

describe('SourceService: fallback', () => {
  const merged = { texts: [], extracts: { 'adapter:github.prPage.state': 'Status: Merged' }, formEdited: false };

  it('M3-R65: a rule at its page alternative never calls the API, even with the connection ok; it reads the page', async () => {
    const t = setup({ tabs: [prTab(1)], granted: true, facts: { 1: merged }, levels: { 'rec/pr': 'page' } });
    await t.svc.refresh('alarm');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.deps.levelFor).toHaveBeenCalledWith('rec/pr');
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'page', data: { state: 'merged' } });
  });

  it('M3-R65: a rule at its titles alternative (or paused) neither calls the API nor reads the page', async () => {
    for (const level of ['titles', undefined] as const) {
      const t = setup({ tabs: [prTab(1)], granted: true, facts: { 1: merged }, levels: { 'rec/pr': level } });
      await t.svc.refresh('alarm');
      expect(t.fetch).not.toHaveBeenCalled();
      expect(t.deps.port.hasPermission).not.toHaveBeenCalled();
      expect(stateOf(t.svc, 1)).toMatchObject({ via: 'none' });
    }
  });

  it('M3-R65: a fresh API entry is marked stale once its rule drops below the connection alternative', async () => {
    const t = setup({ tabs: [prTab(1)], states: new Map([['acme/api#1', 'MERGED']]), levels: {} });
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', stale: false });
    vi.mocked(t.deps.levelFor).mockResolvedValue('page');
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'merged' }, stale: true });
  });

  it('the connection is ok but cannot read the PR (repo not visible to the token) → the loaded page is read instead', async () => {
    const page = { texts: [], extracts: { 'adapter:github.prPage.state': 'Open', 'adapter:github.prPage.branch': 'feat/abc-12/parser' }, formEdited: false };
    const notVisible = async (): Promise<ApiResult> => ({ ok: true, status: 200, data: { data: { r0: null }, errors: [{ type: 'NOT_FOUND', path: ['r0'], message: 'Could not resolve to a Repository' }] } });
    const t = setup({ tabs: [prTab(1)], granted: true, facts: { 1: page }, fetch: notVisible, rules: [{ ...prRule, source: { ...prRule.source!, fields: { state: 'state', headRefName: 'headRefName' } } }] });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'page', data: { state: 'open', headRefName: 'feat/abc-12/parser' }, stale: false });
    // Without a readable page it stays a failed lookup.
    const u = setup({ tabs: [prTab(1)], granted: true, fetch: notVisible });
    await u.svc.refresh('alarm');
    expect(stateOf(u.svc, 1)).toMatchObject({ via: 'none', error: 'not-found' });
  });

  it('unreadableRepos: repos of open PR tabs the API answered without the PR, cleared once a PR there is read', async () => {
    let visible = false;
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => (visible ? prResponse(req, new Map())
      : { ok: true, status: 200, data: { data: { r0: null }, errors: [{ type: 'NOT_FOUND', path: ['r0'], message: 'Could not resolve to a Repository' }] } });
    const t = setup({ tabs: [prTab(1)], fetch });
    await t.svc.refresh('alarm');
    expect(t.svc.unreadableRepos()).toEqual([{ repo: 'acme/api', error: 'not-found' }]);
    visible = true;
    t.advance(10 * MIN);
    await t.svc.refresh('alarm');
    expect(t.svc.unreadableRepos()).toEqual([]);
  });

  it('no connection and a loaded tab with page facts → via page with the parsed state', async () => {
    const t = setup({ tabs: [prTab(1)], conn: { github: 'not-configured' }, granted: true, facts: { 1: merged } });
    await t.svc.refresh('alarm');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'page', data: { state: 'merged' }, stale: false });
    expect(t.deps.port.hasPermission).toHaveBeenCalledWith({ origins: ['https://github.com/*'] });
    expect(t.onUpdated).toHaveBeenCalledWith([1]);
  });

  it('Review Focus #4: a discarded PR tab is in the API batch; with no connection it is via none, unknown, adapter not consulted', async () => {
    const ok = setup({ tabs: [prTab(1, 1, { discarded: true })] });
    await ok.svc.refresh('alarm');
    expect(prsIn(ok.fetch.mock.calls[0]![1])).toBe(1);

    const t = setup({ tabs: [prTab(1, 1, { discarded: true })], conn: { github: 'not-configured' }, granted: true, facts: { 1: merged } });
    await t.svc.refresh('alarm');
    expect(t.fetch).not.toHaveBeenCalled();
    const e = stateOf(t.svc, 1);
    expect(e).toMatchObject({ via: 'none', stale: false });
    expect(e?.data).toEqual({}); // PrState 'unknown' is never a field value (M3-R45)
    expect(t.facts.get).not.toHaveBeenCalled();
    expect(t.onUpdated).not.toHaveBeenCalled(); // nothing known before or after: no change
    t.snap.tabs.push(prTab(2, 2, { discarded: true })); // also for a tab new since the last refresh
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 2)).toMatchObject({ via: 'none' });
    expect(t.onUpdated).not.toHaveBeenCalled();
  });

  it('without the host granted the page is not read', async () => {
    const t = setup({ tabs: [prTab(1)], conn: { github: 'not-configured' }, granted: false, facts: { 1: merged } });
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'none' });
  });
});

describe('SourceService: fix round 1', () => {
  const merged = { texts: [], extracts: { 'adapter:github.prPage.state': 'Status: Merged' }, formEdited: false };
  const issueBody = (keys: string[]) => ({ issues: keys.map((key) => ({ key, fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } })) });

  it('a page-read merged PR is not final: once the connection is ok it is fetched once and gets mergedAt', async () => {
    const t = setup({ tabs: [prTab(1)], conn: { github: 'not-configured' }, granted: true, facts: { 1: merged }, states: new Map([['acme/api#1', 'MERGED']]) });
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'page', data: { state: 'merged' }, final: false });
    expect(stateOf(t.svc, 1)?.data).not.toHaveProperty('mergedAt');
    t.conn.github = 'ok';
    t.advance(MIN);
    await t.svc.refresh('alarm');
    t.advance(60 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', final: true, data: { state: 'merged', mergedAt: '2026-10-01T00:00:00Z' } });
  });

  it('issues() changing data a tab rule reads fires onUpdated with that tab', async () => {
    const t = setup({ tabs: [tab(1, 'https://acme.atlassian.net/browse/ABC-1')], rules: [issueRule], conn: { jira: 'not-configured' } });
    await t.svc.refresh('alarm');
    t.onUpdated.mockClear();
    t.conn.jira = 'ok';
    t.fetch.mockImplementation(async (_id, req) => ({ ok: true, status: 200, data: issueBody(/key in \((.*)\)/.exec(req.query!.jql!)![1]!.split(',')) }));
    await t.svc.issues(['ABC-1']);
    expect(t.onUpdated).toHaveBeenCalledWith([1]);
    t.onUpdated.mockClear();
    await t.svc.refresh('manual'); // already reported: no second report
    expect(t.onUpdated).not.toHaveBeenCalled();
  });

  it('a run that throws midway still saves and reports what it changed', async () => {
    const t = setup({ tabs: [prTab(1), tab(2, 'https://acme.atlassian.net/browse/ABC-1')], rules: [prRule, issueRule] });
    vi.mocked(t.deps.conn.defs).mockRejectedValue(new Error('storage gone'));
    await expect(t.svc.refresh('alarm')).rejects.toThrow('storage gone');
    expect(t.onUpdated).toHaveBeenCalledWith([1]);
    expect((t.local.data[SOURCE_CACHE_KEY] as [string, unknown][]).map(([k]) => k)).toContain('github|github.pull_request|acme/api#1');
  });

  it('stale and none entries always carry an error, not-configured included (M3-R62)', async () => {
    const t = setup({ tabs: [prTab(1), prTab(2)], states: new Map([['acme/api#1', 'MERGED']]) });
    await t.svc.refresh('alarm');
    t.conn.github = 'not-configured';
    t.advance(6 * MIN);
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1)).toMatchObject({ stale: true, error: 'not-configured' }); // final: fresh path
    expect(stateOf(t.svc, 2)).toMatchObject({ stale: true, error: 'not-configured' }); // expired: fallback path
    const n = setup({ tabs: [prTab(1)], conn: { github: 'not-configured' } });
    await n.svc.refresh('alarm');
    expect(stateOf(n.svc, 1)).toMatchObject({ via: 'none', error: 'not-configured' });
  });

  it('a refresh that changed nothing does not rewrite the cache', async () => {
    const t = setup({ tabs: [prTab(1)] });
    await t.svc.refresh('alarm');
    t.local.set.mockClear();
    t.advance(MIN);
    await t.svc.refresh('alarm');
    expect(t.local.set).not.toHaveBeenCalled();
    const n = setup({ tabs: [prTab(1)], conn: { github: 'not-configured' } });
    await n.svc.refresh('alarm');
    n.local.set.mockClear();
    n.advance(6 * MIN);
    await n.svc.refresh('alarm'); // still no connection: the none entry is unchanged
    expect(n.local.set).not.toHaveBeenCalled();
  });

  it('a failed cache load is retried before the next write and never overwritten by an empty cache', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = memLocal();
    local.data[SOURCE_CACHE_KEY] = [['github|github.pull_request|acme/api#9', { data: { state: 'merged' }, fetchedAt: 1, via: 'api', final: true, stale: false, usedAt: 1 }]];
    local.get.mockRejectedValueOnce(new Error('busy'));
    const t = setup({ tabs: [prTab(1)], local });
    await t.svc.ready;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('source cache load failed'), expect.any(Error));
    await t.svc.refresh('alarm');
    const keys = (local.data[SOURCE_CACHE_KEY] as [string, unknown][]).map(([k]) => k);
    expect(keys).toEqual(expect.arrayContaining(['github|github.pull_request|acme/api#9', 'github|github.pull_request|acme/api#1']));
    // Still failing: nothing is written.
    const l2 = memLocal();
    l2.data[SOURCE_CACHE_KEY] = local.data[SOURCE_CACHE_KEY];
    l2.get.mockRejectedValue(new Error('busy'));
    const t2 = setup({ tabs: [prTab(1)], local: l2 });
    await t2.svc.refresh('alarm').catch(() => {});
    expect(l2.set).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('SourceService: follow-up round', () => {
  const open = { texts: [], extracts: { 'adapter:github.prPage.state': 'Status: Open' }, formEdited: false };

  it('a page reading keeps a rate-limited retryAt: no API call until it passes', async () => {
    const retryAt = Date.parse('2026-11-02T10:10:00Z');
    const t = setup({
      tabs: [prTab(1)], conn: { github: 'not-configured' }, granted: true, facts: { 1: open },
      fetch: async () => ({ ok: false, kind: 'rate-limited', message: 'slow down', retryAt }),
    });
    await t.svc.refresh('alarm'); // page entry
    t.conn.github = 'ok';
    t.advance(MIN);
    await t.svc.refresh('alarm'); // the API rate-limits: stale with retryAt
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'page', stale: true, retryAt });
    for (let i = 0; i < 4; i++) {
      t.advance(MIN);
      await t.svc.refresh('alarm'); // blocked: the page is read again, the retryAt kept
    }
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'page', stale: false, retryAt, data: { state: 'open' } });
    t.advance(5 * MIN); // past retryAt
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("a run's own error wins over a failing save in its finally", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup({ tabs: [prTab(1), tab(2, 'https://acme.atlassian.net/browse/ABC-1')], rules: [prRule, issueRule] });
    vi.mocked(t.deps.conn.defs).mockRejectedValue(new Error('storage gone'));
    t.local.set.mockRejectedValue(new Error('quota'));
    await expect(t.svc.refresh('alarm')).rejects.toThrow('storage gone');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('source save failed after a failed refresh'), expect.objectContaining({ message: 'quota' }));
    warn.mockRestore();
    const ok = setup({ tabs: [prTab(1)] });
    ok.local.set.mockRejectedValue(new Error('quota'));
    await expect(ok.svc.refresh('alarm')).rejects.toThrow('quota'); // without a run error, the save error surfaces
  });
});

describe('SourceService: Jira', () => {
  const issues = (keys: string[]) => ({
    issues: keys.map((key) => ({ key, fields: { summary: `S ${key}`, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } })),
  });
  const jql = (req: ApiRequest) => /key in \((.*)\)/.exec(req.query!.jql!)![1]!.split(',');

  it('jira.issue tabs batch through resolveInHalves; a rate-limited batch records retryAt and is not retried before it (M3-R60)', async () => {
    let limited = true;
    const t = setup({
      tabs: [tab(1, 'https://acme.atlassian.net/browse/ABC-1'), tab(2, 'https://acme.atlassian.net/browse/ABC-2')], rules: [issueRule],
      fetch: async (_id, req) => (limited ? { ok: false, kind: 'rate-limited', message: 'slow down', retryAt: Date.parse('2026-11-02T10:10:00Z') } : { ok: true, status: 200, data: issues(jql(req)) }),
    });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.fetch.mock.calls[0]![1]).toMatchObject({ method: 'GET', path: '/rest/api/3/search/jql', background: true });
    expect(stateOf(t.svc, 1, 'rec/issue')).toMatchObject({ via: 'none', error: 'rate-limited', retryAt: Date.parse('2026-11-02T10:10:00Z') });
    limited = false;
    t.advance(5 * MIN);
    await t.svc.refresh('alarm');
    t.advance(MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1, 'rec/issue')).toMatchObject({ error: 'rate-limited', retryAt: Date.parse('2026-11-02T10:10:00Z') });
    t.advance(5 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(stateOf(t.svc, 2, 'rec/issue')).toMatchObject({ via: 'api', data: { status: 'In Progress', cat: 'indeterminate' }, stale: false });
  });

  it("#198: with 'check every' at 1 min, a ticket tab and issues() refetch a ticket older than 1 min", async () => {
    const t = setup({
      tabs: [tab(1, 'https://acme.atlassian.net/browse/ABC-1')], rules: [issueRule], refreshEvery: { 'merged-prs': '1m' },
      fetch: async (_id, req) => ({ ok: true, status: 200, data: issues(jql(req)) }),
    });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.advance(MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    await t.svc.issues(['ABC-1']); // just fetched: fresh
    expect(t.fetch).toHaveBeenCalledTimes(2);
    t.advance(MIN);
    await t.svc.issues(['ABC-1']);
    expect(t.fetch).toHaveBeenCalledTimes(3);
  });

  it('issues() returns entries per key and bisects a bad request', async () => {
    const t = setup({
      fetch: async (_id, req) => (jql(req).includes('BAD-1') && jql(req).length > 1 ? { ok: false, kind: 'bad-request', status: 400, message: 'x' }
        : jql(req).includes('BAD-1') ? { ok: true, status: 200, data: { issues: [] } } : { ok: true, status: 200, data: issues(jql(req)) }),
    });
    const r = await t.svc.issues(['ABC-1', 'BAD-1']);
    expect(r.get('ABC-1')).toMatchObject({ via: 'api', data: { key: 'ABC-1', status: 'In Progress', url: 'https://acme.atlassian.net/browse/ABC-1' } });
    expect(r.get('BAD-1')).toMatchObject({ via: 'none', error: 'not-found' });
    const n = t.fetch.mock.calls.length;
    await t.svc.issues(['ABC-1']); // fresh: from the cache
    expect(t.fetch).toHaveBeenCalledTimes(n);
    expect(t.fetch.mock.calls[0]![1].background).toBe(false);
  });

  it('a 200 omitting every key (anonymous / expired) is not cached as not-found and re-validates GET /myself (M3-R100)', async () => {
    let anonymous = false;
    const t = setup({
      fetch: async (_id, req) => (req.path === '/rest/api/3/myself' ? { ok: false, kind: 'unauthorized', status: 401, message: 'Sign in to Jira again' }
        : { ok: true, status: 200, data: anonymous ? { issues: [], isLast: true } : issues(jql(req)) }),
    });
    expect((await t.svc.issues(['ABC-1'])).get('ABC-1')).toMatchObject({ via: 'api', data: { status: 'In Progress' } });
    anonymous = true;
    t.advance(6 * MIN);
    const r = await t.svc.issues(['ABC-1', 'ABC-2']);
    expect(r.get('ABC-1')).toMatchObject({ via: 'api', data: { status: 'In Progress' }, stale: true, error: 'unauthorized' });
    expect(r.get('ABC-2')).toMatchObject({ via: 'none', error: 'unauthorized' });
    const paths = t.fetch.mock.calls.map(([, req]) => req.path);
    expect(paths.filter((p) => p === '/rest/api/3/myself')).toHaveLength(1);
    expect(t.fetch.mock.calls.find(([, req]) => req.path === '/rest/api/3/myself')![1]).toMatchObject({ method: 'GET', background: false });
  });

  it('M3-R110: a ticket tab on another Jira site is never looked up on the connected one, nor shares its cache entry', async () => {
    const done = (keys: string[]) => ({ issues: keys.map((key) => ({ key, fields: { summary: `Acme ${key}`, status: { name: 'Done', statusCategory: { key: 'done' } } } })) });
    const t = setup({
      tabs: [tab(1, 'https://other.atlassian.net/browse/SCRUM-1')], rules: [issueRule],
      fetch: async (_id, req) => ({ ok: true, status: 200, data: done(jql(req)) }),
    });
    await t.svc.refresh('manual');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(stateOf(t.svc, 1, 'rec/issue')?.via).not.toBe('api');
    // The same key on the connected site is looked up; the other site's tab still does not see that answer.
    t.snap.tabs.push(tab(2, 'https://acme.atlassian.net/browse/SCRUM-1'));
    await t.svc.refresh('manual');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(jql(t.fetch.mock.calls[0]![1])).toEqual(['SCRUM-1']);
    expect(stateOf(t.svc, 2, 'rec/issue')).toMatchObject({ via: 'api', data: { status: 'Done', cat: 'done' } });
    expect(stateOf(t.svc, 1, 'rec/issue')?.via).not.toBe('api');
    expect(stateOf(t.svc, 1, 'rec/issue')?.data ?? {}).not.toHaveProperty('status');
    // issues() (the connected site) shares the on-site tab's entry, not the other site's.
    expect((await t.svc.issues(['SCRUM-1'])).get('SCRUM-1')).toMatchObject({ via: 'api', data: { summary: 'Acme SCRUM-1' } });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(await t.svc.jiraSite()).toBe('acme.atlassian.net');
  });

  it('a 200 with some keys keeps the absent ones not-found and does not re-validate (M3-R100)', async () => {
    const t = setup({ fetch: async (_id, req) => ({ ok: true, status: 200, data: issues(jql(req).filter((k) => k !== 'ABC-9')) }) });
    const r = await t.svc.issues(['ABC-1', 'ABC-9']);
    expect(r.get('ABC-9')).toMatchObject({ via: 'none', error: 'not-found' });
    expect(t.fetch.mock.calls.map(([, req]) => req.path)).toEqual(['/rest/api/3/search/jql']);
  });

  describe('a failed lookup backs off (#190)', () => {
    // A ticket that does not exist or that the user cannot browse is absent from the search answer.
    const search = (absent: string[]) => async (_id: string, req: ApiRequest): Promise<ApiResult> =>
      req.path.includes('myself') ? { ok: true, status: 200, data: { accountId: 'me' } } : { ok: true, status: 200, data: issues(jql(req).filter((k) => !absent.includes(k))) };
    const minuteOfPolling = async (t: ReturnType<typeof setup>, keys: string[]) => {
      const before = t.fetch.mock.calls.length;
      for (let i = 0; i < 12; i++) { await t.svc.issues(keys); t.advance(5000); }
      return t.fetch.mock.calls.slice(before).map((c) => c[1].path);
    };

    it('a found ticket is asked once a minute of polling', async () => {
      const t = setup({ fetch: search([]) });
      expect(await minuteOfPolling(t, ['ABC-1'])).toHaveLength(1);
    });

    it('a missing or unbrowsable ticket costs one search and one /myself, not two requests every listing', async () => {
      const t = setup({ fetch: search(['ABC-404']) });
      expect(await minuteOfPolling(t, ['ABC-404'])).toEqual(['/rest/api/3/search/jql', '/rest/api/3/myself']);
      expect((await t.svc.issues(['ABC-404'])).get('ABC-404')).toMatchObject({ via: 'none' });
    });

    it('a missing ticket among found ones is not asked again on the next listing', async () => {
      const t = setup({ fetch: search(['ABC-404']) });
      await t.svc.issues(['ABC-1', 'ABC-404']);
      t.fetch.mockClear();
      t.advance(5000);
      await t.svc.issues(['ABC-1', 'ABC-404']);
      expect(t.fetch).not.toHaveBeenCalled();
    });

    it('a Jira connection change clears its back-off', async () => {
      const t = setup({ fetch: search(['ABC-404']) });
      await t.svc.issues(['ABC-404']);
      t.fetch.mockClear();
      await t.svc.connectionChanged('jira');
      t.advance(5000);
      await t.svc.issues(['ABC-404']);
      expect(t.fetch.mock.calls.map((c) => c[1].path)).toContain('/rest/api/3/search/jql');
    });
  });
});

describe('SourceService: linkedFor', () => {
  const searchResponse = (req: ApiRequest): ApiResult => {
    const { variables } = req.json as { variables: Record<string, string> };
    const data: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(variables)) {
      const key = /"([A-Z]+-\d+)"/.exec(q)?.[1] ?? /head:(\S+)/.exec(q)![1]!;
      data[`s${k.slice(1)}`] = { nodes: q.startsWith('"') ? [{ number: 3, title: `${key} fix`, url: 'u', state: 'MERGED', merged: true, headRefName: 'b', repository: { owner: { login: 'acme' }, name: 'api' } }] : [] };
    }
    return { ok: true, status: 200, data: { data } };
  };

  it('searches by key with the orgs, batched by 10, cached for 15 min', async () => {
    const t = setup({ fetch: async (_id, req) => searchResponse(req) });
    const keys = Array.from({ length: 11 }, (_, i) => `ABC-${i + 1}`);
    const r = await t.svc.linkedFor(keys, ['Acme']);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(Object.values((t.fetch.mock.calls[0]![1].json as { variables: Record<string, string> }).variables)[0]).toContain('org:acme');
    expect(r.get('ABC-1')).toEqual([expect.objectContaining({ owner: 'acme', repo: 'api', number: 3, state: 'merged' })]);
    t.advance(14 * MIN);
    await t.svc.linkedFor(['ABC-1'], ['acme']);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    t.advance(2 * MIN);
    await t.svc.linkedFor(['ABC-1'], ['acme']);
    expect(t.fetch).toHaveBeenCalledTimes(3);
  });

  it("#198: the key search keeps its 15 min, whatever the 'check every' setting", async () => {
    const t = setup({ fetch: async (_id, req) => searchResponse(req), refreshEvery: { 'merged-prs': '1m' } });
    await t.svc.linkedFor(['ABC-1'], ['acme']);
    t.advance(14 * MIN);
    await t.svc.linkedFor(['ABC-1'], ['acme']);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached results without a fetch while the connection is not ok', async () => {
    const t = setup({ conn: { github: 'needs-reauth' }, fetch: async (_id, req) => searchResponse(req) });
    expect((await t.svc.linkedFor(['ABC-1'], [])).size).toBe(0);
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe('SourceService: same-document navigation', () => {
  // The built-in recipes match a PR's sub-pages too (`:num*`): Files changed, Commits, Checks.
  const subPageRule: Rule = { ...prRule, match: { url: 'github.com/:owner/:repo/pull/:num*' } };
  const at = async () => {
    const t = setup({ tabs: [prTab(1, 7)], rules: [subPageRule] });
    await t.svc.refresh('manual');
    return t;
  };

  it("keeps a PR's data when the tab moves to one of its sub-pages, before the next refresh re-indexes it", async () => {
    const t = await at();
    for (const sub of ['/files', '/commits', '/commits/abc123', '#issuecomment-1']) {
      expect(t.svc.factsFor(1, `https://github.com/acme/api/pull/7${sub}`)?.['rec/pr']).toMatchObject({ data: { state: 'open' } });
    }
  });
  it("drops the data when the tab moves to another PR or off the PR", async () => {
    const t = await at();
    expect(t.svc.factsFor(1, 'https://github.com/acme/api/pull/8')).toBeUndefined();
    expect(t.svc.factsFor(1, 'https://github.com/acme/web/pull/7/files')).toBeUndefined();
    expect(t.svc.factsFor(1, 'https://github.com/acme/api')).toBeUndefined();
  });
});

describe('SourceService: GitHub issues', () => {
  const ghIssueRule: Rule = {
    id: 'ghissue', name: 'GitHub issue', enabled: true,
    source: { connection: 'github', query: 'github.issue', args: { owner: '{owner}', repo: '{repo}', number: '{num}' }, fields: { status: 'status', statusCategory: 'statusCategory', summary: 'summary' } },
    match: { url: 'github.com/:owner/:repo/issues/:num' }, actions: [{ group: { title: 'Issues', color: 'green' } }],
  };
  /** A GraphQL issue response for the query's aliases; issues in `missing` ('owner/repo#n') come back null and NOT_FOUND. */
  function issueResponse(req: ApiRequest, missing: string[] = []): ApiResult {
    const { query, variables } = req.json as { query: string; variables: Record<string, unknown> };
    const data: Record<string, Record<string, unknown>> = {};
    const errors: unknown[] = [];
    let repo = '';
    let repoKey = '';
    for (const m of query.matchAll(/(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\)|(i\d+): issue\(number: \$(k\d+)\)/g)) {
      if (m[1]) {
        repo = m[1];
        repoKey = `${String(variables[m[2]!])}/${String(variables[m[3]!])}`;
        data[repo] = {};
      } else {
        const key = `${repoKey}#${String(variables[m[5]!])}`;
        if (missing.includes(key)) {
          data[repo]![m[4]!] = null;
          errors.push({ type: 'NOT_FOUND', path: [repo, m[4]!], message: 'Could not resolve to an Issue' });
        } else {
          data[repo]![m[4]!] = { title: `T ${key}`, state: 'OPEN', stateReason: null, url: `https://github.com/${key.replace('#', '/issues/')}`, closedByPullRequestsReferences: { nodes: [] } };
        }
      }
    }
    return { ok: true, status: 200, data: { data, ...(errors.length && { errors }) } };
  }
  const issuesIn = (req: ApiRequest) => [...(req.json as { query: string }).query.matchAll(/issue\(/g)].length;
  const issueTab = (id: number, path: string) => tab(id, `https://github.com/${path}`);

  it('an issue tab on an ok connection sends one GraphQL POST and exposes status, statusCategory and summary', async () => {
    const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [ghIssueRule], fetch: async (_id, req) => issueResponse(req) });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.fetch.mock.calls[0]).toEqual(['github', expect.objectContaining({ method: 'POST', path: '/graphql', background: true })]);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api', stale: false, data: { status: 'Open', statusCategory: 'new', summary: 'T acme/web#5' } });
  });

  it('mixed-case owner/repo are lower-cased: Acme/Web and acme/web are one issue, and it is found', async () => {
    const t = setup({ tabs: [issueTab(1, 'Acme/Web/issues/5'), issueTab(2, 'acme/web/issues/5')], rules: [ghIssueRule], fetch: async (_id, req) => issueResponse(req) });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(issuesIn(t.fetch.mock.calls[0]![1])).toBe(1);
    expect((t.fetch.mock.calls[0]![1].json as { variables: Record<string, unknown> }).variables).toMatchObject({ o0: 'acme', n0: 'web', k0: 5 });
    for (const id of [1, 2]) expect(stateOf(t.svc, id, 'rec/ghissue')).toMatchObject({ via: 'api', data: { status: 'Open' } });
  });

  it('githubIssues() reuses the tab lookup\'s cache entry (no second request)', async () => {
    const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [ghIssueRule], fetch: async (_id, req) => issueResponse(req) });
    await t.svc.refresh('alarm');
    const r = await t.svc.githubIssues(['acme/web#5']);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(r.get('acme/web#5')).toMatchObject({ via: 'api', data: { owner: 'acme', repo: 'web', number: 5, state: 'open', summary: 'T acme/web#5' } });
  });

  it('githubIssues() fetches due keys in the foreground, mixed case included, and a tab rule then reads that entry', async () => {
    const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [ghIssueRule], fetch: async (_id, req) => issueResponse(req, ['acme/web#9']) });
    const r = await t.svc.githubIssues(['Acme/Web#5', 'acme/web#9']);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.fetch.mock.calls[0]![1].background).toBe(false);
    expect(issuesIn(t.fetch.mock.calls[0]![1])).toBe(2);
    expect(r.get('Acme/Web#5')).toMatchObject({ via: 'api', data: { state: 'open' } });
    expect(r.get('acme/web#9')).toMatchObject({ via: 'none', error: 'not-found', data: { owner: 'acme', repo: 'web', number: 9, state: 'unknown' } });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api', data: { summary: 'T acme/web#5' } });
  });

  it("#198: with 'check every' at 1 min, an issue tab and githubIssues() refetch an issue older than 1 min", async () => {
    const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [ghIssueRule], refreshEvery: { 'merged-prs': '1m' }, fetch: async (_id, req) => issueResponse(req) });
    await t.svc.refresh('alarm');
    t.advance(MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    await t.svc.githubIssues(['acme/web#5']);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    t.advance(MIN);
    await t.svc.githubIssues(['acme/web#5']);
    expect(t.fetch).toHaveBeenCalledTimes(3);
  });

  it('githubIssues() skips malformed keys and sends nothing for them', async () => {
    const t = setup({ fetch: async (_id, req) => issueResponse(req) });
    const r = await t.svc.githubIssues(['not a key', 'acme/web#0', 'acme#5']);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(r.size).toBe(0);
  });

  it('an issue the API cannot read, with no page adapter, is a failed lookup (not-found)', async () => {
    const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [ghIssueRule], granted: true, fetch: async (_id, req) => issueResponse(req, ['acme/web#5']) });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'none', error: 'not-found' });
  });

  it('without the Issues permission: the issue is via none, its PR via api, the connection untouched, and missingIssuesPermission() says so until an issue is read', async () => {
    let allowed = false;
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => {
      if (!issuesIn(req)) return prResponse(req, new Map());
      if (allowed) return issueResponse(req);
      return { ok: true, status: 200, data: { data: { r0: { i0: null } }, errors: [{ type: 'FORBIDDEN', path: ['r0', 'i0'], message: 'Resource not accessible by integration' }] } };
    };
    const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5'), prTab(2)], rules: [ghIssueRule, prRule], fetch });
    expect(t.svc.missingIssuesPermission()).toBe(false);
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'none', error: 'not-found' });
    expect(stateOf(t.svc, 2)).toMatchObject({ via: 'api', data: { state: 'open' } });
    expect(t.conn).toEqual({ github: 'ok', jira: 'ok' });
    expect(t.svc.unreadableRepos()).toEqual([]);
    expect(t.svc.missingIssuesPermission()).toBe(true);
    allowed = true;
    t.advance(10 * MIN);
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api' });
    expect(t.svc.missingIssuesPermission()).toBe(false);
  });

  it('a PR lost to a refused closingIssuesReferences (the PR node or data null) is asked again once without it: read via api, flag set, 2 POSTs', async () => {
    const error = { type: 'FORBIDDEN', path: ['r0', 'p0', 'closingIssuesReferences'], message: 'Resource not accessible by integration' };
    for (const lost of [{ r0: { p0: null } }, null]) {
      const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => {
        if (!(req.json as { query: string }).query.includes('closingIssuesReferences')) return prResponse(req, new Map([['acme/api#1', 'MERGED']]));
        return { ok: true, status: 200, data: { data: lost, errors: [error] } };
      };
      const t = setup({ tabs: [prTab(1)], fetch });
      await t.svc.refresh('alarm');
      expect(t.fetch).toHaveBeenCalledTimes(2);
      expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', stale: false, data: { state: 'merged' } });
      expect(t.svc.missingIssuesPermission()).toBe(true);
      expect(t.svc.unreadableRepos()).toEqual([]);
    }
  });

  /** prResponse with `edit` applied to its data (PR alias -> node) and `errors` set, for closingIssuesReferences shapes. */
  const prResponseWith = (req: ApiRequest, states: Map<string, string>, edit: (r0: Record<string, unknown>) => void, errors: unknown[]): ApiResult => {
    const res = prResponse(req, states) as ApiResult & { data: { data: { r0: Record<string, unknown> }; errors?: unknown[] } };
    edit(res.data.data.r0);
    res.data.errors = errors;
    return res;
  };
  const closingQuery = (req: ApiRequest) => (req.json as { query: string }).query.includes('closingIssuesReferences');
  const refusedAt = (alias: string) => ({ type: 'FORBIDDEN', path: ['r0', alias, 'closingIssuesReferences'], message: 'Resource not accessible by integration' });

  it('only the PRs lost to a refused closingIssuesReferences are asked again: a PR read the first time keeps its closingIssues (and, merged, stays final with them)', async () => {
    const states = new Map([['acme/api#1', 'MERGED']]);
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => {
      if (!closingQuery(req)) return prResponse(req, states);
      return prResponseWith(req, states, (r0) => {
        if (r0.p0) (r0.p0 as Record<string, unknown>).closingIssuesReferences = { nodes: [{ number: 5, repository: { owner: { login: 'acme' }, name: 'web' } }] };
        if ('p1' in r0) r0.p1 = null;
      }, prsIn(req) > 1 ? [refusedAt('p1')] : []);
    };
    const rule: Rule = { ...prRule, source: { ...prSource, fields: { state: 'state', closingIssues: 'closingIssues' } } };
    const t = setup({ tabs: [prTab(1), prTab(2)], rules: [rule], fetch });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    const retry = t.fetch.mock.calls[1]![1];
    expect(closingQuery(retry)).toBe(false);
    expect(prsIn(retry)).toBe(1);
    expect((retry.json as { variables: Record<string, unknown> }).variables).toMatchObject({ k0: 2 });
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'merged', closingIssues: ['acme/web#5'] } });
    expect(stateOf(t.svc, 2)).toMatchObject({ via: 'api', data: { state: 'open' } });
    t.advance(10 * MIN);
    await t.svc.refresh('alarm'); // #1 is final: only #2 is asked for
    expect(prsIn(t.fetch.mock.calls[2]![1])).toBe(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'merged', closingIssues: ['acme/web#5'] } });
  });

  it('with data null for a refused closingIssuesReferences, every PR of the batch is asked again', async () => {
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> =>
      closingQuery(req) ? { ok: true, status: 200, data: { data: null, errors: [refusedAt('p1')] } } : prResponse(req, new Map());
    const t = setup({ tabs: [prTab(1), prTab(2), prTab(3)], fetch });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(prsIn(t.fetch.mock.calls[1]![1])).toBe(3);
    for (const id of [1, 2, 3]) expect(stateOf(t.svc, id)).toMatchObject({ via: 'api', data: { state: 'open' } });
  });

  it('a refused retry keeps the first answer\'s PRs and goes on to the next batch', async () => {
    const tabs = Array.from({ length: 51 }, (_, i) => prTab(i + 1));
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => {
      if (prsIn(req) === 1) return prResponse(req, new Map());
      return prResponseWith(req, new Map(), (r0) => { r0.p1 = null; }, [refusedAt('p1')]);
    };
    const t = setup({ tabs, fetch });
    t.canSend.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false }); // the retry is refused
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(prsIn(t.fetch.mock.calls[0]![1])).toBe(50);
    expect(prsIn(t.fetch.mock.calls[1]![1])).toBe(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'open' } });
    expect(stateOf(t.svc, 51)).toMatchObject({ via: 'api', data: { state: 'open' } });
    expect(stateOf(t.svc, 2)?.via).not.toBe('api'); // left as it was
    expect(t.svc.unreadableRepos()).toEqual([]);
  });

  it('a failed retry fails only the PRs it asked for again', async () => {
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => {
      if (!closingQuery(req)) return { ok: false, kind: 'server', message: 'boom' };
      return prResponseWith(req, new Map(), (r0) => { r0.p1 = null; }, [refusedAt('p1')]);
    };
    const t = setup({ tabs: [prTab(1), prTab(2)], fetch });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'open' } });
    expect(stateOf(t.svc, 2)).toMatchObject({ via: 'none', error: 'server' });
  });

  it('a PR read with only its closingIssuesReferences null (as GitHub documents it) is 1 POST per refresh', async () => {
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> =>
      prResponseWith(req, new Map(), (r0) => { (r0.p0 as Record<string, unknown>).closingIssuesReferences = null; }, [refusedAt('p0')]);
    const t = setup({ tabs: [prTab(1)], fetch });
    await t.svc.refresh('alarm');
    t.advance(10 * MIN);
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.fetch.mock.calls.every(([, req]) => closingQuery(req))).toBe(true);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'open' } });
  });

  it('a PR read with only its closingIssuesReferences refused is not asked again (1 POST)', async () => {
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => {
      const res = prResponse(req, new Map()) as ApiResult & { data: { data: { r0: { p0: Record<string, unknown> } }; errors?: unknown[] } };
      res.data.data.r0.p0.closingIssuesReferences = null;
      res.data.errors = [{ type: 'FORBIDDEN', path: ['r0', 'p0', 'closingIssuesReferences'], message: 'Resource not accessible by integration' }];
      return res;
    };
    const t = setup({ tabs: [prTab(1)], fetch });
    await t.svc.refresh('alarm');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'open' } });
    expect(t.svc.missingIssuesPermission()).toBe(true);
  });

  it('a PR whose closingIssuesReferences is refused sets missingIssuesPermission(); one read clears it', async () => {
    let allowed = false;
    const fetch = async (_id: string, req: ApiRequest): Promise<ApiResult> => {
      const res = prResponse(req, new Map()) as ApiResult & { data: { data: { r0: { p0: Record<string, unknown> } }; errors?: unknown[] } };
      const p0 = res.data.data.r0.p0;
      if (allowed) p0.closingIssuesReferences = { nodes: [] };
      else { p0.closingIssuesReferences = null; res.data.errors = [{ type: 'FORBIDDEN', path: ['r0', 'p0', 'closingIssuesReferences'], message: 'Resource not accessible by integration' }]; }
      return res;
    };
    const t = setup({ tabs: [prTab(1)], fetch });
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api' });
    expect(t.svc.missingIssuesPermission()).toBe(true);
    allowed = true;
    t.advance(10 * MIN);
    await t.svc.refresh('alarm');
    expect(t.svc.missingIssuesPermission()).toBe(false);
  });

  it('an issue the API cannot read reads its page; an unrecognized page is not a page result', async () => {
    const rule: Rule = { ...ghIssueRule, source: { ...ghIssueRule.source!, fallback: { adapter: 'github.issuePage' } } };
    const page = (state: string) => ({ texts: [], extracts: { 'adapter:github.issuePage.state': state }, formEdited: false });
    const run = async (state: string) => {
      const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [rule], granted: true, facts: { 1: page(state) }, fetch: async (_id, req) => issueResponse(req, ['acme/web#5']) });
      await t.svc.refresh('alarm');
      return stateOf(t.svc, 1, 'rec/ghissue');
    };
    expect(await run('Closed as not planned')).toMatchObject({ via: 'page', data: { status: 'Closed', statusCategory: 'done' } });
    expect(await run('Merged')).toMatchObject({ via: 'none', error: 'not-found' });
  });

  it('githubIssues() leaves a fresh page reading alone when the API cannot read the issue: no stale flip, no update, no request', async () => {
    const rule: Rule = { ...ghIssueRule, source: { ...ghIssueRule.source!, fallback: { adapter: 'github.issuePage' } } };
    const forbidden = async (): Promise<ApiResult> => ({ ok: true, status: 200, data: { data: { r0: { i0: null } }, errors: [{ type: 'FORBIDDEN', path: ['r0', 'i0'], message: 'Resource not accessible by integration' }] } });
    const t = setup({
      tabs: [issueTab(1, 'acme/web/issues/5')], rules: [rule], granted: true, fetch: forbidden,
      facts: { 1: { texts: [], extracts: { 'adapter:github.issuePage.state': 'Closed as completed' }, formEdited: false } },
    });
    await t.svc.refresh('alarm');
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'page', stale: false });
    const sent = t.fetch.mock.calls.length;
    t.onUpdated.mockClear();
    expect((await t.svc.githubIssues(['acme/web#5'])).get('acme/web#5')).toMatchObject({ via: 'page', stale: false, data: { statusCategory: 'done' } });
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'page', stale: false });
    expect(t.onUpdated).not.toHaveBeenCalled();
    expect(t.fetch).toHaveBeenCalledTimes(sent);
    await t.svc.refresh('tabs');
    expect(t.onUpdated).not.toHaveBeenCalled();
    // Past the TTL the API is asked again; its refusal still leaves the page reading as it is.
    t.advance(6 * MIN);
    const before = t.fetch.mock.calls.length;
    expect((await t.svc.githubIssues(['acme/web#5'])).get('acme/web#5')).toMatchObject({ via: 'page', stale: false, data: { statusCategory: 'done' } });
    expect(t.fetch).toHaveBeenCalledTimes(before + 1);
    expect(t.onUpdated).not.toHaveBeenCalled();
  });

  describe('a failed lookup backs off (#190)', () => {
    const forbidden = async (): Promise<ApiResult> => ({ ok: true, status: 200, data: { data: { r0: { i0: null } }, errors: [{ type: 'FORBIDDEN', path: ['r0', 'i0'], message: 'Resource not accessible by integration' }] } });
    const pageRule: Rule = { ...ghIssueRule, source: { ...ghIssueRule.source!, fallback: { adapter: 'github.issuePage' } } };
    const openPage = { texts: [], extracts: { 'adapter:github.issuePage.state': 'Open' }, formEdited: false };
    /** A minute of a list view polling (LIVE_MS = 5 s): `list` once per tick; the requests sent. */
    async function minuteOfPolling(t: ReturnType<typeof setup>, list: () => Promise<unknown>) {
      const before = t.fetch.mock.calls.length;
      for (let i = 0; i < 12; i++) { await list(); t.advance(5000); }
      return t.fetch.mock.calls.length - before;
    }

    it('a found issue is asked once a minute of polling', async () => {
      const t = setup({ fetch: async (_id, req) => issueResponse(req) });
      expect(await minuteOfPolling(t, () => t.svc.githubIssues(['acme/web#5']))).toBe(1);
    });

    it('an issue the API cannot find is asked once, not on every listing', async () => {
      const t = setup({ fetch: async (_id, req) => issueResponse(req, ['acme/web#9']) });
      expect(await minuteOfPolling(t, () => t.svc.githubIssues(['acme/web#9']))).toBe(1);
      const e = (await t.svc.githubIssues(['acme/web#9'])).get('acme/web#9');
      expect(e).toMatchObject({ via: 'none', error: 'not-found' });
      expect(e).not.toHaveProperty('triedAt');
    });

    it('an issue the API refuses (no Issues permission) is asked once, and again after the window', async () => {
      const t = setup({ fetch: forbidden });
      expect(await minuteOfPolling(t, () => t.svc.githubIssues(['acme/web#5']))).toBe(1);
      expect(t.svc.missingIssuesPermission()).toBe(true);
      t.advance(5 * MIN);
      expect(await minuteOfPolling(t, () => t.svc.githubIssues(['acme/web#5']))).toBe(1);
    });

    it('a refused issue with a page reading older than the window is asked once per window, and the reading does not flap', async () => {
      const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [pageRule], granted: true, fetch: forbidden, facts: { 1: openPage } });
      await t.svc.refresh('alarm');
      t.advance(6 * MIN);
      t.onUpdated.mockClear();
      expect(await minuteOfPolling(t, () => t.svc.githubIssues(['acme/web#5']))).toBe(1);
      expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'page', stale: false });
      expect(stateOf(t.svc, 1, 'rec/ghissue')).not.toHaveProperty('triedAt');
      expect(t.onUpdated).not.toHaveBeenCalled();
    });

    it("#198: with 'check every' at 1 min, the back-off follows that window", async () => {
      const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [pageRule], granted: true, fetch: forbidden, facts: { 1: openPage }, refreshEvery: { 'merged-prs': '1m' } });
      await t.svc.refresh('alarm');
      t.advance(MIN);
      expect(await minuteOfPolling(t, () => t.svc.githubIssues(['acme/web#5']))).toBe(2); // 55 s apart
    });

    it('a connection change clears the back-off: the next listing asks at once', async () => {
      let missing = ['acme/web#9'];
      const t = setup({ fetch: async (_id, req) => issueResponse(req, missing) });
      await t.svc.githubIssues(['acme/web#9']);
      t.advance(5000);
      await t.svc.githubIssues(['acme/web#9']);
      expect(t.fetch).toHaveBeenCalledTimes(1);
      missing = [];
      await t.svc.connectionChanged('github');
      t.advance(5000);
      expect((await t.svc.githubIssues(['acme/web#9'])).get('acme/web#9')).toMatchObject({ via: 'api' });
      expect(t.fetch).toHaveBeenCalledTimes(2);
    });

    it("another connection's change leaves the back-off alone", async () => {
      const t = setup({ fetch: async (_id, req) => issueResponse(req, ['acme/web#9']) });
      await t.svc.githubIssues(['acme/web#9']);
      await t.svc.connectionChanged('jira');
      t.advance(5000);
      await t.svc.githubIssues(['acme/web#9']);
      expect(t.fetch).toHaveBeenCalledTimes(1);
    });

    // In the extension a worker start re-emits every connection, which clears the back-off (connectionChanged); this
    // pins only that the stamp itself is stored with the entry.
    it('the back-off is stored with the entry (a new SourceService reads it)', async () => {
      const t = setup({ fetch: async (_id, req) => issueResponse(req, ['acme/web#9']) });
      await t.svc.githubIssues(['acme/web#9']);
      t.advance(5000);
      await t.make().githubIssues(['acme/web#9']);
      expect(t.fetch).toHaveBeenCalledTimes(1);
    });

    it('the tab path still asks a failed issue on its own schedule, and the alarm does not rewrite an unchanged failure', async () => {
      const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [ghIssueRule], fetch: async (_id, req) => issueResponse(req, ['acme/web#5']) });
      await t.svc.githubIssues(['acme/web#5']);
      t.advance(MIN);
      await t.svc.refresh('alarm');
      expect(t.fetch).toHaveBeenCalledTimes(2);
      t.local.set.mockClear();
      t.advance(MIN);
      await t.svc.refresh('alarm');
      expect(t.fetch).toHaveBeenCalledTimes(3);
      expect(t.local.set).not.toHaveBeenCalled();
    });
  });

  it('with the connection not ok, an issue tab sends nothing and is via none', async () => {
    const t = setup({ tabs: [issueTab(1, 'acme/web/issues/5')], rules: [ghIssueRule], conn: { github: 'not-configured' }, fetch: async (_id, req) => issueResponse(req) });
    await t.svc.refresh('alarm');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'none', error: 'not-configured' });
    expect((await t.svc.githubIssues(['acme/web#5'])).get('acme/web#5')).toMatchObject({ via: 'none' });
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe('SourceService: a page showing a change refetches a fresh API entry', () => {
  const ISSUE: Rule = {
    id: 'ghissue', name: 'GitHub issue', enabled: true,
    source: { connection: 'github', query: 'github.issue', args: { owner: '{owner}', repo: '{repo}', number: '{num}' }, fields: { status: 'status', statusCategory: 'statusCategory', summary: 'summary' }, fallback: { adapter: 'github.issuePage' } },
    match: { url: 'github.com/:owner/:repo/issues/:num*' }, actions: [{ group: { title: 'Issues', color: 'green' } }],
  };
  /** The issue on GitHub: OPEN until `closed.v` flips. */
  const ghIssueApi = (closed: { v: boolean }) => async (_id: string, req: ApiRequest): Promise<ApiResult> => {
    const { query } = req.json as { query: string };
    const data: Record<string, Record<string, unknown>> = {};
    for (const m of query.matchAll(/(r\d+): repository\(owner: \$o\d+, name: \$n\d+\) \{ (i\d+): issue/g)) {
      data[m[1]!] = { [m[2]!]: { title: 'Fix signup form', state: closed.v ? 'CLOSED' : 'OPEN', stateReason: closed.v ? 'COMPLETED' : null, url: 'https://github.com/acme/web/issues/3', closedByPullRequestsReferences: { nodes: [] } } };
    }
    return { ok: true, status: 200, data: { data } };
  };
  const issuePage = (state: string) => ({ texts: [], extracts: { 'adapter:github.issuePage.state': state }, formEdited: false });
  const KEY = 'acme/web#3';
  const URL3 = 'https://github.com/acme/web/issues/3';

  async function opened(o: Partial<Setup> = {}) {
    const closed = { v: false };
    const facts: Record<number, NonNullable<TabFacts['page']>> = { 1: issuePage('Open') };
    const t = setup({ tabs: [tab(1, URL3)], rules: [ISSUE], granted: true, facts, fetch: ghIssueApi(closed), ...o });
    await t.svc.refresh('tabs');
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api', data: { statusCategory: 'new' } });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.advance(MIN);
    return { t, closed, facts };
  }

  it('closed in-page: the next refresh(tabs) asks the API again and the issue is Closed (one extra request)', async () => {
    const { t, closed, facts } = await opened();
    closed.v = true; facts[1] = issuePage('Closed');
    t.onUpdated.mockClear();
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api', data: { status: 'Closed', statusCategory: 'done' } });
    expect((await t.svc.githubIssues([KEY])).get(KEY)).toMatchObject({ via: 'api', data: { statusCategory: 'done' } });
    expect(t.onUpdated).toHaveBeenCalledWith([1]);
    // The page keeps reporting Closed: it agrees now, nothing more is asked.
    await t.svc.refresh('tabs');
    await t.svc.refresh('popup');
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it('reopened in-page: Open again at the next refresh(tabs)', async () => {
    const { t, closed, facts } = await opened();
    closed.v = true; facts[1] = issuePage('Closed');
    await t.svc.refresh('tabs');
    t.advance(MIN);
    closed.v = false; facts[1] = issuePage('Open');
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(3);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api', data: { status: 'Open', statusCategory: 'new' } });
  });

  it('a page that agrees with the API asks nothing', async () => {
    const { t } = await opened();
    for (let i = 0; i < 3; i++) await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('the API still answering as before (a page ahead or misread): one request per page reading, no loop', async () => {
    const { t, facts } = await opened();
    facts[1] = issuePage('Closed'); // GitHub's API still says OPEN
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api', data: { statusCategory: 'new' } }); // the API stays the authority
    for (let i = 0; i < 3; i++) await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    // Past the TTL the entry is due as usual.
    t.advance(5 * MIN);
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(3);
  });

  it('two tabs of the issue reporting the same change: one request', async () => {
    const closed = { v: false };
    const facts: Record<number, NonNullable<TabFacts['page']>> = { 1: issuePage('Open'), 2: issuePage('Open') };
    const t = setup({ tabs: [tab(1, URL3), tab(2, URL3)], rules: [ISSUE], granted: true, facts, fetch: ghIssueApi(closed) });
    await t.svc.refresh('tabs');
    t.advance(MIN);
    closed.v = true; facts[1] = issuePage('Closed'); facts[2] = issuePage('Closed');
    await t.svc.refresh('tabs');
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    for (const id of [1, 2]) expect(stateOf(t.svc, id, 'rec/ghissue')).toMatchObject({ data: { statusCategory: 'done' } });
  });

  it('the background budget refusing: nothing sent and nothing changes; the next refresh asks once it allows', async () => {
    let allow = true;
    const { t, closed, facts } = await opened();
    t.canSend.mockImplementation(async () => ({ ok: allow }));
    closed.v = true; facts[1] = issuePage('Closed');
    allow = false;
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ via: 'api', stale: false, data: { statusCategory: 'new' } });
    allow = true;
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(stateOf(t.svc, 1, 'rec/ghissue')).toMatchObject({ data: { statusCategory: 'done' } });
  });

  it('without page access (github.com not granted) the page is not read and nothing is asked', async () => {
    const { t, closed, facts } = await opened({ granted: false });
    closed.v = true; facts[1] = issuePage('Closed');
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('Jira: a ticket moved to Done in-page is Done at the next refresh(tabs)', async () => {
    const done = { v: false };
    const fetch = vi.fn(async (): Promise<ApiResult> => ({ ok: true, status: 200, data: { issues: [{ key: 'ABC-1', fields: { summary: 's', status: { name: done.v ? 'Done' : 'To Do', statusCategory: { key: done.v ? 'done' : 'new' } } } }] } }));
    const jiraPage = (status: string) => ({ texts: [], extracts: { 'adapter:jira.issuePage.status': status }, formEdited: false });
    const facts: Record<number, NonNullable<TabFacts['page']>> = { 1: jiraPage('To Do') };
    const t = setup({ tabs: [tab(1, 'https://acme.atlassian.net/browse/ABC-1')], rules: [issueRule], granted: true, facts, fetch });
    await t.svc.refresh('tabs');
    t.advance(MIN);
    facts[1] = jiraPage('TO DO'); // the same status, as the page writes it: agrees
    await t.svc.refresh('tabs');
    expect(fetch).toHaveBeenCalledTimes(1);
    done.v = true; facts[1] = jiraPage('Done');
    await t.svc.refresh('tabs');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stateOf(t.svc, 1, 'rec/issue')).toMatchObject({ via: 'api', data: { status: 'Done', cat: 'done' } });
    expect((await t.svc.issues(['ABC-1'])).get('ABC-1')).toMatchObject({ data: { statusCategory: 'done' } });
  });

  it('PR: a PR closed in-page is closed at the next refresh(tabs); a merged (final) PR is never asked again', async () => {
    const states = new Map<string, string>();
    const prPage = (state: string) => ({ texts: [], extracts: { 'adapter:github.prPage.state': state }, formEdited: false });
    const facts: Record<number, NonNullable<TabFacts['page']>> = { 1: prPage('Open') };
    const t = setup({ tabs: [prTab(1)], granted: true, facts, states });
    await t.svc.refresh('tabs');
    t.advance(MIN);
    states.set('acme/api#1', 'CLOSED'); facts[1] = prPage('Closed');
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', data: { state: 'closed' } });
    t.advance(MIN);
    states.set('acme/api#1', 'MERGED'); facts[1] = prPage('Merged');
    await t.svc.refresh('tabs');
    expect(stateOf(t.svc, 1)).toMatchObject({ via: 'api', final: true, data: { state: 'merged' } });
    t.advance(MIN);
    facts[1] = prPage('Open'); // a final entry stays as it is
    await t.svc.refresh('tabs');
    expect(t.fetch).toHaveBeenCalledTimes(3);
  });
});
