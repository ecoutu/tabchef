import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import codeRaw from '../../../fixtures/m3/github-device-code.synthetic.json?raw';
import tokenRaw from '../../../fixtures/m3/github-device-token.synthetic.json?raw';
import expiringRaw from '../../../fixtures/m3/github-device-token-expiring.synthetic.json?raw';
import errorsRaw from '../../../fixtures/m3/github-device-errors.synthetic.json?raw';
import { SecretStore } from '../../../src/engine/connections/secret-store';
import { RateLimiter } from '../../../src/engine/connections/rate-limiter';
import { ConnectionManager } from '../../../src/engine/connections/manager';
import {
  DEVICE_KEY, GITHUB_DEVICE_CODE_URL, GITHUB_TOKEN_URL, GitHubDeviceAuth,
} from '../../../src/engine/connections/github-auth';
import { setGitHubToken } from '../../../src/engine/connections/token-auth';
import { GITHUB_CLIENT_ID, builtinConnectionDefs } from '../../../src/core/connections/builtin';
import type { AuthStyle } from '../../../src/core/connections/types';

const strip = (raw: string) => { const { _comment, ...rest } = JSON.parse(raw) as Record<string, unknown>; void _comment; return rest; };
const CODE = strip(codeRaw) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
const TOKEN = strip(tokenRaw) as { access_token: string };
const EXPIRING = strip(expiringRaw) as { access_token: string; refresh_token: string; expires_in: number; refresh_token_expires_in: number };
const ERRORS = strip(errorsRaw) as Record<string, Record<string, unknown>>;

const NOW = 1_700_000_000_000;
type FetchFn = typeof fetch;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const form = (init?: RequestInit) => new URLSearchParams(String(init?.body ?? ''));
const urlOf = (u: Parameters<FetchFn>[0]) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url);

let now = NOW;
/** Routes by URL; `token` answers https://github.com/login/oauth/access_token. */
function rig(opts: { token?: (init?: RequestInit) => Response | Promise<Response>; user?: () => Response; granted?: (o: string) => boolean } = {}) {
  const secrets = new SecretStore({ local: browser.storage.local, session: browser.storage.session });
  const f = vi.fn<FetchFn>(async (u, init) => {
    const url = urlOf(u);
    if (url === GITHUB_DEVICE_CODE_URL) return json(200, CODE);
    if (url === GITHUB_TOKEN_URL) return (opts.token ?? (() => json(200, TOKEN)))(init);
    if (url === 'https://api.github.com/user') return (opts.user ?? (() => json(200, { login: 'octo' })))();
    return json(200, { ok: 1 });
  });
  const granted = opts.granted ?? (() => true);
  const port = { hasPermission: vi.fn(async (p: { origins?: string[] }) => (p.origins ?? []).every(granted)) };
  const holder: { manager?: ConnectionManager } = {};
  const device = new GitHubDeviceAuth({ fetch: f, secrets, session: browser.storage.session, port, now: () => now, manager: () => holder.manager! });
  const auth = { 'device-code': device, token: device, session: device, 'oauth-pkce': device, 'oauth-proxy': device } satisfies Record<AuthStyle, GitHubDeviceAuth>;
  const manager = new ConnectionManager({
    local: browser.storage.local, session: browser.storage.session, secrets,
    limiter: new RateLimiter(browser.storage.session, () => now), port, fetch: f, now: () => now, auth,
  });
  holder.manager = manager;
  const calls = (url: string) => f.mock.calls.filter(([u]) => urlOf(u) === url);
  return { device, manager, secrets, fetch: f, port, calls };
}
const def = () => builtinConnectionDefs().github;
const session = async () => browser.storage.session.get(null);
const everything = async () => JSON.stringify([await browser.storage.local.get(null), await session()]);

/** Puts the connection in expiring-token mode: access token valid until now + 1 h, refresh token stored. */
async function expiringConnection(r: ReturnType<typeof rig>, accessExpiresAt = now + 3_600_000) {
  await r.manager.save(def());
  await r.secrets.setSecret('github', { token: EXPIRING.refresh_token, refreshToken: EXPIRING.refresh_token, refreshExpiresAt: now + 1e10 });
  await r.secrets.setAccess('github', { token: 'ghu_old_access_token_value', expiresAt: accessExpiresAt });
}
const refreshed = (n = 1) => json(200, { ...EXPIRING, access_token: `ghu_refreshed_access_${n}`, refresh_token: `ghr_rotated_refresh_${n}` });

