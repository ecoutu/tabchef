// Jira auth (M3 T6): scoped / classic API tokens (Basic email:token) and read-only session mode.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import tenantRaw from '../../../fixtures/m3/jira-tenant-info.synthetic.json?raw';
import { SecretStore } from '../../../src/engine/connections/secret-store';
import { RateLimiter } from '../../../src/engine/connections/rate-limiter';
import { ConnectionManager } from '../../../src/engine/connections/manager';
import { TokenAuth } from '../../../src/engine/connections/token-auth';
import { JiraAuth, JiraSessionAuth, setJiraSession, setJiraToken } from '../../../src/engine/connections/jira-auth';
import { builtinConnectionDefs, jiraDef } from '../../../src/core/connections/builtin';
import { base64Utf8 } from '../../../src/core/connections/redact';
import type { AuthStyle, ConnectionDef } from '../../../src/core/connections/types';

const TOKEN = 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789';
const EMAIL = 'user@example.com';
const CLOUD_ID = '00000000-0000-4000-8000-000000000000';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T10:00:00Z');
type FetchFn = typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// What Jira answers an unauthenticated /myself: HTML, not JSON.
const html401 = () => new Response('Client must be authenticated to access this resource.', { status: 401, headers: { 'content-type': 'text/html' } });
const myself = () => json(200, { accountId: '5b10a2844c20165700ede21g', displayName: 'Test User', active: true });

