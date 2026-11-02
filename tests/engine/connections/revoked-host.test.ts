// Final review IMPORTANT 2: a connection whose host access was revoked is unusable end to end — its status is
// not-configured with the missing host as the reason, its rules drop below the connection level, and SourceService
// reads the page fallback instead of sending every request to an API that answers not-configured.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { SecretStore } from '../../../src/engine/connections/secret-store';
import { RateLimiter } from '../../../src/engine/connections/rate-limiter';
import { ConnectionManager, type AuthProvider } from '../../../src/engine/connections/manager';
import { PermissionsManager, type WatchScripting } from '../../../src/engine/permissions';
import { ProgramCache } from '../../../src/engine/program-cache';
import { SourceService } from '../../../src/engine/sources';
import { builtinConnectionDefs } from '../../../src/core/connections/builtin';
import { defaultConfig } from '../../../src/core/config/defaults';
import { FakeBrowserPort } from '../../../src/platform/fake-port';
import type { AuthStyle } from '../../../src/core/connections/types';
import type { Recipe, RecipeRef } from '../../../src/core/lang/types';
import type { Config } from '../../../src/core/types';

const GH = 'https://github.com/*';
const API = 'https://api.github.com/*';
const recipe: Recipe = {
  recipe: 'prs', version: 1, name: 'prs', description: 'prs',
  rules: [{
    id: 'pr', name: 'PR', enabled: true,
    source: {
      connection: 'github', query: 'github.pull_request', args: { owner: '{owner}', repo: '{repo}', number: '{num}' },
      fields: { state: 'state' }, fallback: { adapter: 'github.prPage' },
    },
    match: { url: 'github.com/:owner/:repo/pull/:num' },
    actions: [{ group: { title: 'PRs', color: 'blue' } }],
    needs: { anyOf: [{ connections: ['github'] }, { hosts: [GH] }, {}] },
  }],
};
const merged = { texts: [], extracts: { 'adapter:github.prPage.state': 'Status: Merged' }, formEdited: false };

function rig() {
  const port = new FakeBrowserPort();
  port.addWindow(1);
  const tab = port.addTab({
    id: 1, windowId: 1, url: 'https://github.com/acme/api/pull/1', title: 'PR', pinned: false, incognito: false,
    discarded: false, active: true, audible: false,
  });
  port.granted.add(GH).add(API).add('scripting');
  const secrets = new SecretStore({ local: browser.storage.local, session: browser.storage.session });
  const provider: AuthProvider = { headers: async () => ({ Authorization: 'Bearer gho_token_value_123' }) };
  const auth = { 'device-code': provider, token: provider, session: provider, 'oauth-pkce': provider, 'oauth-proxy': provider } satisfies Record<AuthStyle, AuthProvider>;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 200 }));
  const conn = new ConnectionManager({
    local: browser.storage.local, session: browser.storage.session, secrets,
    limiter: new RateLimiter(browser.storage.session), port, fetch, auth,
  });
  const refs: RecipeRef[] = [{ id: 'prs', enabled: true, params: {}, source: 'builtin' }];
  const cfg: Config = { ...defaultConfig(), recipes: refs };
  const holder: { pm?: PermissionsManager } = {};
  const programs = new ProgramCache(async () => cfg, { builtins: { prs: recipe }, paused: () => holder.pm?.paused() ?? [], warn: () => {} });
  const scripting: WatchScripting = { register: async () => [], unregister: async () => [], inject: async () => {} };
  const pm = new PermissionsManager(port, () => programs.get(), scripting, {
    onPausedChanged: () => {},
    connections: async () => (await conn.status()).map((s) => ({ id: s.id, label: 'GitHub', state: s.state })),
  });
  holder.pm = pm;
  conn.onStatusChange(() => { void pm.onChanged(); });
  const svc = new SourceService({
    conn, getProgram: () => programs.get(), levelFor: (k) => pm.levelFor(k), port,
    facts: { get: (id) => (id === tab.id ? merged : undefined) },
    local: { get: async () => ({}), set: async () => {} },
    onUpdated: () => {},
  });
  return { port, conn, pm, svc, fetch, secrets, tabId: tab.id };
}

describe('revoked connection host access', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('status not-configured with the reason, the level drops, SourceService reads the page; re-granting restores ok', async () => {
    const r = rig();
    await r.conn.save({ ...builtinConnectionDefs().github, auth: 'token' });
    await r.secrets.setSecret('github', { token: 'ghp_stored_token_value' });
    await r.pm.onChanged();
    expect((await r.conn.status('github'))[0]!.state).toBe('ok');
    expect(await r.pm.levelFor('prs/pr')).toBe('connection');

    r.port.granted.delete(API); // chrome://extensions: api.github.com revoked, github.com kept
    const changes: string[] = [];
    r.conn.onStatusChange((s) => changes.push(s.state));
    await r.conn.permissionsChanged();
    expect(changes).toEqual(['not-configured']);
    expect((await r.conn.status('github'))[0]).toMatchObject({ state: 'not-configured', hostsMissing: [API] });
    await r.pm.onChanged();
    expect(await r.pm.levelFor('prs/pr')).toBe('page');

    await r.svc.refresh('alarm');
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.svc.factsFor(r.tabId)?.['prs/pr']).toMatchObject({ via: 'page', data: { state: 'merged' }, stale: false });

    r.port.granted.add(API);
    await r.conn.permissionsChanged();
    expect(changes.at(-1)).toBe('ok');
    await r.pm.onChanged();
    expect(await r.pm.levelFor('prs/pr')).toBe('connection');
  });
});
