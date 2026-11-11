// #192: turning on a recipe whose rule reads source facts looks them up for already-open tabs at once, not at the next
// source refresh (a reload, a tab event, the popup or the 5-minute alarm). Wired as background.ts wires them: real
// ProgramCache + PermissionsManager (onKindsChanged → sources.refresh) + SourceService + ProjectService + Reconciler.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultConfig } from '../../src/core/config/defaults';
import { compileProgram } from '../../src/core/lang/compile';
import { ProjectService, ProjectStore } from '../../src/engine/projects';
import { PermissionsManager } from '../../src/engine/permissions';
import { ProgramCache } from '../../src/engine/program-cache';
import { Reconciler } from '../../src/engine/reconciler';
import { SourceService } from '../../src/engine/sources';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { ApiRequest, ApiResult, ConnectionDef } from '../../src/core/connections/types';
import type { Config } from '../../src/core/types';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const GITHUB: ConnectionDef = {
  id: 'github', kind: 'github', label: 'GitHub', baseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com',
  hosts: ['https://github.com/*', 'https://api.github.com/*'], auth: 'token', scopes: [],
};
const PR = 'https://github.com/acme/web/pull/1';

/** A GraphQL answer for every pull request asked for, on branch `head`. */
function gql(req: ApiRequest, head: string): ApiResult {
  const { query, variables } = req.json as { query: string; variables: Record<string, unknown> };
  const data: Record<string, Record<string, unknown>> = {};
  let repo = '';
  let rk = '';
  for (const m of query.matchAll(/(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\)|(p\d+): pullRequest\(number: \$(k\d+)\)/g)) {
    if (m[1]) { repo = m[1]; rk = `${String(variables[m[2]!])}/${String(variables[m[3]!])}`; data[repo] = {}; continue; }
    data[repo]![m[4]!] = {
      state: 'OPEN', merged: false, mergedAt: null, isDraft: false, title: 'Login', headRefName: head, reviewDecision: null,
      url: `https://github.com/${rk}/pull/${String(variables[m[5]!])}`,
    };
  }
  return { ok: true, status: 200, data: { data } };
}

const area = () => {
  const d = new Map<string, unknown>();
  return {
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => d.has(x)).map((x) => [x, structuredClone(d.get(x))]))),
    set: vi.fn(async (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) d.set(k, structuredClone(v)); }),
    remove: vi.fn(async () => {}),
  };
};

/** github-prs' repo group on, ranked below every other rule; `on`: recipes enabled on top of the defaults. */
function cfgWith(on: string[], params: Record<string, Record<string, unknown>> = {}): Config {
  const c: Config = {
    ...defaultConfig(),
    recipes: defaultConfig().recipes.map((r) => ({
      ...r,
      ...(r.id === 'github-prs' && { ruleEnabled: { 'group-by-repo': true } }),
      ...(on.includes(r.id) && { enabled: true }),
      ...(params[r.id] && { params: params[r.id] }),
    })),
  };
  const keys = compileProgram(c, builtinRecipes()).program.rules.map((x) => x.key);
  return { ...c, order: [...keys.filter((k) => k !== 'github-prs/group-by-repo'), 'github-prs/group-by-repo'] };
}

async function world(cfg0: Config, head: string) {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  for (const g of ['https://github.com/*', 'https://api.github.com/*', 'scripting']) port.granted.add(g);
  port.addTab({ id: 1, windowId: 1, url: PR, title: 'Login by ecoutu · Pull Request #1 · acme/web · GitHub', pinned: false, incognito: false, discarded: false, active: false, audible: false });
  const box = { cfg: cfg0 };
  const holder: { pm?: PermissionsManager; sources?: SourceService } = {};
  const programs = new ProgramCache(async () => box.cfg, { builtins: builtinRecipes(), paused: () => holder.pm?.paused() ?? [], warn: () => {} });
  const getProgram = () => programs.get();
  const refreshes: Promise<void>[] = [];
  const pm = new PermissionsManager(port, getProgram, { register: async () => [], unregister: async () => [], inject: async () => {} }, {
    connections: async () => [{ id: 'github', label: 'GitHub', state: 'ok' }],
    onKindsChanged: (keys) => { refreshes.push(holder.sources!.refresh('manual', keys)); }, // as background.ts
  });
  holder.pm = pm;
  await pm.onChanged();
  // eslint-disable-next-line prefer-const
  let r: Reconciler;
  const sources = new SourceService({
    conn: { fetch: vi.fn(async (_id: string, req: ApiRequest) => gql(req, head)), status: async () => [{ id: 'github', state: 'ok', ssoRequired: [], scopes: [] }], defs: async () => [GITHUB] },
    limiter: { canSend: async () => ({ ok: true }) },
    getProgram, levelFor: (...a) => pm.levelFor(...a),
    port: { snapshot: () => port.snapshot(), hasPermission: (q) => port.hasPermission(q) },
    facts: { get: () => undefined }, local: area(), now: () => NOW,
    onUpdated: () => { r.schedule('sourceUpdated'); },
  } as ConstructorParameters<typeof SourceService>[0]);
  holder.sources = sources;
  const projects = new ProjectService({
    store: new ProjectStore(area()), port, getProgram, sources, facts: { get: () => undefined }, log: { add: () => {} },
    recentlyClosed: { add: () => 'rc' }, safety: { isProtected: (x) => x.pinned }, state: () => r.liveState(), now: () => NOW,
  });
  r = new Reconciler(port, getProgram, { projects, sources, now: () => NOW });
  const prGroup = () => port.state.groups.find((g) => g.id === port.state.tabs.find((x) => x.id === 1)?.groupId)?.title;
  /** What store.onChange does: re-plan and sync permissions; any source lookup comes from onKindsChanged alone. */
  const setConfig = async (c: Config) => { box.cfg = c; await pm.onChanged(); await Promise.all(refreshes); await r.flush(); };
  await sources.refresh('alarm'); // the worker's earlier refreshes, under cfg0
  await r.flush();
  return { prGroup, setConfig };
}

describe('#192: enabling a recipe with a pull request tab already open', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('jira-ticket-branch: a PR on branch feature/SCRUM-1-login joins SCRUM-1 on the config change, without a reload', async () => {
    const w = await world(cfgWith([]), 'feature/SCRUM-1-login');
    expect(w.prGroup()).toBe('web');
    await w.setConfig(cfgWith(['jira-ticket-branch'], { 'jira-ticket-branch': { projectPrefixes: ['SCRUM'] } }));
    expect(w.prGroup()).toBe('SCRUM-1');
  });
});