/** Answers tenant_info from the synthetic fixture and /myself with `me`. */
const jiraFetch = (me: () => Response = myself): FetchFn => async (input) => {
  const url = String(input);
  if (url.endsWith('/_edge/tenant_info')) return new Response(tenantRaw, { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/rest/api/3/myself')) return me();
  return json(200, { issues: [] });
};

function rig(opts: { fetch?: FetchFn; granted?: boolean; now?: number } = {}) {
  let now = opts.now ?? NOW;
  const secrets = new SecretStore({ local: browser.storage.local, session: browser.storage.session });
  const f = vi.fn<FetchFn>(opts.fetch ?? jiraFetch());
  const port = { hasPermission: vi.fn(async () => opts.granted ?? true) };
  const clock = () => now;
  const jira = new JiraAuth({ fetch: f, secrets, now: clock });
  const token = new TokenAuth({ jira });
  const session = new JiraSessionAuth();
  const auth = { 'device-code': token, token, session, 'oauth-pkce': token, 'oauth-proxy': token } satisfies Record<AuthStyle, unknown>;
  const manager = new ConnectionManager({
    local: browser.storage.local, session: browser.storage.session, secrets,
    limiter: new RateLimiter(browser.storage.session), port, fetch: f, auth, now: clock,
  });
  return {
    manager, secrets, jira, fetch: f, port, deps: { manager, secrets, port, fetch: f, jira, now: clock },
    advance: (ms: number) => { now += ms; },
  };
}
const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>;

beforeEach(() => { fakeBrowser.reset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('JiraAuth.discoverCloudId', () => {
  it('GET https://<site>/_edge/tenant_info (unauthenticated) and parses {cloudId}', async () => {
    const r = rig();
    expect(await r.jira.discoverCloudId('acme.atlassian.net')).toBe(CLOUD_ID);
    const [url, init] = r.fetch.mock.calls[0]!;
    expect(url).toBe('https://acme.atlassian.net/_edge/tenant_info');
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(headersOf(init).Authorization).toBeUndefined();
  });

  it('a site outside *.atlassian.net (or with a scheme, path or port) throws before any fetch', async () => {
    const r = rig();
    for (const s of ['jira.acme.com', 'https://acme.atlassian.net', 'acme.atlassian.net/x', 'acme.atlassian.net:443', 'a.b.atlassian.net', 'evil.com#.atlassian.net']) {
      await expect(r.jira.discoverCloudId(s)).rejects.toThrow();
    }
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('a non-200 or a body without a usable cloudId throws', async () => {
    for (const res of [() => json(404, {}), () => json(200, {}), () => json(200, { cloudId: '../x' }), () => new Response('<html>', { status: 200 })]) {
      const r = rig({ fetch: async () => res() });
      await expect(r.jira.discoverCloudId('acme.atlassian.net')).rejects.toThrow();
    }
  });
});

describe('Jira token defs and headers', () => {
  it('the scoped def has apiBaseUrl with the cloudId and both hosts', () => {
    const d = jiraDef('acme.atlassian.net', 'scoped', CLOUD_ID);
    expect(d.apiBaseUrl).toBe(`https://api.atlassian.com/ex/jira/${CLOUD_ID}`);
    expect(d.hosts).toEqual(expect.arrayContaining(['https://api.atlassian.com/*', 'https://acme.atlassian.net/*']));
  });

  it('the session def talks to the site with auth session and asks for the site only', () => {
    const d = jiraDef('acme.atlassian.net', 'session');
    expect(d).toMatchObject({ auth: 'session', apiBaseUrl: 'https://acme.atlassian.net', hosts: ['https://acme.atlassian.net/*'], jira: { site: 'acme.atlassian.net' } });
  });

  it('Basic base64(email:token), UTF-8 safe; null without a stored token or an email', async () => {
    const r = rig();
    const def: ConnectionDef = { ...jiraDef('acme.atlassian.net', 'classic'), jira: { site: 'acme.atlassian.net', tokenKind: 'classic', email: 'émma@example.com' } };
    expect(await r.jira.headers(def, r.secrets)).toBeNull();
    await r.secrets.setSecret('jira', { token: TOKEN });
    expect(await r.jira.headers(def, r.secrets)).toEqual({ Authorization: `Basic ${base64Utf8(`émma@example.com:${TOKEN}`)}` });
    expect(await r.jira.headers({ ...def, jira: { site: 'acme.atlassian.net', tokenKind: 'classic' } }, r.secrets)).toBeNull();
  });
});

describe('setJiraToken', () => {
  it('scoped: discovers the cloudId, validates GET /rest/api/3/myself on api.atlassian.com, stores the token only in the secret', async () => {
    const r = rig();
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: ` ${EMAIL} `, token: ` ${TOKEN}\n`, tokenKind: 'scoped' });
    expect(out).toMatchObject({ ok: true, status: { id: 'jira', state: 'ok' } });
    expect(r.fetch.mock.calls.map(([u]) => u)).toEqual([
      'https://acme.atlassian.net/_edge/tenant_info',
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself`,
    ]);
    const init = r.fetch.mock.calls[1]![1];
    expect(headersOf(init).Authorization).toBe(`Basic ${base64Utf8(`${EMAIL}:${TOKEN}`)}`);
    expect(init!.credentials).toBe('omit');
    const def = (await r.manager.defs())[0]!;
    expect(def).toMatchObject({
      id: 'jira', auth: 'token', apiBaseUrl: `https://api.atlassian.com/ex/jira/${CLOUD_ID}`,
      jira: { site: 'acme.atlassian.net', email: EMAIL, tokenKind: 'scoped', cloudId: CLOUD_ID },
    });
    expect(def.hosts).toEqual(expect.arrayContaining(['https://api.atlassian.com/*', 'https://acme.atlassian.net/*']));
    expect((await browser.storage.local.get(null))['conn.secret.jira']).toEqual({ token: TOKEN });
    expect(JSON.stringify(await browser.storage.local.get('connections'))).not.toContain(TOKEN);
    expect(JSON.stringify(await browser.storage.session.get(null))).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(await r.secrets.knownSecrets()).toContain(`${EMAIL}:${TOKEN}`);
  });

  it('classic: no cloudId discovery; validates on the site; asks for the site only', async () => {
    const r = rig();
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'classic' });
    expect(out.ok).toBe(true);
    expect(r.fetch.mock.calls.map(([u]) => u)).toEqual(['https://acme.atlassian.net/rest/api/3/myself']);
    expect((await r.manager.defs())[0]).toMatchObject({ apiBaseUrl: 'https://acme.atlassian.net', hosts: ['https://acme.atlassian.net/*'] });
    expect(r.port.hasPermission).toHaveBeenCalledWith({ origins: ['https://acme.atlassian.net/*'] });
  });

  it('keeps a user-entered expiry: expiresInDays from def.jira.tokenExpiresAt', async () => {
    const r = rig();
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'classic', expiresAt: NOW + 5 * DAY });
    expect(out).toMatchObject({ ok: true, status: { state: 'ok', expiresInDays: 5 } });
    expect((await r.manager.defs())[0]!.jira!.tokenExpiresAt).toBe(NOW + 5 * DAY);
  });

  it('a 401 (HTML body): rejected, nothing stored, the previous connection kept', async () => {
    const r = rig({ fetch: jiraFetch(html401) });
    const prev = jiraDef('acme.atlassian.net', 'session');
    await r.manager.save(prev);
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'scoped' });
    expect(out).toEqual({ ok: false, error: 'Jira rejected this token (401)' });
    expect((await browser.storage.local.get(null))['conn.secret.jira']).toBeUndefined();
    expect(await r.manager.defs()).toEqual([prev]);
  });

  it('invalid input: an error and no network call', async () => {
    const r = rig();
    const ok = { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'scoped' as const };
    const bad = [
      { ...ok, site: 'jira.acme.com' }, { ...ok, site: 'https://acme.atlassian.net' }, { ...ok, site: 'acme.atlassian.net:8443' },
      { ...ok, site: 'acme.atlassian.net/jira' }, { ...ok, email: 'nobody' }, { ...ok, email: 'a:b@example.com' }, { ...ok, email: 'a b@example.com' },
      { ...ok, token: '' }, { ...ok, token: 'ATATT a b' }, { ...ok, token: 'x'.repeat(513) }, { ...ok, token: 'ATATT\u0000x' },
      { ...ok, tokenKind: 'oauth' as unknown as 'scoped' }, { ...ok, expiresAt: NOW - DAY }, { ...ok, expiresAt: Number.NaN },
    ];
    for (const input of bad) {
      const out = await setJiraToken(r.deps, input);
      expect(out.ok, JSON.stringify(input)).toBe(false);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    }
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('missing host access: an error naming the hosts, no network call', async () => {
    const r = rig({ granted: false });
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'scoped' });
    expect(out.ok).toBe(false);
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('a network error echoing the credentials is redacted', async () => {
    const r = rig({ fetch: async () => { throw new Error(`boom ${TOKEN} ${base64Utf8(`${EMAIL}:${TOKEN}`)}`); } });
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'classic' });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain(base64Utf8(`${EMAIL}:${TOKEN}`).replace(/=+$/, ''));
  });
});

