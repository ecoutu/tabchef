import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { SecretStore } from '../../../src/engine/connections/secret-store';
import { RateLimiter } from '../../../src/engine/connections/rate-limiter';
import { ConnectionManager } from '../../../src/engine/connections/manager';
import { TokenAuth, setGitHubToken } from '../../../src/engine/connections/token-auth';
import { builtinConnectionDefs } from '../../../src/core/connections/builtin';
import type { AuthStyle } from '../../../src/core/connections/types';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
type FetchFn = typeof fetch;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function rig(opts: { fetch?: FetchFn; granted?: boolean } = {}) {
  const secrets = new SecretStore({ local: browser.storage.local, session: browser.storage.session });
  const f = vi.fn<FetchFn>(opts.fetch ?? (async () => json(200, { login: 'octo' }, { 'x-oauth-scopes': 'repo, read:org' })));
  const port = { hasPermission: vi.fn(async () => opts.granted ?? true) };
  const p = new TokenAuth();
  const auth = { 'device-code': p, token: p, session: p, 'oauth-pkce': p, 'oauth-proxy': p } satisfies Record<AuthStyle, TokenAuth>;
  const manager = new ConnectionManager({
    local: browser.storage.local, session: browser.storage.session, secrets,
    limiter: new RateLimiter(browser.storage.session), port, fetch: f, auth,
  });
  return { manager, secrets, fetch: f, port, deps: { manager, secrets, port, fetch: f } };
}