describe('GitHubDeviceAuth', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    now = NOW;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('returns the user code and verification uri; the device_code stays in storage.session', async () => {
      const r = rig();
      const out = await r.device.start(def());
      expect(out).toEqual({ ok: true, userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: NOW + 900_000, interval: 5 });
      expect(JSON.stringify(out)).not.toContain(CODE.device_code);
      expect((await session())[DEVICE_KEY]).toMatchObject({ deviceCode: CODE.device_code, expiresAt: NOW + 900_000, interval: 5 });
    });

    it('sends client_id, no scope, form-encoded with Accept: application/json, credentials omitted', async () => {
      const r = rig();
      await r.device.start(def());
      const [url, init] = r.fetch.mock.calls[0]!;
      expect(url).toBe('https://github.com/login/device/code');
      expect(init!.method).toBe('POST');
      const h = init!.headers as Record<string, string>;
      expect(h.Accept).toBe('application/json');
      expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(init!.credentials).toBe('omit');
      const body = form(init);
      expect(body.get('client_id')).toBe(GITHUB_CLIENT_ID);
      expect(body.get('scope') ?? '').toBe('');
      expect(body.has('client_secret')).toBe(false);
    });

    it('missing github.com permission: clear error, no network call', async () => {
      const r = rig({ granted: (o) => o !== 'https://github.com/*' });
      const out = await r.device.start(def());
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toContain('github.com');
      expect(r.fetch).not.toHaveBeenCalled();
      expect((await session())[DEVICE_KEY]).toBeUndefined();
    });

    it('ignores a caller-supplied base: always the fixed github.com url', async () => {
      const r = rig();
      await r.device.start({ ...def(), baseUrl: 'https://evil.example', apiBaseUrl: 'https://evil.example' });
      expect(urlOf(r.fetch.mock.calls[0]![0])).toBe(GITHUB_DEVICE_CODE_URL);
    });

    it('rejects a non-github connection with no network call', async () => {
      const r = rig();
      expect((await r.device.start({ ...def(), id: 'other' })).ok).toBe(false);
      expect((await r.device.poll({ ...def(), id: 'other' })).state).toBe('error');
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it('a second start replaces the pending flow', async () => {
      const r = rig();
      await r.device.start(def());
      r.fetch.mockImplementationOnce(async () => json(200, { ...CODE, device_code: 'second_device_code_value', user_code: 'ABCD-EFGH' }));
      const out = await r.device.start(def());
      expect(out.ok && out.userCode).toBe('ABCD-EFGH');
      expect((await session())[DEVICE_KEY]).toMatchObject({ deviceCode: 'second_device_code_value' });
    });

    it('error body or bad shape: error without the device code; nothing stored', async () => {
      for (const res of [
        json(200, { device_code: CODE.device_code, error: 'device_flow_disabled', error_description: `off for ${CODE.device_code}` }),
        json(200, { ...CODE, verification_uri: 'https://evil.example/login' }),
        json(200, { ...CODE, user_code: 7 }),
        json(500, {}),
        new Response('not json', { status: 200 }),
      ]) {
        fakeBrowser.reset();
        const r = rig();
        r.fetch.mockImplementationOnce(async () => res);
        const out = await r.device.start(def());
        expect(out.ok).toBe(false);
        expect(JSON.stringify(out)).not.toContain(CODE.device_code);
        expect((await session())[DEVICE_KEY]).toBeUndefined();
      }
    });

    it('times out after 15 s', async () => {
      vi.useFakeTimers();
      const r = rig();
      r.fetch.mockImplementationOnce((_u, init) => new Promise((_res, rej) => { init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))); }));
      const p = r.device.start(def());
      await vi.advanceTimersByTimeAsync(15_001);
      const out = await p;
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toContain('15 s');
    });
  });

  describe('poll', () => {
    it('sends the device code grant to the fixed token url with no client_secret', async () => {
      const r = rig({ token: () => json(200, ERRORS.authorization_pending) });
      await r.device.start(def());
      await r.device.poll(def());
      const [url, init] = r.calls(GITHUB_TOKEN_URL)[0]!;
      expect(url).toBe('https://github.com/login/oauth/access_token');
      expect((init!.headers as Record<string, string>).Accept).toBe('application/json');
      const body = form(init);
      expect(body.get('client_id')).toBe(GITHUB_CLIENT_ID);
      expect(body.get('device_code')).toBe(CODE.device_code);
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(body.has('client_secret')).toBe(false);
    });

    it('T7 fix: cancel() removes the pending flow; the next poll is "No GitHub sign-in in progress" and stores nothing', async () => {
      const r = rig();
      await r.device.start(def());
      await r.device.cancel();
      expect((await session())[DEVICE_KEY]).toBeUndefined();
      expect(await r.device.poll(def())).toEqual({ state: 'error', message: 'No GitHub sign-in in progress; start again' });
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(0);
      expect(await r.secrets.getSecret('github')).toBeUndefined();
    });

    it('T7 fix: a poll in flight when cancel() runs does not store its tokens', async () => {
      let answer!: (res: Response) => void;
      const r = rig({ token: () => new Promise<Response>((res) => { answer = res; }) });
      await r.device.start(def());
      const p = r.device.poll(def());
      await vi.waitFor(() => expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1));
      await r.device.cancel();
      answer(json(200, TOKEN));
      expect(await p).toEqual({ state: 'error', message: 'GitHub sign-in was cancelled; start again' });
      expect(await r.secrets.getSecret('github')).toBeUndefined();
      expect(await r.manager.defs()).toEqual([]);
      expect(await everything()).not.toContain(TOKEN.access_token);
    });

    it('authorization_pending → pending; the flow is kept', async () => {
      const r = rig({ token: () => json(200, ERRORS.authorization_pending) });
      await r.device.start(def());
      expect(await r.device.poll(def())).toEqual({ state: 'pending', interval: 5 });
      expect((await session())[DEVICE_KEY]).toBeDefined();
    });

    it('slow_down → slow-down with the interval + 5 s, remembered for the next poll', async () => {
      const r = rig({ token: () => json(200, ERRORS.slow_down) });
      await r.device.start(def());
      expect(await r.device.poll(def())).toEqual({ state: 'slow-down', interval: 10 });
      expect((await session())[DEVICE_KEY]).toMatchObject({ interval: 10 });
      expect(await r.device.poll(def())).toEqual({ state: 'slow-down', interval: 15 });
    });

    it('slow_down uses GitHub\'s interval when it is larger than current + 5', async () => {
      const r = rig({ token: () => json(200, { ...ERRORS.slow_down, interval: 30 }) });
      await r.device.start(def());
      expect(await r.device.poll(def())).toEqual({ state: 'slow-down', interval: 30 });
      expect((await session())[DEVICE_KEY]).toMatchObject({ interval: 30 });
    });

    it('expired_token → expired and the session entry is cleared', async () => {
      const r = rig({ token: () => json(200, ERRORS.expired_token) });
      await r.device.start(def());
      expect((await r.device.poll(def())).state).toBe('expired');
      expect((await session())[DEVICE_KEY]).toBeUndefined();
    });

    it('past expiresAt (fake clock) → expired with no network call', async () => {
      const r = rig();
      await r.device.start(def());
      now += 900_001;
      expect((await r.device.poll(def())).state).toBe('expired');
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(0);
      expect((await session())[DEVICE_KEY]).toBeUndefined();
    });

    it('access_denied → denied and the session entry is cleared', async () => {
      const r = rig({ token: () => json(200, ERRORS.access_denied) });
      await r.device.start(def());
      expect((await r.device.poll(def())).state).toBe('denied');
      expect((await session())[DEVICE_KEY]).toBeUndefined();
    });

    it('other errors → error, redacted, session cleared', async () => {
      const r = rig({ token: () => json(200, { ...ERRORS.incorrect_device_code, error_description: `bad ${CODE.device_code}` }) });
      await r.device.start(def());
      const out = await r.device.poll(def());
      expect(out.state).toBe('error');
      expect(out.message).toBeTruthy();
      expect(JSON.stringify(out)).not.toContain(CODE.device_code);
      expect((await session())[DEVICE_KEY]).toBeUndefined();
    });

    it('transient failures (network, 5xx, non-JSON) → pending with a redacted message; the flow is kept', async () => {
      for (const token of [
        () => { throw new Error(`reset ${CODE.device_code}`); },
        () => json(502, { message: 'bad gateway' }),
        () => json(500, { error: 'server_error' }),
        () => new Response('<html>oops</html>', { status: 200 }),
      ]) {
        fakeBrowser.reset();
        const r = rig({ token });
        await r.device.start(def());
        const out = await r.device.poll(def());
        expect(out).toMatchObject({ state: 'pending', interval: 5 });
        expect(out.message).toBeTruthy();
        expect(JSON.stringify(out)).not.toContain(CODE.device_code);
        expect((await session())[DEVICE_KEY]).toMatchObject({ deviceCode: CODE.device_code });
      }
    });

    it('timeout (15 s) → pending; the flow is kept', async () => {
      vi.useFakeTimers();
      const r = rig({ token: (init) => new Promise((_res, rej) => { init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))); }) });
      await r.device.start(def());
      const p = r.device.poll(def());
      await vi.advanceTimersByTimeAsync(15_001);
      const out = await p;
      expect(out.state).toBe('pending');
      expect(out.message).toContain('15 s');
      expect((await session())[DEVICE_KEY]).toBeDefined();
    });

    it('2xx with neither error nor access_token → terminal error, flow cleared', async () => {
      const r = rig({ token: () => json(200, { token_type: 'bearer' }) });
      await r.device.start(def());
      expect((await r.device.poll(def())).state).toBe('error');
      expect((await session())[DEVICE_KEY]).toBeUndefined();
    });

    it('no flow in progress → error, no network call', async () => {
      const r = rig();
      expect((await r.device.poll(def())).state).toBe('error');
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it('missing github.com permission → clear error, no network call', async () => {
      let ok = true;
      const r = rig({ granted: () => ok });
      await r.device.start(def());
      ok = false;
      const out = await r.device.poll(def());
      expect(out.state).toBe('error');
      expect(out.message).toContain('github.com');
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(0);
    });

    it('a worker restart mid-flow keeps polling from storage.session', async () => {
      const r = rig({ token: () => json(200, ERRORS.authorization_pending) });
      await r.device.start(def());
      const fresh = rig({ token: () => json(200, ERRORS.authorization_pending) });
      expect((await fresh.device.poll(def())).state).toBe('pending');
      expect(form(fresh.calls(GITHUB_TOKEN_URL)[0]![1]).get('device_code')).toBe(CODE.device_code);
    });

    it('two overlapping polls share one request', async () => {
      const r = rig({ token: () => json(200, ERRORS.authorization_pending) });
      await r.device.start(def());
      const [a, b] = await Promise.all([r.device.poll(def()), r.device.poll(def())]);
      expect(a).toEqual(b);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
    });

    it('an old poll finishing after a new start does not clear the new flow', async () => {
      let release!: () => void;
      const r = rig({ token: () => new Promise((res) => { release = () => res(json(200, ERRORS.expired_token)); }) });
      await r.device.start(def());
      const p = r.device.poll(def());
      await vi.waitFor(() => expect(release).toBeDefined());
      r.fetch.mockImplementationOnce(async () => json(200, { ...CODE, device_code: 'second_device_code_value' }));
      await r.device.start(def());
      release();
      expect((await p).state).toBe('expired');
      expect((await session())[DEVICE_KEY]).toMatchObject({ deviceCode: 'second_device_code_value' });
    });
  });

  describe('done', () => {
    it('without expires_in: long-lived token in setSecret only; def saved with login and empty scopes', async () => {
      const r = rig();
      const setAccess = vi.spyOn(r.secrets, 'setAccess');
      await r.device.start(def());
      const out = await r.device.poll(def());
      expect(out).toEqual({ state: 'done' });
      expect(await r.secrets.getSecret('github')).toEqual({ token: TOKEN.access_token });
      expect(setAccess).not.toHaveBeenCalled();
      expect(await r.secrets.getAccess('github')).toBeUndefined();
      expect((await r.manager.defs())[0]).toMatchObject({ id: 'github', auth: 'device-code', login: 'octo', scopes: [] });
      expect((await session())[DEVICE_KEY]).toBeUndefined();
      const [userUrl, userInit] = r.calls('https://api.github.com/user')[0]!;
      expect(userUrl).toBe('https://api.github.com/user');
      expect((userInit!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN.access_token}`);
      expect((await r.manager.status('github'))[0]!.state).toBe('ok');
    });

    it('with expires_in: setAccess(access, expiresAt) + setSecret(refresh token)', async () => {
      const r = rig({ token: () => json(200, EXPIRING) });
      await r.device.start(def());
      expect(await r.device.poll(def())).toEqual({ state: 'done' });
      expect(await r.secrets.getAccess('github')).toEqual({ token: EXPIRING.access_token, expiresAt: NOW + 28_800_000 });
      expect(await r.secrets.getSecret('github')).toEqual({
        token: EXPIRING.refresh_token, refreshToken: EXPIRING.refresh_token, refreshExpiresAt: NOW + 15_724_800_000,
      });
      expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain(EXPIRING.access_token);
    });

    it('records x-oauth-scopes when present', async () => {
      const r = rig({ user: () => json(200, { login: 'octo' }, { 'x-oauth-scopes': 'repo, read:org' }) });
      await r.device.start(def());
      await r.device.poll(def());
      expect((await r.manager.defs())[0]!.scopes).toEqual(['repo', 'read:org']);
    });

    it('drops a login outside GitHub\'s charset; /user failure still saves without a login', async () => {
      for (const user of [() => json(200, { login: '<b>x</b>' }), () => json(500, {})]) {
        fakeBrowser.reset();
        const r = rig({ user });
        await r.device.start(def());
        expect((await r.device.poll(def())).state).toBe('done');
        const d = (await r.manager.defs())[0]!;
        expect(d.login).toBeUndefined();
        expect('login' in d).toBe(false);
        expect(d.auth).toBe('device-code');
      }
    });

    it('replaces a PAT connection: new secret, stale access cleared, auth device-code, old login overwritten', async () => {
      const r = rig({ user: () => json(200, { login: '???' }) });
      const PAT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      r.fetch.mockImplementationOnce(async () => json(200, { login: 'patuser' }));
      expect((await setGitHubToken({ manager: r.manager, secrets: r.secrets, port: r.port, fetch: r.fetch }, PAT)).ok).toBe(true);
      await r.secrets.setAccess('github', { token: 'ghu_stale_access_value' });
      await r.device.start(def());
      expect((await r.device.poll(def())).state).toBe('done');
      expect(await r.secrets.getSecret('github')).toEqual({ token: TOKEN.access_token });
      expect(await r.secrets.getAccess('github')).toBeUndefined();
      const d = (await r.manager.defs())[0]!;
      expect(d.auth).toBe('device-code');
      expect(d.login).toBeUndefined();
      expect(await everything()).not.toContain(PAT);
    });

    it('save failure keeps the previous credentials and def; error is redacted', async () => {
      const r = rig();
      await r.manager.save({ ...def(), auth: 'token', login: 'old' });
      await r.secrets.setSecret('github', { token: 'ghp_previous_working_token_x' });
      await r.device.start(def());
      vi.spyOn(r.manager, 'save').mockRejectedValueOnce(new Error(`disk ${TOKEN.access_token}`));
      const out = await r.device.poll(def());
      expect(out.state).toBe('error');
      expect(JSON.stringify(out)).not.toContain(TOKEN.access_token);
      expect(await r.secrets.getSecret('github')).toEqual({ token: 'ghp_previous_working_token_x' });
      expect((await r.manager.defs())[0]).toMatchObject({ auth: 'token', login: 'old' });
      expect((await session())[DEVICE_KEY]).toBeUndefined();
    });

    it('never returns or logs device_code or tokens', async () => {
      const log = vi.spyOn(console, 'log');
      const err = vi.spyOn(console, 'error');
      const r = rig({ token: () => json(200, EXPIRING) });
      const outs = [await r.device.start(def()), await r.device.poll(def())];
      const text = JSON.stringify([outs, log.mock.calls, err.mock.calls]);
      for (const s of [CODE.device_code, EXPIRING.access_token, EXPIRING.refresh_token]) expect(text).not.toContain(s);
    });
  });

  describe('headers', () => {
    it('null when nothing is stored; long-lived secret → Bearer with GitHub headers', async () => {
      const r = rig();
      expect(await r.device.headers(def(), r.secrets)).toBeNull();
      await r.secrets.setSecret('github', { token: TOKEN.access_token });
      expect(await r.device.headers(def(), r.secrets)).toEqual({
        Authorization: `Bearer ${TOKEN.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      });
    });

    it('a valid access token is used without a refresh', async () => {
      const r = rig();
      await expiringConnection(r);
      expect((await r.device.headers(def(), r.secrets))!.Authorization).toBe('Bearer ghu_old_access_token_value');
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(0);
    });

    it('expired access token (fake clock) → refresh first, then the new token', async () => {
      const r = rig({ token: () => refreshed() });
      await expiringConnection(r);
      now += 3_600_001;
      expect((await r.device.headers(def(), r.secrets))!.Authorization).toBe('Bearer ghu_refreshed_access_1');
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
      expect(await r.secrets.getSecret('github')).toMatchObject({ refreshToken: 'ghr_rotated_refresh_1' });
      expect(await r.secrets.getAccess('github')).toEqual({ token: 'ghu_refreshed_access_1', expiresAt: now + 28_800_000 });
    });

    it('missing access token after a browser restart (session cleared) → refresh', async () => {
      const r = rig({ token: () => refreshed() });
      await expiringConnection(r);
      await r.secrets.clearAccess('github');
      expect((await r.device.headers(def(), r.secrets))!.Authorization).toBe('Bearer ghu_refreshed_access_1');
    });

    it('two concurrent headers() with an expired token → exactly one refresh POST', async () => {
      let n = 0;
      const r = rig({ token: async () => { n++; await new Promise((res) => setTimeout(res, 5)); return refreshed(n); } });
      await expiringConnection(r);
      now += 3_600_001;
      const [a, b] = await Promise.all([r.device.headers(def(), r.secrets), r.device.headers(def(), r.secrets)]);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
      expect(a!.Authorization).toBe('Bearer ghu_refreshed_access_1');
      expect(b!.Authorization).toBe('Bearer ghu_refreshed_access_1');
    });

    it('two concurrent manager fetches with an expired token → one refresh POST, both succeed', async () => {
      let n = 0;
      const r = rig({ token: async () => { n++; await new Promise((res) => setTimeout(res, 5)); return refreshed(n); } });
      await expiringConnection(r);
      now += 3_600_001;
      const GET = { method: 'GET' as const, path: '/repos/a/b' };
      const [a, b] = await Promise.all([r.manager.fetch('github', GET), r.manager.fetch('github', GET)]);
      expect(a.ok && b.ok).toBe(true);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
    });
  });

  describe('refresh', () => {
    it('POSTs grant_type=refresh_token with client_id only: no client_secret key', async () => {
      const r = rig({ token: () => refreshed() });
      await expiringConnection(r);
      expect(await r.device.refresh(def(), r.secrets)).toBe(true);
      const [url, init] = r.calls(GITHUB_TOKEN_URL)[0]!;
      expect(url).toBe(GITHUB_TOKEN_URL);
      expect((init!.headers as Record<string, string>).Accept).toBe('application/json');
      const body = form(init);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe(GITHUB_CLIENT_ID);
      expect(body.get('refresh_token')).toBe(EXPIRING.refresh_token);
      expect([...body.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token']);
      expect(body.has('client_secret')).toBe(false);
    });

    it('any error → false, credentials untouched', async () => {
      for (const token of [
        () => json(200, { error: 'bad_refresh_token', error_description: 'expired' }),
        () => json(500, {}),
        () => { throw new Error('offline'); },
        () => new Response('nope', { status: 200 }),
      ]) {
        fakeBrowser.reset();
        const r = rig({ token });
        await expiringConnection(r);
        expect(await r.device.refresh(def(), r.secrets)).toBe(false);
        expect(await r.secrets.getSecret('github')).toMatchObject({ refreshToken: EXPIRING.refresh_token });
      }
    });

    it('no refresh token (long-lived) or an expired refresh token → false with no network call', async () => {
      const r = rig();
      await r.secrets.setSecret('github', { token: TOKEN.access_token });
      expect(await r.device.refresh(def(), r.secrets)).toBe(false);
      await r.secrets.setSecret('github', { token: 'ghr_x', refreshToken: 'ghr_x', refreshExpiresAt: now - 1 });
      expect(await r.device.refresh(def(), r.secrets)).toBe(false);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(0);
    });

    it('missing github.com permission → false with no network call', async () => {
      const r = rig({ granted: (o) => o !== 'https://github.com/*' });
      await expiringConnection(r);
      expect(await r.device.refresh(def(), r.secrets)).toBe(false);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(0);
    });

    it('expired access token + refresh failure → needs-reauth through the manager, one refresh POST', async () => {
      const r = rig({ token: () => json(200, { error: 'bad_refresh_token' }) });
      await expiringConnection(r);
      now += 3_600_001;
      r.fetch.mockImplementation(async (u, init) => {
        const url = urlOf(u);
        if (url === GITHUB_TOKEN_URL) return json(200, { error: 'bad_refresh_token' });
        void init;
        return json(401, { message: 'Bad credentials' });
      });
      const res = await r.manager.fetch('github', { method: 'GET', path: '/user' });
      expect(res).toMatchObject({ ok: false, kind: 'unauthorized' });
      expect((await r.manager.status('github'))[0]!.state).toBe('needs-reauth');
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
    });

    it('no access token (browser restart) + expired refresh token → needs-reauth, no request at all', async () => {
      const r = rig();
      await expiringConnection(r);
      await r.secrets.setSecret('github', { token: 'ghr_x', refreshToken: 'ghr_x', refreshExpiresAt: now - 1 });
      await r.secrets.clearAccess('github');
      const res = await r.manager.fetch('github', { method: 'GET', path: '/user' });
      expect(res).toMatchObject({ ok: false, kind: 'unauthorized' });
      expect((await r.manager.status('github'))[0]!.state).toBe('needs-reauth');
      expect(r.fetch).not.toHaveBeenCalled();
    });

    it('no access token + refresh rejected → needs-reauth with one refresh POST and no API request', async () => {
      const r = rig({ token: () => json(200, { error: 'bad_refresh_token' }) });
      await expiringConnection(r);
      await r.secrets.clearAccess('github');
      const res = await r.manager.fetch('github', { method: 'GET', path: '/user' });
      expect(res).toMatchObject({ ok: false, kind: 'unauthorized' });
      expect((await r.manager.status('github'))[0]!.state).toBe('needs-reauth');
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
      expect(r.fetch).toHaveBeenCalledTimes(1);
      for (const [, init] of r.fetch.mock.calls) expect(JSON.stringify(init?.headers ?? {})).not.toContain(EXPIRING.refresh_token);
    });

    it('no access token + transient refresh failure → an error, not needs-reauth, and nothing memoized', async () => {
      const r = rig({ token: () => json(503, {}) });
      await expiringConnection(r);
      await r.secrets.clearAccess('github');
      const res = await r.manager.fetch('github', { method: 'GET', path: '/user' });
      expect(res.ok).toBe(false);
      expect((await r.manager.status('github'))[0]!.state).not.toBe('needs-reauth');
      expect(await r.device.refresh(def(), r.secrets)).toBe(false);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(2);
    });

    it('transient failures are not memoized: the next refresh POSTs again', async () => {
      for (const token of [
        () => { throw new Error('offline'); },
        () => json(500, {}),
        () => json(503, { error: 'unavailable' }),
        () => new Response('nope', { status: 200 }),
        () => json(200, { token_type: 'bearer' }),
      ]) {
        fakeBrowser.reset();
        const r = rig({ token });
        await expiringConnection(r);
        expect(await r.device.refresh(def(), r.secrets)).toBe(false);
        expect(await r.device.refresh(def(), r.secrets)).toBe(false);
        expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(2);
      }
    });

    it('a timed-out refresh is not memoized', async () => {
      vi.useFakeTimers();
      let hang = true;
      const r = rig({ token: (init) => (hang ? new Promise((_res, rej) => { init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))); }) : refreshed()) });
      await expiringConnection(r);
      const p = r.device.refresh(def(), r.secrets);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await p).toBe(false);
      hang = false;
      expect(await r.device.refresh(def(), r.secrets)).toBe(true);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(2);
    });

    it('explicit rejections are memoized: the next refresh does not POST', async () => {
      for (const token of [
        () => json(200, { error: 'bad_refresh_token', error_description: 'expired' }),
        () => json(400, { error: 'invalid_grant' }),
        () => new Response('denied', { status: 401 }),
      ]) {
        fakeBrowser.reset();
        const r = rig({ token });
        await expiringConnection(r);
        expect(await r.device.refresh(def(), r.secrets)).toBe(false);
        expect(await r.device.refresh(def(), r.secrets)).toBe(false);
        expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
      }
    });

    describe('compare-and-set on refresh writes', () => {
      function held() {
        let release!: () => void;
        const r = rig({ token: () => new Promise<Response>((res) => { release = () => res(refreshed(9)); }) });
        return { r, release: () => release() };
      }

      it('a remove while the refresh POST is out: nothing reappears in storage, refresh → false', async () => {
        const { r, release } = held();
        await expiringConnection(r);
        const p = r.device.refresh(def(), r.secrets);
        await vi.waitFor(() => expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1));
        await r.manager.remove('github');
        release();
        expect(await p).toBe(false);
        expect(await r.secrets.getSecret('github')).toBeUndefined();
        expect(await r.secrets.getAccess('github')).toBeUndefined();
        expect(await everything()).not.toContain('ghr_rotated_refresh_9');
        expect(await everything()).not.toContain('ghu_refreshed_access_9');
      });

      it('a PAT save while the refresh POST is out: the PAT is intact, no access token written', async () => {
        const { r, release } = held();
        await expiringConnection(r);
        const PAT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
        const p = r.device.refresh(def(), r.secrets);
        await vi.waitFor(() => expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1));
        expect((await setGitHubToken({ manager: r.manager, secrets: r.secrets, port: r.port, fetch: r.fetch }, PAT)).ok).toBe(true);
        release();
        expect(await p).toBe(false);
        expect(await r.secrets.getSecret('github')).toEqual({ token: PAT });
        expect(await r.secrets.getAccess('github')).toBeUndefined();
        expect((await r.manager.defs())[0]!.auth).toBe('token');
        expect(await everything()).not.toContain('ghr_rotated_refresh_9');
      });

      it('a device-flow re-auth while the refresh POST is out keeps the new credentials', async () => {
        const { r, release } = held();
        await expiringConnection(r);
        const p = r.device.refresh(def(), r.secrets);
        await vi.waitFor(() => expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1));
        await r.secrets.setSecret('github', { token: TOKEN.access_token });
        release();
        expect(await p).toBe(false);
        expect(await r.secrets.getSecret('github')).toEqual({ token: TOKEN.access_token });
      });
    });

    it('a 401 on a clock-valid access token → manager refreshFor → refresh → retry succeeds', async () => {
      const r = rig({ token: () => refreshed() });
      await expiringConnection(r);
      let first = true;
      r.fetch.mockImplementation(async (u) => {
        const url = urlOf(u);
        if (url === GITHUB_TOKEN_URL) return refreshed();
        if (first) { first = false; return json(401, {}); }
        return json(200, { ok: 1 });
      });
      const res = await r.manager.fetch('github', { method: 'GET', path: '/user' });
      expect(res.ok).toBe(true);
      expect(r.calls(GITHUB_TOKEN_URL)).toHaveLength(1);
    });
  });
});