describe('Jira token connections through the manager', () => {
  const save = async (r: ReturnType<typeof rig>, expiresAt?: number) => {
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'classic', ...(expiresAt !== undefined && { expiresAt }) });
    expect(out.ok).toBe(true);
    r.fetch.mockClear();
  };

  it('requests carry Basic email:token and no cookies', async () => {
    const r = rig();
    await save(r);
    const res = await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/search/jql', query: { jql: 'key in (ABC-1)' } });
    expect(res.ok).toBe(true);
    const [url, init] = r.fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/search\/jql\?/);
    expect(headersOf(init).Authorization).toBe(`Basic ${base64Utf8(`${EMAIL}:${TOKEN}`)}`);
    expect(init!.credentials).toBe('omit');
  });

  it('expiry 5 days out → expiresInDays 5; at expiry → needs-reauth "Jira token expired" and no request is sent', async () => {
    const r = rig();
    await save(r, NOW + 5 * DAY);
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'ok', expiresInDays: 5 });
    r.advance(4 * DAY + 1);
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'ok', expiresInDays: 1 });
    r.advance(DAY);
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'needs-reauth', lastError: 'Jira token expired', expiresInDays: 0 });
    const res = await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' });
    expect(res).toMatchObject({ ok: false, kind: 'unauthorized', message: 'Jira token expired' });
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('a 401 → needs-reauth, one request (no refresh exists for tokens)', async () => {
    let reject = false;
    const r = rig({ fetch: jiraFetch(() => (reject ? html401() : myself())) });
    await save(r, NOW + 30 * DAY);
    reject = true;
    const res = await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' });
    expect(res).toMatchObject({ ok: false, kind: 'unauthorized' });
    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'needs-reauth' });
    expect(JSON.stringify(await r.manager.status('jira'))).not.toContain(TOKEN);
  });
});