describe('setGitHubToken', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('validates with GET /user, stores only the secret, saves the def with auth token', async () => {
    const r = rig();
    await r.manager.save(builtinConnectionDefs().github);
    const res = await r.deps.manager.defs();
    expect(res[0]!.auth).toBe('device-code');
    const out = await setGitHubToken(r.deps, `  ${TOKEN}\n`);
    expect(out).toMatchObject({ ok: true, login: 'octo' });
    const [url, init] = r.fetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/user');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init!.credentials).toBe('omit');
    const local = await browser.storage.local.get(null);
    expect(local['conn.secret.github']).toEqual({ token: TOKEN });
    const def = (await r.manager.defs())[0]!;
    expect(def).toMatchObject({ auth: 'token', login: 'octo', scopes: ['repo', 'read:org'], apiBaseUrl: 'https://api.github.com' });
    expect(JSON.stringify(await browser.storage.local.get('connections'))).not.toContain(TOKEN);
    expect(JSON.stringify(await browser.storage.session.get(null))).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('fine-grained PATs send no scopes header: scopes empty', async () => {
    const r = rig({ fetch: async () => json(200, { login: 'octo' }) });
    const out = await setGitHubToken(r.deps, TOKEN);
    expect(out.ok && out.status.scopes).toEqual([]);
  });

  it('401 and 403: error without the token, nothing stored, def unchanged', async () => {
    for (const status of [401, 403]) {
      fakeBrowser.reset();
      const r = rig({ fetch: async () => json(status, { message: `bad credentials ${TOKEN}` }) });
      await r.manager.save(builtinConnectionDefs().github);
      const out = await setGitHubToken(r.deps, TOKEN);
      expect(out).toEqual({ ok: false, error: `GitHub rejected this token (${status})` });
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect((await browser.storage.local.get(null))['conn.secret.github']).toBeUndefined();
      expect((await r.manager.defs())[0]!.auth).toBe('device-code');
    }
  });

  it('empty, whitespace or control characters: no network call', async () => {
    const r = rig();
    for (const t of ['', '   ', 'ghp a b', 'ghp\u0000x', 'ghp\nx']) {
      const out = await setGitHubToken(r.deps, t);
      expect(out.ok).toBe(false);
    }
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.port.hasPermission).not.toHaveBeenCalled();
  });

  it('missing host permission: no network call, error names github.com', async () => {
    const r = rig({ granted: false });
    const out = await setGitHubToken(r.deps, TOKEN);
    expect(out).toMatchObject({ ok: false });
    expect(!out.ok && out.error).toContain('github.com');
    expect(r.fetch).not.toHaveBeenCalled();
    expect((await browser.storage.local.get(null))['conn.secret.github']).toBeUndefined();
    expect(await r.manager.defs()).toEqual([]);
  });

  it('network error: redacted message, nothing stored', async () => {
    const r = rig({ fetch: async () => { throw new Error(`socket closed for ${TOKEN}`); } });
    const out = await setGitHubToken(r.deps, TOKEN);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect((await browser.storage.local.get(null))['conn.secret.github']).toBeUndefined();
  });

  it('rate limit and server errors store nothing', async () => {
    for (const res of [json(429, {}), json(403, {}, { 'x-ratelimit-remaining': '0' }), json(500, { m: TOKEN })]) {
      fakeBrowser.reset();
      const r = rig({ fetch: async () => res.clone() });
      const out = await setGitHubToken(r.deps, TOKEN);
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect((await browser.storage.local.get(null))['conn.secret.github']).toBeUndefined();
    }
  });

  it('timeout aborts the request and stores nothing', async () => {
    vi.useFakeTimers();
    try {
      const r = rig({ fetch: (_u, init) => new Promise((_res, rej) => { init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))); }) });
      const p = setGitHubToken(r.deps, TOKEN);
      await vi.advanceTimersByTimeAsync(15_001);
      const out = await p;
      expect(out.ok).toBe(false);
      expect((await browser.storage.local.get(null))['conn.secret.github']).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('through the manager: later fetch sends Bearer; a 401 then needs re-auth (no refresh)', async () => {
    const r = rig();
    await setGitHubToken(r.deps, TOKEN);
    r.fetch.mockClear();
    r.fetch.mockImplementation(async () => json(200, { ok: 1 }));
    expect((await r.manager.fetch('github', { method: 'GET', path: '/user' })).ok).toBe(true);
    expect((r.fetch.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    r.fetch.mockImplementation(async () => json(401, { message: 'Bad credentials' }));
    const bad = await r.manager.fetch('github', { method: 'GET', path: '/user' });
    expect(bad).toMatchObject({ ok: false, kind: 'unauthorized' });
    expect(r.fetch).toHaveBeenCalledTimes(2);
    expect((await r.manager.status('github'))[0]!.state).toBe('needs-reauth');
  });

  it('re-entering a token clears needs-reauth', async () => {
    const r = rig();
    await setGitHubToken(r.deps, TOKEN);
    r.fetch.mockImplementation(async () => json(401, {}));
    await r.manager.fetch('github', { method: 'GET', path: '/user' });
    r.fetch.mockImplementation(async () => json(200, { login: 'octo' }));
    const out = await setGitHubToken(r.deps, `${TOKEN}2`);
    expect(out.ok && out.status.state).toBe('ok');
  });

  it('replaces a device-flow connection, including its access token', async () => {
    const r = rig();
    await r.manager.save(builtinConnectionDefs().github);
    await r.secrets.setAccess('github', { token: 'gho_access_token_value' });
    await setGitHubToken(r.deps, TOKEN);
    expect(await r.secrets.getAccess('github')).toBeUndefined();
    expect((await r.manager.defs())[0]!.auth).toBe('token');
  });
});

describe('setGitHubToken hardening', () => {
  beforeEach(() => { vi.restoreAllMocks(); fakeBrowser.reset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  const OLD = 'gho_old_working_token_value';
  async function withOld(r: ReturnType<typeof rig>) {
    await r.manager.save(builtinConnectionDefs().github);
    await r.secrets.setSecret('github', { token: OLD });
    await r.secrets.setAccess('github', { token: 'gho_old_access' });
  }

  it('secret write failure keeps the previous secret, access token and def', async () => {
    const r = rig();
    await withOld(r);
    const orig = browser.storage.local.set.bind(browser.storage.local);
    vi.spyOn(browser.storage.local, 'set').mockImplementation(async (items: Record<string, unknown>) => {
      if ('conn.secret.github' in items && (items['conn.secret.github'] as { token: string }).token === TOKEN) throw new Error('quota');
      return orig(items);
    });
    const out = await setGitHubToken(r.deps, TOKEN);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain('previous connection was kept');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(await r.secrets.getSecret('github')).toEqual({ token: OLD });
    expect(await r.secrets.getAccess('github')).toEqual({ token: 'gho_old_access' });
    expect((await r.manager.defs())[0]!.auth).toBe('device-code');
  });

  it('save failure rolls back the secret and keeps the def', async () => {
    const r = rig();
    await withOld(r);
    vi.spyOn(r.manager, 'save').mockRejectedValueOnce(new Error('disk'));
    const out = await setGitHubToken(r.deps, TOKEN);
    expect(!out.ok && out.error).toContain('previous connection was kept');
    expect(await r.secrets.getSecret('github')).toEqual({ token: OLD });
    expect(await r.secrets.getAccess('github')).toEqual({ token: 'gho_old_access' });
    expect((await r.manager.defs())[0]!.auth).toBe('device-code');
  });

  it('save failure with no previous connection leaves nothing stored', async () => {
    const r = rig();
    vi.spyOn(r.manager, 'save').mockRejectedValueOnce(new Error('disk'));
    expect((await setGitHubToken(r.deps, TOKEN)).ok).toBe(false);
    expect(await r.secrets.getSecret('github')).toBeUndefined();
    expect(await r.manager.defs()).toEqual([]);
  });

  it('rejects a token over 512 characters with no network call', async () => {
    const r = rig();
    expect((await setGitHubToken(r.deps, 'a'.repeat(513))).ok).toBe(false);
    expect(r.fetch).not.toHaveBeenCalled();
    expect((await setGitHubToken(r.deps, 'a'.repeat(512))).ok).toBe(true);
  });

  it('stores no login when it is outside GitHub\'s charset', async () => {
    const r = rig({ fetch: async () => json(200, { login: '<img src=x onerror=1>' }) });
    const out = await setGitHubToken(r.deps, TOKEN);
    expect(out.ok).toBe(true);
    expect(out.ok ? out.login : 'x').toBeUndefined();
    expect((await r.manager.defs())[0]!.login).toBeUndefined();
  });
});

describe('TokenAuth', () => {
  it('returns null with no secret; GitHub headers otherwise; no refresh', async () => {
    fakeBrowser.reset();
    const secrets = new SecretStore({ local: browser.storage.local, session: browser.storage.session });
    const a = new TokenAuth();
    const def = builtinConnectionDefs().github;
    expect(await a.headers(def, secrets)).toBeNull();
    await secrets.setSecret('github', { token: TOKEN });
    expect(await a.headers(def, secrets)).toEqual({
      Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    });
    expect('refresh' in a).toBe(false);
  });
});
