import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { SecretStore } from '../../../src/engine/connections/secret-store';
import { RateLimiter } from '../../../src/engine/connections/rate-limiter';
import {
  CONCURRENCY_PER_CONNECTION, ConnectionManager, REQUEST_TIMEOUT_MS, ReauthRequiredError, type AuthProvider,
} from '../../../src/engine/connections/manager';
import { builtinConnectionDefs, jiraDef } from '../../../src/core/connections/builtin';
import type { AuthStyle, ConnectionDef, ConnectionStatus } from '../../../src/core/connections/types';

const NOW = 1_700_000_000_000;
const TOKEN = 'gho_long_lived_token_abc';
const SSO_URL = 'https://github.com/orgs/acme/sso?authorization_request=x';
const github = (): ConnectionDef => builtinConnectionDefs().github;

type FetchFn = typeof fetch;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Bearer from the stored secret; null when nothing is stored. */
const tokenAuth = (extra: Partial<AuthProvider> = {}): AuthProvider => ({
  async headers(def, secrets) {
    const s = await secrets.getSecret(def.id);
    return s ? { Authorization: `Bearer ${s.token}` } : null;
  },
  ...extra,
});

interface Rig {
  mgr: ConnectionManager;
  fetch: ReturnType<typeof vi.fn<FetchFn>>;
  port: { hasPermission: ReturnType<typeof vi.fn> };
  secrets: SecretStore;
  log: { add: ReturnType<typeof vi.fn> };
  provider: AuthProvider;
}

let now = NOW;
function rig(opts: { provider?: AuthProvider; fetch?: FetchFn; granted?: (o: string) => boolean; allowLocalhost?: boolean } = {}): Rig {
  const secrets = new SecretStore({ local: browser.storage.local, session: browser.storage.session });
  const f = vi.fn<FetchFn>(opts.fetch ?? (async () => json(200, { ok: 1 })));
  const granted = opts.granted ?? (() => true);
  const port = { hasPermission: vi.fn(async (p: { origins?: string[] }) => (p.origins ?? []).every(granted)) };
  const provider = opts.provider ?? tokenAuth();
  const auth = { 'device-code': provider, token: provider, session: provider, 'oauth-pkce': provider, 'oauth-proxy': provider } satisfies Record<AuthStyle, AuthProvider>;
  const log = { add: vi.fn() };
  const mgr = new ConnectionManager({
    local: browser.storage.local, session: browser.storage.session, secrets,
    limiter: new RateLimiter(browser.storage.session, () => now),
    port, fetch: f, now: () => now, log, auth, allowLocalhost: opts.allowLocalhost,
  });
  return { mgr, fetch: f, port, secrets, log, provider };
}

async function connected(r: Rig, def: ConnectionDef = github()): Promise<void> {
  await r.mgr.save(def);
  await r.secrets.setSecret(def.id, { token: TOKEN });
}

const GET = { method: 'GET' as const, path: '/user' };
const st = async (r: Rig, id = 'github'): Promise<ConnectionStatus> => (await r.mgr.status(id))[0]!;