describe('Jira session mode', () => {
  it('setJiraSession validates GET /myself with the browser session (no Authorization) and saves auth session', async () => {
    const r = rig();
    await r.secrets.setSecret('jira', { token: TOKEN }); // a token connection switching to session mode
    const out = await setJiraSession(r.deps, { site: 'acme.atlassian.net' });
    expect(out).toMatchObject({ ok: true, status: { id: 'jira', state: 'ok' } });
    const [url, init] = r.fetch.mock.calls[0]!;
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/myself');
    expect(init!.credentials).toBe('include');
    expect(headersOf(init).Authorization).toBeUndefined();
    expect((await r.manager.defs())[0]).toMatchObject({ auth: 'session', apiBaseUrl: 'https://acme.atlassian.net' });
    expect((await browser.storage.local.get(null))['conn.secret.jira']).toBeUndefined();
  });

  it('not signed in to the site (401): an error, nothing saved', async () => {
    const r = rig({ fetch: jiraFetch(html401) });
    const out = await setJiraSession(r.deps, { site: 'acme.atlassian.net' });
    expect(out.ok).toBe(false);
    expect(await r.manager.defs()).toEqual([]);
  });

  it('a bad site: an error, no network call', async () => {
    const r = rig();
    expect((await setJiraSession(r.deps, { site: 'https://acme.atlassian.net/' })).ok).toBe(false);
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('a POST → read-only with no network call; a GET sends cookies and no Authorization', async () => {
    const r = rig();
    await setJiraSession(r.deps, { site: 'acme.atlassian.net' });
    r.fetch.mockClear();
    const post = await r.manager.fetch('jira', { method: 'POST', path: '/rest/api/3/issue', json: {} });
    expect(post).toEqual({ ok: false, kind: 'read-only', message: 'session mode is read-only' });
    expect(r.fetch).not.toHaveBeenCalled();
    const get = await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' });
    expect(get.ok).toBe(true);
    const init = r.fetch.mock.calls[0]![1];
    expect(init!.credentials).toBe('include');
    expect(headersOf(init).Authorization).toBeUndefined();
  });

  it('a session that ended (401) → needs-reauth', async () => {
    let out = false;
    const r = rig({ fetch: jiraFetch(() => (out ? html401() : myself())) });
    await setJiraSession(r.deps, { site: 'acme.atlassian.net' });
    out = true;
    await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' });
    expect((await r.manager.status('jira'))[0]!.state).toBe('needs-reauth');
  });
});

describe('Jira disconnect, expiry and session-provider guards (M3-R104)', () => {
  const saveToken = async (r: ReturnType<typeof rig>, expiresAt?: number) => {
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'classic', ...(expiresAt !== undefined && { expiresAt }) });
    expect(out.ok).toBe(true);
  };

  it('disconnect (token mode) → not-configured; the secret and the user-entered expiry are dropped', async () => {
    const r = rig();
    await saveToken(r, NOW + 5 * DAY);
    await r.manager.disconnect('jira');
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'not-configured' });
    expect((await r.manager.status('jira'))[0]!.expiresInDays).toBeUndefined();
    expect(await r.secrets.getSecret('jira')).toBeUndefined();
    expect((await r.manager.defs())[0]!.jira?.tokenExpiresAt).toBeUndefined();
  });

  it('disconnect (session mode) → not-configured: the def goes back to the unconfigured Jira template', async () => {
    const r = rig();
    expect((await setJiraSession(r.deps, { site: 'acme.atlassian.net' })).ok).toBe(true);
    expect((await r.manager.status('jira'))[0]!.state).toBe('ok');
    await r.manager.disconnect('jira');
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'not-configured' });
    expect((await r.manager.defs())[0]).toEqual(builtinConnectionDefs().jira);
    r.fetch.mockClear();
    expect(await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' })).toMatchObject({ ok: false, kind: 'not-configured' });
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('a fetch on a Jira def with a past expiry but no stored token stays not-configured (no needs-reauth written)', async () => {
    const r = rig();
    await r.manager.save({ ...jiraDef('acme.atlassian.net', 'classic'), jira: { site: 'acme.atlassian.net', email: EMAIL, tokenKind: 'classic', tokenExpiresAt: NOW - DAY } });
    const res = await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' });
    expect(res).toMatchObject({ ok: false, kind: 'not-configured' });
    expect(r.fetch).not.toHaveBeenCalled();
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'not-configured' });
    expect((await r.manager.status('jira'))[0]!.lastError).toBeUndefined();
  });

  it('a fresh token over an expired (needs-reauth) connection leaves it ok, without "Jira token expired"', async () => {
    const r = rig();
    await saveToken(r, NOW + DAY);
    r.advance(2 * DAY);
    await r.manager.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' });
    expect((await r.manager.status('jira'))[0]).toMatchObject({ state: 'needs-reauth', lastError: 'Jira token expired' });
    const out = await setJiraToken(r.deps, { site: 'acme.atlassian.net', email: EMAIL, token: TOKEN, tokenKind: 'classic', expiresAt: NOW + 30 * DAY });
    expect(out).toMatchObject({ ok: true, status: { state: 'ok' } });
    const [s] = await r.manager.status('jira');
    expect(s).toMatchObject({ state: 'ok' });
    expect(s!.lastError).toBeUndefined();
  });

  it('JiraSessionAuth.headers is null for anything but a Jira def (no cookies ride a non-Jira session def)', async () => {
    const session = new JiraSessionAuth();
    expect(await session.headers({ ...jiraDef('acme.atlassian.net', 'session') })).toEqual({});
    expect(await session.headers({ ...jiraDef('acme.atlassian.net', 'session'), kind: 'custom' })).toBeNull();
  });
});
