// Capability levels at work (#30, M3 residuals): the level kind of an off-site ticket tab. PermissionsManager +
// ProgramCache over the real jira-ticket-either recipe.
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config/defaults';
import { PermissionsManager } from '../../src/engine/permissions';
import { ProgramCache } from '../../src/engine/program-cache';
import { SourceService } from '../../src/engine/sources';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { ApiResult, ConnectionDef, ConnectionState } from '../../src/core/connections/types';
import type { Config, Snapshot, TabSnap } from '../../src/core/types';

const RID = 'jira-ticket-either';
const NOW = Date.parse('2026-11-02T10:00:00Z');
const OTHER = 'https://other.atlassian.net/browse/ABC-1';
const DEFS: ConnectionDef[] = [
  {
    id: 'github', kind: 'github', label: 'GitHub', baseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com',
    hosts: ['https://github.com/*', 'https://api.github.com/*'], auth: 'token', scopes: [],
  },
  {
    id: 'jira', kind: 'jira', label: 'Jira', baseUrl: 'https://acme.atlassian.net', apiBaseUrl: 'https://acme.atlassian.net',
    hosts: ['https://acme.atlassian.net/*'], auth: 'token', scopes: [], jira: { site: 'acme.atlassian.net', tokenKind: 'classic' },
  },
];

const tab = (id: number, url: string, title: string): TabSnap => ({
  id, windowId: 1, index: id, url, title, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false,
});

/** The either recipe enabled, a PermissionsManager over it, and a SourceService reading its levels. */
async function setup(conn: Record<string, ConnectionState>, tabs: TabSnap[], fetch: (connection: string) => Promise<ApiResult> = async () => ({ ok: true, status: 200, data: { issues: [] } })) {
  const port = new FakeBrowserPort();
  const cfg: Config = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === RID ? { ...r, enabled: true } : r)) };
  const holder: { pm?: PermissionsManager } = {};
  const programs = new ProgramCache(async () => cfg, { builtins: builtinRecipes(), paused: () => holder.pm?.paused() ?? [], warn: () => {} });
  const pm = new PermissionsManager(port, () => programs.get(), { register: async () => [], unregister: async () => [], inject: async () => {} }, {
    connections: async () => ['github', 'jira'].map((c) => ({ id: c, label: c, state: conn[c] ?? 'not-configured' })),
  });
  holder.pm = pm;
  const snap: Snapshot = { tabs, groups: [], windows: [{ id: 1, type: 'normal', focused: true }] };
  const fetchFn = vi.fn(async (connection: string) => fetch(connection));
  const svc = new SourceService({
    conn: {
      fetch: fetchFn,
      status: async () => Object.entries(conn).map(([id, state]) => ({ id, state, ssoRequired: [], scopes: [] })),
      defs: async () => DEFS,
    },
    getProgram: () => programs.get(), levelFor: (k, without) => pm.levelFor(k, without),
    port: { snapshot: async () => structuredClone(snap), hasPermission: (q) => port.hasPermission(q) },
    facts: { get: () => undefined }, local: { get: async () => ({}), set: async () => {} }, now: () => NOW, onUpdated: () => {},
  });
  await pm.onChanged();
  return { port, pm, svc, fetch: fetchFn };
}

describe('#30: the level kind of an off-site ticket tab', () => {
  it('off-site ticket tab without a page read is not not-configured: its level kind is titles (the connection serves its own site only)', async () => {
    const t = await setup({ jira: 'ok' }, [tab(1, OTHER, '[ABC-1] Their ticket - Jira')]);
    expect(await t.pm.levelFor(`${RID}/ticket`)).toBe('connection');
    expect(await t.pm.levelFor(`${RID}/ticket`, ['jira'])).toBe('titles');
    const spy = vi.spyOn(t.pm, 'levelFor');
    t.port.calls.length = 0;
    await t.svc.refresh('manual');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(`${RID}/ticket`, ['jira']);
    expect(t.port.calls.filter((c) => c.method === 'hasPermission')).toEqual([]); // titles: the page is never read
    // M4-R3: the connection cannot see that ticket (as for an unreadable PR repo): not-found, never not-configured.
    expect(t.svc.factsFor(1)?.[`${RID}/ticket`]).toMatchObject({ via: 'none', error: 'not-found' });
  });

  it('with the Jira host granted the off-site ticket tab runs at page level (its page may be read)', async () => {
    const t = await setup({ jira: 'ok' }, [tab(1, OTHER, '[ABC-1] Their ticket - Jira')]);
    t.port.granted.add('https://*.atlassian.net/*');
    t.port.granted.add('scripting');
    await t.pm.onChanged();
    expect(await t.pm.levelFor(`${RID}/ticket`, ['jira'])).toBe('page');
    expect(await t.pm.levelFor(`${RID}/ticket`)).toBe('connection');
  });
});