describe('ConnectionManager', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    now = NOW;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('defs', () => {
    it('save / defs / remove round-trip through storage.local connections', async () => {
      const r = rig();
      await r.mgr.save(github());
      expect(await r.mgr.defs()).toEqual([github()]);
      expect((await browser.storage.local.get('connections')).connections).toEqual([github()]);
      await r.mgr.save({ ...github(), label: 'GH' });
      expect((await r.mgr.defs()).map((d) => d.label)).toEqual(['GH']);
      await r.secrets.setSecret('github', { token: TOKEN });
      await r.mgr.remove('github');
      expect(await r.mgr.defs()).toEqual([]);
      expect(await r.secrets.getSecret('github')).toBeUndefined();
    });

    it('save rejects an unsupported api host', async () => {
      const r = rig();
      await expect(r.mgr.save({ ...github(), apiBaseUrl: 'https://ghe.acme.com/api/v3' })).rejects.toThrow('Only github.com and Jira Cloud');
      expect(await r.mgr.defs()).toEqual([]);
    });
  });

  describe('fetch: checks before the network', () => {
    it('an unknown connection → not-configured, no network', async () => {
      const r = rig();
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'not-configured' });
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it('T3 carry: a scoped Jira def without a cloudId → not-configured "cloudId not discovered yet", no network', async () => {
      const r = rig();
      await connected(r, jiraDef('acme.atlassian.net', 'scoped'));
      expect(await r.mgr.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' }))
        .toMatchObject({ ok: false, kind: 'not-configured', message: 'cloudId not discovered yet' });
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it('M3-R35: a disallowed apiBaseUrl in storage → not-configured, no network; localhost only with allowLocalhost', async () => {
      const local = { ...github(), apiBaseUrl: 'http://localhost:4000', hosts: ['http://localhost/*'] };
      await browser.storage.local.set({ connections: [local, { ...github(), id: 'evil', apiBaseUrl: 'https://evil.com' }] });
      const r = rig();
      await r.secrets.setSecret('github', { token: TOKEN });
      await r.secrets.setSecret('evil', { token: TOKEN });
      expect(await r.mgr.fetch('evil', GET)).toMatchObject({ ok: false, kind: 'not-configured' });
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'not-configured' });
      expect(r.fetch).not.toHaveBeenCalled();
      const e2e = rig({ allowLocalhost: true });
      expect(await e2e.mgr.fetch('github', GET)).toMatchObject({ ok: true });
      expect(e2e.fetch.mock.calls[0]![0]).toBe('http://localhost:4000/user');
    });

    it('missing host permission → not-configured naming the origin, no network', async () => {
      const r = rig({ granted: (o) => o !== 'https://api.github.com/*' });
      await connected(r);
      const res = await r.mgr.fetch('github', GET);
      expect(res).toMatchObject({ ok: false, kind: 'not-configured', message: 'needs https://api.github.com/*' });
      expect(r.port.hasPermission).toHaveBeenCalledWith({ origins: github().hosts });
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it('no stored credentials → not-configured, no network', async () => {
      const r = rig();
      await r.mgr.save(github());
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'not-configured' });
      expect(r.fetch).not.toHaveBeenCalled();
      expect((await st(r)).state).toBe('not-configured');
    });

    it.each(['https://evil.com/x', '/../x', '/repos/%2e%2e/x/../y', 'user', '/a\\b'])('path %s is rejected before fetch', async (path) => {
      const r = rig();
      await connected(r);
      expect(await r.mgr.fetch('github', { method: 'GET', path })).toMatchObject({ ok: false, kind: 'bad-request' });
      expect(r.fetch).not.toHaveBeenCalled();
    });
  });

  describe('fetch: the request', () => {
    it('builds apiBaseUrl + path + query, sends auth headers and JSON, omits cookies by default', async () => {
      const r = rig();
      await connected(r);
      const res = await r.mgr.fetch('github', { method: 'POST', path: '/graphql', query: { a: 'b c' }, json: { query: '{ viewer { login } }' } });
      expect(res).toEqual({ ok: true, status: 200, data: { ok: 1 } });
      const [url, init] = r.fetch.mock.calls[0]!;
      expect(url).toBe('https://api.github.com/graphql?a=b+c');
      expect(init).toMatchObject({ method: 'POST', credentials: 'omit', body: JSON.stringify({ query: '{ viewer { login } }' }) });
      expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(new Headers(init!.headers).get('content-type')).toBe('application/json');
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const s = await st(r);
      expect(s).toMatchObject({ id: 'github', state: 'ok', lastUsedAt: NOW, ssoRequired: [], scopes: [] });
    });

    it('the provider credentials mode is used (session auth)', async () => {
      const r = rig({ provider: { headers: async () => ({}), credentials: 'include' } });
      await r.mgr.save(jiraDef('acme.atlassian.net', 'classic'));
      await r.mgr.fetch('jira', { method: 'GET', path: '/rest/api/3/myself' });
      expect(r.fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    });

    it('a network error → network; a non-JSON body is returned as text', async () => {
      const r = rig({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
      await connected(r);
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'network' });
      expect((await st(r)).state).toBe('error');
      const t = rig({ fetch: async () => new Response('plain', { status: 200 }) });
      expect(await t.mgr.fetch('github', GET)).toEqual({ ok: true, status: 200, data: 'plain' });
      expect((await st(t)).state).toBe('ok');
    });

    it('a timeout → timeout after 15 s', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      expect(REQUEST_TIMEOUT_MS).toBe(15_000);
      const r = rig({
        fetch: (_u, init) => new Promise((_res, rej) => {
          init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
      });
      await connected(r);
      const p = r.mgr.fetch('github', GET);
      await vi.advanceTimersByTimeAsync(14_999);
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toMatchObject({ ok: false, kind: 'timeout' });
    });

    it('a third concurrent request waits for one of the first two', async () => {
      expect(CONCURRENCY_PER_CONNECTION).toBe(2);
      const pending: ((r: Response) => void)[] = [];
      const r = rig({ fetch: () => new Promise<Response>((res) => pending.push(res)) });
      await connected(r);
      const ps = [r.mgr.fetch('github', GET), r.mgr.fetch('github', GET), r.mgr.fetch('github', GET)];
      await vi.waitFor(() => expect(r.fetch).toHaveBeenCalledTimes(2));
      await new Promise((res) => setTimeout(res, 20));
      expect(r.fetch).toHaveBeenCalledTimes(2);
      pending[0]!(json(200, {}));
      await vi.waitFor(() => expect(r.fetch).toHaveBeenCalledTimes(3));
      pending[1]!(json(200, {}));
      pending[2]!(json(200, {}));
      expect((await Promise.all(ps)).every((x) => x.ok)).toBe(true);
    });

    it('the concurrency limit is per connection', async () => {
      const pending: ((r: Response) => void)[] = [];
      const r = rig({ fetch: () => new Promise<Response>((res) => pending.push(res)) });
      await connected(r);
      await connected(r, jiraDef('acme.atlassian.net', 'classic'));
      const ps = [r.mgr.fetch('github', GET), r.mgr.fetch('github', GET), r.mgr.fetch('jira', { method: 'GET', path: '/x' })];
      await vi.waitFor(() => expect(r.fetch).toHaveBeenCalledTimes(3));
      for (const res of pending) res(json(200, {}));
      await Promise.all(ps);
    });
  });

  describe('Review Focus #1: token revoked mid-session', () => {
    it('401 with a refresh-capable provider → refresh exactly once, retried once, ok', async () => {
      let n = 0;
      const refresh = vi.fn(async () => true);
      const r = rig({ provider: tokenAuth({ refresh }), fetch: async () => (n++ === 0 ? json(401, { message: 'Bad credentials' }) : json(200, { login: 'e' })) });
      await connected(r);
      expect(await r.mgr.fetch('github', GET)).toEqual({ ok: true, status: 200, data: { login: 'e' } });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(r.fetch).toHaveBeenCalledTimes(2);
      expect((await st(r)).state).toBe('ok');
    });

    it('401 after a successful refresh → needs-reauth (no second refresh)', async () => {
      const refresh = vi.fn(async () => true);
      const r = rig({ provider: tokenAuth({ refresh }), fetch: async () => json(401, {}) });
      await connected(r);
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'unauthorized' });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(r.fetch).toHaveBeenCalledTimes(2);
      expect((await st(r)).state).toBe('needs-reauth');
    });

    it('a failed refresh → needs-reauth without a retry', async () => {
      const refresh = vi.fn(async () => false);
      const r = rig({ provider: tokenAuth({ refresh }), fetch: async () => json(401, {}) });
      await connected(r);
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'unauthorized' });
      expect(r.fetch).toHaveBeenCalledTimes(1);
      expect((await st(r)).state).toBe('needs-reauth');
    });

    it('concurrent 401s share one refresh', async () => {
      const refresh = vi.fn(async () => { await new Promise((res) => setTimeout(res, 5)); return false; });
      const r = rig({ provider: tokenAuth({ refresh }), fetch: async () => json(401, {}) });
      await connected(r);
      await Promise.all([r.mgr.fetch('github', GET), r.mgr.fetch('github', GET)]);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('fix 1: a 401 that resolves after another request\'s refresh completed → one refresh, retried with the new token', async () => {
      const OLD = 'Bearer gho_old_token_aaaaaaaa';
      const NEW = 'Bearer gho_new_token_bbbbbbbb';
      let token = OLD;
      let releaseRefresh!: () => void;
      const refresh = vi.fn(async () => {
        await new Promise<void>((res) => { releaseRefresh = res; });
        token = NEW;
        return true;
      });
      const provider: AuthProvider = { headers: async () => ({ Authorization: token }), refresh };
      let oldCalls = 0;
      let answerB!: (r: Response) => void;
      const r = rig({
        provider,
        fetch: async (_u, init) => {
          if (new Headers(init!.headers).get('authorization') === NEW) return json(200, { ok: 'new' });
          if (oldCalls++ === 0) return json(401, {}); // A
          return new Promise<Response>((res) => { answerB = res; }); // B: sent with the old token, answered later
        },
      });
      await connected(r);
      const pA = r.mgr.fetch('github', GET);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      const pB = r.mgr.fetch('github', GET);
      await vi.waitFor(() => expect(answerB).toBeTypeOf('function'));
      releaseRefresh();
      expect(await pA).toEqual({ ok: true, status: 200, data: { ok: 'new' } });
      answerB(json(401, {})); // B's 401 arrives after A's refresh completed
      expect(await pB).toEqual({ ok: true, status: 200, data: { ok: 'new' } });
      expect(refresh).toHaveBeenCalledTimes(1);
      const auths = r.fetch.mock.calls.map(([, init]) => new Headers(init!.headers).get('authorization'));
      expect(auths).toEqual([OLD, OLD, NEW, NEW]);
      expect((await st(r)).state).toBe('ok');
    });

    it('a failed refresh is not retried for the same credential generation', async () => {
      const refresh = vi.fn(async () => false);
      const r = rig({ provider: tokenAuth({ refresh }), fetch: async () => json(401, {}) });
      await connected(r);
      await r.mgr.fetch('github', GET);
      await r.mgr.save(github()); // re-auth: new generation
      await r.mgr.fetch('github', GET);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('M3-R51 save race: a 401 on a request sent before a re-auth save does not set needs-reauth again', async () => {
      const pending: ((r: Response) => void)[] = [];
      let n = 0;
      const r = rig({ fetch: () => (n++ === 0 ? new Promise<Response>((res) => pending.push(res)) : Promise.resolve(json(200, { ok: 2 }))) });
      await connected(r);
      const p = r.mgr.fetch('github', GET);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      await r.mgr.save(github()); // the user re-authenticates while the old request is in flight
      pending[0]!(json(401, {}));
      expect(await p).toEqual({ ok: true, status: 200, data: { ok: 2 } });
      expect(r.fetch).toHaveBeenCalledTimes(2);
      expect((await st(r)).state).toBe('ok');
    });

    it('M3-R51: a hung provider.headers → timeout after 15 s and the slot is released', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let hang = true;
      const r = rig({ provider: { headers: () => (hang ? new Promise(() => {}) : Promise.resolve({ Authorization: 'Bearer x' })) } });
      await r.mgr.save(github());
      const ps = [r.mgr.fetch('github', GET), r.mgr.fetch('github', GET)];
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      const res = await Promise.all(ps);
      expect(res.map((x) => !x.ok && x.kind)).toEqual(['timeout', 'timeout']);
      expect(r.fetch).not.toHaveBeenCalled();
      hang = false;
      expect((await r.mgr.fetch('github', GET)).ok).toBe(true);
    });

    it('M3-R51: a hung provider.refresh counts as a failed refresh after 15 s → needs-reauth', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const refresh = vi.fn(() => new Promise<boolean>(() => {}));
      const r = rig({ provider: tokenAuth({ refresh }), fetch: async () => json(401, {}) });
      await connected(r);
      const p = r.mgr.fetch('github', GET);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(await p).toMatchObject({ ok: false, kind: 'unauthorized' });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(r.fetch).toHaveBeenCalledTimes(1);
      expect((await st(r)).state).toBe('needs-reauth');
    });

    it('401 without refresh → needs-reauth; the next fetch makes no network call and returns unauthorized', async () => {
      const r = rig({ fetch: async () => json(401, { message: 'Bad credentials' }) });
      await connected(r);
      const changes: ConnectionStatus[] = [];
      r.mgr.onStatusChange((s) => changes.push(s));
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'unauthorized', status: 401 });
      const s = await st(r);
      expect(s).toMatchObject({ state: 'needs-reauth', lastError: 'Sign in to GitHub again' });
      expect(changes.at(-1)).toMatchObject({ id: 'github', state: 'needs-reauth' });
      r.fetch.mockClear();
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'unauthorized', message: 'Sign in to GitHub again' });
      expect(r.fetch).not.toHaveBeenCalled();
      // Survives a worker restart (a new manager over the same storage).
      const again = rig();
      expect(await again.mgr.fetch('github', GET)).toMatchObject({ kind: 'unauthorized' });
      expect(again.fetch).not.toHaveBeenCalled();
      // save (re-auth) clears it.
      await r.mgr.save(github());
      r.fetch.mockImplementation(async () => json(200, {}));
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: true });
      expect((await st(r)).state).toBe('ok');
    });

    it('requests queued behind a 401 resolve unauthorized without a network call', async () => {
      const pending: ((r: Response) => void)[] = [];
      const r = rig({ fetch: () => new Promise<Response>((res) => pending.push(res)) });
      await connected(r);
      const ps = [r.mgr.fetch('github', GET), r.mgr.fetch('github', GET), r.mgr.fetch('github', GET)];
      await vi.waitFor(() => expect(r.fetch).toHaveBeenCalledTimes(2));
      pending[0]!(json(401, {}));
      pending[1]!(json(401, {}));
      const res = await Promise.all(ps);
      expect(res.map((x) => !x.ok && x.kind)).toEqual(['unauthorized', 'unauthorized', 'unauthorized']);
      expect(r.fetch).toHaveBeenCalledTimes(2);
    });

    it('error messages from a body echoing ghu_SECRET123456 (or the stored token) do not contain it', async () => {
      const r = rig({ fetch: async () => json(400, { message: `bad ghu_SECRET123456 and ${TOKEN} and plainsecretvalue` }) });
      await connected(r);
      await r.secrets.setAccess('github', { token: 'plainsecretvalue' });
      const res = await r.mgr.fetch('github', GET);
      expect(res.ok).toBe(false);
      const msg = !res.ok ? res.message : '';
      expect(msg).toContain('bad');
      for (const s of ['ghu_SECRET123456', TOKEN, 'plainsecretvalue']) expect(msg).not.toContain(s);
      const n = rig({ fetch: async () => { throw new Error(`boom Bearer ${TOKEN}`); } });
      const nres = await n.mgr.fetch('github', GET);
      expect(!nres.ok && nres.message).not.toContain(TOKEN);
      const s = await st(n);
      expect(s.lastError).toBeDefined();
      expect(s.lastError).not.toContain(TOKEN);
      expect(JSON.stringify(r.log.add.mock.calls) + JSON.stringify(n.log.add.mock.calls)).not.toContain(TOKEN);
    });

    it('per-item GraphQL errors (FORBIDDEN, NOT_FOUND, SAML on a node) never change the connection state', async () => {
      const body = {
        data: { r0: null, r1: { p0: null } },
        errors: [
          { type: 'FORBIDDEN', path: ['r0'], message: 'Resource protected by organization SAML enforcement.' },
          { type: 'NOT_FOUND', path: ['r1', 'p0'], message: 'nope' },
        ],
      };
      const r = rig({ fetch: async () => json(200, body) });
      await connected(r);
      expect(await r.mgr.fetch('github', { method: 'POST', path: '/graphql', json: {} })).toEqual({ ok: true, status: 200, data: body });
      expect(await st(r)).toMatchObject({ state: 'ok', ssoRequired: [] });
    });
  });

  describe('ReauthRequiredError and status snapshots', () => {
    it('headers() throwing ReauthRequiredError → unauthorized + needs-reauth, no request, no refresh', async () => {
      const refresh = vi.fn(async () => true);
      const r = rig({ provider: { headers: async () => { throw new ReauthRequiredError(); }, refresh } });
      await connected(r);
      const res = await r.mgr.fetch('github', GET);
      expect(res).toMatchObject({ ok: false, kind: 'unauthorized', status: 401 });
      expect(r.fetch).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect((await st(r)).state).toBe('needs-reauth');
    });

    it('restoreStatus puts back a snapshot that a later save cleared', async () => {
      const r = rig({ fetch: async () => json(401, {}) });
      await connected(r);
      await r.mgr.fetch('github', GET);
      const snap = await r.mgr.snapshotStatus('github');
      await r.mgr.save(github());
      expect((await st(r)).state).toBe('ok');
      await r.mgr.restoreStatus(snap);
      expect((await st(r)).state).toBe('needs-reauth');
    });
  });

  describe('Review Focus #2: rate limits', () => {
    it('a 403 with retry-after: 120 → rate-limited at now+120 s; a restarted manager makes no call until then', async () => {
      const r = rig({ fetch: async () => json(403, { message: 'secondary' }, { 'retry-after': '120' }) });
      await connected(r);
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'rate-limited', retryAt: NOW + 120_000 });
      expect(await st(r)).toMatchObject({ state: 'rate-limited', blockedUntil: NOW + 120_000 });

      const again = rig();
      expect(await again.mgr.fetch('github', GET)).toMatchObject({ ok: false, kind: 'rate-limited', retryAt: NOW + 120_000 });
      now = NOW + 119_999;
      expect(await again.mgr.fetch('github', { ...GET, background: true })).toMatchObject({ kind: 'rate-limited' });
      expect(again.fetch).not.toHaveBeenCalled();
      now = NOW + 120_000;
      expect(await again.mgr.fetch('github', GET)).toMatchObject({ ok: true });
      expect(again.fetch).toHaveBeenCalledTimes(1);
      expect((await st(again)).state).toBe('ok');
    });

    it('no retry storm: requests queued behind a rate-limited response do not go out', async () => {
      const pending: ((r: Response) => void)[] = [];
      const r = rig({ fetch: () => new Promise<Response>((res) => pending.push(res)) });
      await connected(r);
      const ps = [r.mgr.fetch('github', GET), r.mgr.fetch('github', GET), r.mgr.fetch('github', GET), r.mgr.fetch('github', GET)];
      await vi.waitFor(() => expect(r.fetch).toHaveBeenCalledTimes(2));
      pending[0]!(json(429, {}, { 'retry-after': '30' }));
      pending[1]!(json(429, {}, { 'retry-after': '30' }));
      const res = await Promise.all(ps);
      expect(res.every((x) => !x.ok && x.kind === 'rate-limited')).toBe(true);
      expect(r.fetch).toHaveBeenCalledTimes(2);
    });

    it('a GraphQL rateLimit of 400/5,000 pauses background requests only', async () => {
      const resetAt = new Date(NOW + 600_000).toISOString();
      const r = rig({ fetch: async () => json(200, { data: { rateLimit: { cost: 1, remaining: 400, limit: 5000, resetAt } } }) });
      await connected(r);
      expect((await r.mgr.fetch('github', { method: 'POST', path: '/graphql', json: {} })).ok).toBe(true);
      const bg = await r.mgr.fetch('github', { method: 'POST', path: '/graphql', json: {}, background: true });
      expect(bg).toMatchObject({ ok: false, kind: 'rate-limited', retryAt: Date.parse(resetAt) });
      expect(r.fetch).toHaveBeenCalledTimes(1);
      expect((await r.mgr.fetch('github', { method: 'POST', path: '/graphql', json: {} })).ok).toBe(true);
      expect(r.fetch).toHaveBeenCalledTimes(2);
      // Background budget pressure is not a connection-level rate limit.
      expect((await st(r)).state).toBe('ok');
    });

    it('M3-R51: a REST response at 4990/5000 does not lift the GraphQL 400/5000 background pause', async () => {
      const resetAt = new Date(NOW + 600_000).toISOString();
      const reset = String(Math.floor(NOW / 1000) + 600);
      const r = rig({
        fetch: async (u) => (String(u).endsWith('/graphql')
          ? json(200, { data: { rateLimit: { remaining: 400, limit: 5000, resetAt } } }, { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '400', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset })
          : json(200, {}, { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset })),
      });
      await connected(r);
      await r.mgr.fetch('github', { method: 'POST', path: '/graphql', json: {} });
      await r.mgr.fetch('github', GET);
      expect(await r.mgr.fetch('github', { method: 'POST', path: '/graphql', json: {}, background: true })).toMatchObject({ kind: 'rate-limited' });
      expect((await r.mgr.fetch('github', { ...GET, background: true })).ok).toBe(true);
      expect(r.fetch).toHaveBeenCalledTimes(3);
    });

    it('M3-R50: a GraphQL 200 with a path-less RATE_LIMITED error blocks the connection', async () => {
      const r = rig({ fetch: async () => json(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }) });
      await connected(r);
      expect(await r.mgr.fetch('github', { method: 'POST', path: '/graphql', json: {} })).toMatchObject({ kind: 'rate-limited', retryAt: NOW + 60_000 });
      expect((await st(r)).state).toBe('rate-limited');
      expect(await r.mgr.fetch('github', GET)).toMatchObject({ kind: 'rate-limited' });
      expect(r.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Review Focus #3: SAML SSO', () => {
    it('REST 403 X-GitHub-SSO → sso-required {org, url}; the connection stays ok with ssoRequired listed', async () => {
      const r = rig({ fetch: async () => json(403, { message: 'Resource protected by organization SAML enforcement.' }, { 'X-GitHub-SSO': `required; url=${SSO_URL}` }) });
      await connected(r);
      const changes: ConnectionStatus[] = [];
      r.mgr.onStatusChange((s) => changes.push(s));
      const res = await r.mgr.fetch('github', { method: 'GET', path: '/repos/acme/x/pulls/1' });
      expect(res).toMatchObject({ ok: false, kind: 'sso-required', sso: { org: 'acme', url: SSO_URL } });
      expect(await st(r)).toMatchObject({ state: 'ok', ssoRequired: [{ org: 'acme', url: SSO_URL }] });
      expect(changes.at(-1)).toMatchObject({ state: 'ok', ssoRequired: [{ org: 'acme', url: SSO_URL }] });
      // A second hit for the same org is not listed twice.
      await r.mgr.fetch('github', { method: 'GET', path: '/repos/acme/y/pulls/2' });
      expect((await st(r)).ssoRequired).toHaveLength(1);
      // The connection keeps working for other orgs.
      r.fetch.mockImplementation(async () => json(200, {}));
      expect((await r.mgr.fetch('github', GET)).ok).toBe(true);
    });
  });

  describe('status', () => {
    it('lists every saved connection; an unknown id is not-configured', async () => {
      const r = rig();
      await connected(r);
      await r.mgr.save(jiraDef('acme.atlassian.net', 'classic'));
      expect((await r.mgr.status()).map((s: ConnectionStatus) => [s.id, s.state])).toEqual([['github', 'ok'], ['jira', 'not-configured']]);
      expect(await r.mgr.status('nope')).toEqual([{ id: 'nope', state: 'not-configured', ssoRequired: [], scopes: [] }]);
    });

    it('onStatusChange unsubscribes', async () => {
      const r = rig({ fetch: async () => json(401, {}) });
      await connected(r);
      const cb = vi.fn();
      r.mgr.onStatusChange(cb)();
      await r.mgr.fetch('github', GET);
      expect(cb).not.toHaveBeenCalled();
    });

    it('T7: disconnect clears the secrets (SecretStore.clear) and the runtime status, keeps the def as not-configured', async () => {
      const r = rig({ fetch: async () => json(401, {}) });
      await r.mgr.save({ ...github(), login: 'octo', scopes: ['repo'] });
      await r.secrets.setSecret('github', { token: TOKEN });
      await r.secrets.setAccess('github', { token: 'ghu_access_token_xyz' });
      await r.mgr.fetch('github', GET);
      expect((await st(r)).state).toBe('needs-reauth');
      const clear = vi.spyOn(r.secrets, 'clear');
      const changes: ConnectionStatus[] = [];
      r.mgr.onStatusChange((s) => changes.push(s));
      await r.mgr.disconnect('github');
      expect(clear).toHaveBeenCalledWith('github');
      expect(await r.secrets.getSecret('github')).toBeUndefined();
      expect(await r.secrets.getAccess('github')).toBeUndefined();
      const [def] = await r.mgr.defs();
      expect(def).toMatchObject({ id: 'github', auth: 'device-code', scopes: [] });
      expect(def!.login).toBeUndefined();
      expect(await st(r)).toEqual({ id: 'github', state: 'not-configured', ssoRequired: [], scopes: [] });
      expect(changes.at(-1)).toMatchObject({ id: 'github', state: 'not-configured' });
    });

    it('T7: a disconnected connection is not-configured even while its rate-limit block lasts', async () => {
      const r = rig({ fetch: async () => json(403, {}, { 'retry-after': '120' }) });
      await connected(r);
      await r.mgr.fetch('github', GET);
      expect((await st(r)).state).toBe('rate-limited');
      await r.mgr.disconnect('github');
      expect((await st(r)).state).toBe('not-configured');
    });

    it('T4 minor: an extended rate-limit block (new retryAt) emits a status change', async () => {
      let retry = '120';
      const r = rig({ fetch: async () => json(403, {}, { 'retry-after': retry }) });
      await connected(r);
      const changes: ConnectionStatus[] = [];
      r.mgr.onStatusChange((s) => changes.push(s));
      await r.mgr.fetch('github', GET);
      expect(changes.at(-1)).toMatchObject({ state: 'rate-limited', blockedUntil: NOW + 120_000 });
      const n = changes.length;
      now = NOW + 120_000; // the block ran out; the next request is limited again, for longer
      retry = '300';
      await r.mgr.fetch('github', GET);
      expect(changes.length).toBe(n + 1);
      expect(changes.at(-1)).toMatchObject({ state: 'rate-limited', blockedUntil: NOW + 420_000 });
    });

    it('remove clears the runtime status', async () => {
      const r = rig({ fetch: async () => json(401, {}) });
      await connected(r);
      await r.mgr.fetch('github', GET);
      await r.mgr.remove('github');
      expect((await st(r)).state).toBe('not-configured');
      await connected(r);
      r.fetch.mockImplementation(async () => json(200, {}));
      expect((await r.mgr.fetch('github', GET)).ok).toBe(true);
    });
  });
});
