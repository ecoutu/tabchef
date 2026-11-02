import { GITHUB_CLIENT_ID, builtinConnectionDefs } from '../../core/connections/builtin';
import { redact } from '../../core/connections/redact';
import type { ConnectionDef } from '../../core/connections/types';
import type { BrowserPort } from '../../platform/browser-port';
import { REQUEST_TIMEOUT_MS, ReauthRequiredError, type AuthProvider, type ConnectionManager } from './manager';
import type { AccessToken, KeyValueArea, SecretStore, StoredSecret } from './secret-store';
import { githubHeaders, githubLogin, githubScopes, replaceCredentials } from './token-auth';

/** Fixed device-flow endpoints (M3-R49): never apiBaseUrl paths, never caller-supplied. */
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_ORIGIN = 'https://github.com/*';
const GITHUB_API_ORIGIN = 'https://api.github.com/*';
const VERIFICATION_PREFIX = 'https://github.com/';
/** storage.session: the pending device flow, so a worker restart mid-flow keeps polling. */
export const DEVICE_KEY = 'conn.device.github';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** An access token this close to expiry is refreshed before use. */
const EXPIRY_SKEW_MS = 60_000;
const SLOW_DOWN_S = 5;
const USER_CODE = /^[A-Za-z0-9-]{1,64}$/;

export type DeviceStartResult =
  | { ok: true; userCode: string; verificationUri: string; expiresAt: number; interval: number }
  | { ok: false; error: string };
export type DevicePollState = 'pending' | 'slow-down' | 'done' | 'expired' | 'denied' | 'error';
export interface DevicePollResult { state: DevicePollState; interval?: number; message?: string }

export interface GitHubDeviceAuthDeps {
  fetch: typeof fetch;
  secrets: SecretStore;
  /** storage.session: `conn.device.github`. */
  session: KeyValueArea;
  port: Pick<BrowserPort, 'hasPermission'>;
  /** Lazy: the manager is built with this provider in its `auth` map, so it exists only after this constructor. */
  manager: () => Pick<ConnectionManager, 'defs' | 'save' | 'remove' | 'snapshotStatus' | 'restoreStatus'>;
  now?: () => number;
}

interface PendingFlow { deviceCode: string; expiresAt: number; interval: number }
/** `status` is set on a failure when GitHub answered (a non-JSON body); absent for network errors and timeouts. */
type Posted = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; error: string; status?: number };
/**
 * ok = new credentials stored; rejected = these credentials can never refresh (GitHub said no, or none/expired refresh
 * token) → re-auth; transient = network, timeout, 5xx, malformed body or missing permission → try again later;
 * superseded = the stored credentials changed while the refresh was in flight, its response was discarded.
 */
type RefreshOutcome = 'ok' | 'rejected' | 'transient' | 'superseded';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const posNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const GITHUB_ID = builtinConnectionDefs().github.id;
const NOT_GITHUB = 'Sign in with GitHub is only available for the github connection';
const NEEDS_GITHUB = 'Tabchef needs access to github.com to sign in with GitHub';

/**
 * Sign in with GitHub via the OAuth device flow of the Tabchef GitHub App (M3-R47/R49). The open Connections page
 * drives polling (one `poll` per interval); the service worker never runs its own loop. Tokens and the device_code are
 * never returned or logged; every message is redacted.
 *
 * Refresh dedupe: `headers()` refreshes an expired access token itself, and every refresh — from
 * `headers()` or from the manager's `refreshFor` after a 401 — goes through one in-flight promise per connection,
 * held until the rotated refresh token and the new access token are stored. Writes are compare-and-set on the refresh
 * token that was POSTed, so a refresh racing a re-auth, a PAT save or a remove never overwrites or resurrects
 * credentials. A refresh token GitHub explicitly rejected is remembered (transient failures are not), and `headers()`
 * then throws ReauthRequiredError so the manager marks needs-reauth without a request.
 */
export class GitHubDeviceAuth implements AuthProvider {
  private readonly now: () => number;
  private readonly refreshing = new Map<string, Promise<RefreshOutcome>>();
  /** The refresh token whose last refresh failed, per connection (in memory; compared, never logged). */
  private readonly failedRefresh = new Map<string, string>();
  private polling?: Promise<DevicePollResult>;

  constructor(private readonly deps: GitHubDeviceAuthDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ---- device flow ----

  /** Requests a device code (no `scope`: GitHub App permissions come from the app settings). Replaces any pending flow. */
  async start(def: ConnectionDef): Promise<DeviceStartResult> {
    if (def.id !== GITHUB_ID) return { ok: false, error: NOT_GITHUB };
    if (!(await this.granted([GITHUB_ORIGIN]))) return { ok: false, error: NEEDS_GITHUB };
    const res = await this.post(GITHUB_DEVICE_CODE_URL, { client_id: GITHUB_CLIENT_ID });
    if (!res.ok) return { ok: false, error: await this.clean(res.error) };
    const b = res.body;
    const deviceCode = str(b.device_code);
    const extra = deviceCode ? [deviceCode] : [];
    if (typeof b.error === 'string') return { ok: false, error: await this.clean(this.githubError(b), extra) };
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `GitHub returned an unexpected response (${res.status})` };
    const userCode = str(b.user_code);
    const verificationUri = str(b.verification_uri);
    if (!deviceCode || !userCode || !USER_CODE.test(userCode) || !verificationUri?.startsWith(VERIFICATION_PREFIX)) {
      return { ok: false, error: 'GitHub returned an unexpected response' };
    }
    const expiresAt = this.now() + (posNum(b.expires_in) ?? 900) * 1000;
    const interval = posNum(b.interval) ?? 5;
    try {
      await this.deps.session.set({ [DEVICE_KEY]: { deviceCode, expiresAt, interval } satisfies PendingFlow });
    } catch {
      return { ok: false, error: 'Could not start signing in to GitHub' };
    }
    return { ok: true, userCode, verificationUri, expiresAt, interval };
  }

  /**
   * One poll of the pending flow. Overlapping calls share one request. expired/denied/error clear the flow; a
   * transient failure (network, timeout, 5xx, malformed body) is `pending` and keeps it — `expiresAt` bounds retries.
   */
  poll(def: ConnectionDef): Promise<DevicePollResult> {
    this.polling ??= this.pollOnce(def).finally(() => { this.polling = undefined; });
    return this.polling;
  }

  private async pollOnce(def: ConnectionDef): Promise<DevicePollResult> {
    if (def.id !== GITHUB_ID) return { state: 'error', message: NOT_GITHUB };
    const flow = await this.pending();
    if (!flow) return { state: 'error', message: 'No GitHub sign-in in progress; start again' };
    const end = async (state: DevicePollState, message?: string): Promise<DevicePollResult> => {
      await this.clearFlow(flow.deviceCode);
      return { state, ...(message !== undefined && { message: await this.clean(message, [flow.deviceCode]) }) };
    };
    if (this.now() >= flow.expiresAt) return end('expired', 'The GitHub sign-in code expired; start again');
    if (!(await this.granted([GITHUB_ORIGIN]))) return end('error', NEEDS_GITHUB);

    const res = await this.post(GITHUB_TOKEN_URL, { client_id: GITHUB_CLIENT_ID, device_code: flow.deviceCode, grant_type: DEVICE_GRANT });
    if (!res.ok || res.status >= 500) {
      const why = res.ok ? `GitHub returned an unexpected response (${res.status})` : res.error;
      return { state: 'pending', interval: flow.interval, message: await this.clean(`${why}; still waiting`, [flow.deviceCode]) };
    }
    const b = res.body;
    switch (b.error) {
      case 'authorization_pending':
        return { state: 'pending', interval: flow.interval };
      case 'slow_down': {
        const interval = Math.max(posNum(b.interval) ?? 0, flow.interval + SLOW_DOWN_S);
        await this.updateFlow(flow.deviceCode, { ...flow, interval });
        return { state: 'slow-down', interval };
      }
      case 'expired_token':
        return end('expired', 'The GitHub sign-in code expired; start again');
      case 'access_denied':
        return end('denied', 'GitHub sign-in was cancelled');
      default:
        break;
    }
    if (typeof b.error === 'string') return end('error', this.githubError(b));
    const access = str(b.access_token);
    if (!access) return end('error', `GitHub returned an unexpected response (${res.status})`);
    const refreshToken = str(b.refresh_token);
    const tokens = [flow.deviceCode, access, ...(refreshToken ? [refreshToken] : [])];
    try {
      await this.storeDeviceTokens(access, b);
    } catch (e) {
      await this.clearFlow(flow.deviceCode);
      return {
        state: 'error',
        message: await this.clean(`Could not save the GitHub sign-in; the previous connection was kept: ${e instanceof Error ? e.message : String(e)}`, tokens),
      };
    }
    await this.clearFlow(flow.deviceCode);
    return { state: 'done' };
  }

  /** Reads login + scopes with the new token, then switches the github connection to it (shared rollback helper). */
  private async storeDeviceTokens(access: string, b: Record<string, unknown>): Promise<void> {
    const now = this.now();
    const expiresIn = posNum(b.expires_in);
    const refreshToken = str(b.refresh_token);
    let secret: StoredSecret;
    let accessToken: AccessToken | undefined;
    if (expiresIn !== undefined && refreshToken) {
      const refreshIn = posNum(b.refresh_token_expires_in);
      // Expiring mode: the refresh token is the long-lived secret (token = refreshToken marks the mode).
      secret = { token: refreshToken, refreshToken, ...(refreshIn !== undefined && { refreshExpiresAt: now + refreshIn * 1000 }) };
      accessToken = { token: access, expiresAt: now + expiresIn * 1000 };
    } else {
      secret = { token: access };
    }
    const { login, scopes } = await this.whoAmI(access);
    const base = builtinConnectionDefs().github;
    const def: ConnectionDef = { ...base, auth: 'device-code', scopes, ...(login !== undefined && { login }) };
    await replaceCredentials({ manager: this.deps.manager(), secrets: this.deps.secrets }, def, secret, accessToken);
    this.failedRefresh.delete(def.id);
  }

  /** GET /user with the new token. Best effort: a failure saves the connection without a login. */
  private async whoAmI(token: string): Promise<{ login?: string; scopes: string[] }> {
    if (!(await this.granted([GITHUB_API_ORIGIN]))) return { scopes: [] };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(`${builtinConnectionDefs().github.apiBaseUrl}/user`, {
        method: 'GET', headers: githubHeaders(token), credentials: 'omit', signal: ctrl.signal,
      });
      if (!res.ok) return { scopes: [] };
      const body: unknown = await res.json();
      const login = githubLogin(isObj(body) ? body.login : undefined);
      return { scopes: githubScopes(res.headers), ...(login !== undefined && { login }) };
    } catch {
      return { scopes: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- AuthProvider ----

  async headers(def: ConnectionDef, secrets: SecretStore): Promise<Record<string, string> | null> {
    const cur = await this.usable(def, secrets);
    if (cur !== 'refresh') return cur;
    // Expired or missing (browser restart cleared storage.session) access token: refresh first.
    const outcome = await this.refreshShared(def, secrets);
    const after = await this.usable(def, secrets);
    if (after !== 'refresh') return after;
    // Never send the refresh token as a bearer, nor a token known to be expired.
    if (outcome === 'rejected') throw new ReauthRequiredError(`Sign in to ${def.label} again`);
    throw new Error(`could not refresh the ${def.label} sign-in; try again`);
  }

  /** Headers from what is stored now, null when nothing is, or 'refresh' when only a refresh can produce them. */
  private async usable(def: ConnectionDef, secrets: SecretStore): Promise<Record<string, string> | null | 'refresh'> {
    const access = await secrets.getAccess(def.id);
    if (access && !this.expired(access)) return githubHeaders(access.token);
    const secret = await secrets.getSecret(def.id);
    if (!secret) return access ? githubHeaders(access.token) : null; // no refresh possible: let it 401
    if (!secret.refreshToken) return githubHeaders(secret.token); // long-lived user token
    return 'refresh';
  }

  /** grant_type=refresh_token with client_id only (no client secret). Any error → false. One in flight per connection. */
  async refresh(def: ConnectionDef, secrets: SecretStore): Promise<boolean> {
    return (await this.refreshShared(def, secrets)) === 'ok';
  }

  private refreshShared(def: ConnectionDef, secrets: SecretStore): Promise<RefreshOutcome> {
    let p = this.refreshing.get(def.id);
    if (!p) {
      p = this.refreshOnce(def, secrets)
        .catch((): RefreshOutcome => 'transient')
        .finally(() => { this.refreshing.delete(def.id); });
      this.refreshing.set(def.id, p);
    }
    return p;
  }

  private async refreshOnce(def: ConnectionDef, secrets: SecretStore): Promise<RefreshOutcome> {
    const secret = await secrets.getSecret(def.id);
    const refreshToken = secret?.refreshToken;
    if (!refreshToken) return 'rejected';
    if (secret.refreshExpiresAt !== undefined && this.now() >= secret.refreshExpiresAt) return 'rejected';
    if (this.failedRefresh.get(def.id) === refreshToken) return 'rejected';
    if (!(await this.granted([GITHUB_ORIGIN]))) return 'transient';
    const res = await this.post(GITHUB_TOKEN_URL, { client_id: GITHUB_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken });
    // Only GitHub's explicit answer (an `error` body or a 4xx, below 500) condemns the refresh token; the rest
    // (network, timeout, 5xx, malformed body) is transient.
    const status = res.status;
    const explicit = status !== undefined && status < 500 && ((res.ok && typeof res.body.error === 'string') || status >= 400);
    if (explicit) {
      this.failedRefresh.set(def.id, refreshToken);
      return 'rejected';
    }
    if (!res.ok || res.status < 200 || res.status >= 300) return 'transient';
    const access = str(res.body.access_token);
    if (!access) return 'transient';
    // Compare-and-set: a re-auth, PAT save or remove while the POST was out wins; this response is discarded.
    if ((await secrets.getSecret(def.id))?.refreshToken !== refreshToken) return 'superseded';
    const now = this.now();
    const expiresIn = posNum(res.body.expires_in);
    const rotated = str(res.body.refresh_token);
    const refreshIn = posNum(res.body.refresh_token_expires_in);
    if (expiresIn !== undefined && rotated) {
      await secrets.setSecret(def.id, { token: rotated, refreshToken: rotated, ...(refreshIn !== undefined && { refreshExpiresAt: now + refreshIn * 1000 }) });
      await secrets.setAccess(def.id, { token: access, expiresAt: now + expiresIn * 1000 });
    } else {
      // Expiry was turned off for the app: the new token is long-lived.
      await secrets.setSecret(def.id, { token: access });
      await secrets.clearAccess(def.id);
    }
    this.failedRefresh.delete(def.id);
    return 'ok';
  }

  // ---- helpers ----

  private expired(a: AccessToken): boolean {
    return a.expiresAt !== undefined && this.now() >= a.expiresAt - EXPIRY_SKEW_MS;
  }

  private async granted(origins: string[]): Promise<boolean> {
    try {
      return await this.deps.port.hasPermission({ origins });
    } catch {
      return false;
    }
  }

  private async pending(): Promise<PendingFlow | undefined> {
    const v = (await this.deps.session.get(DEVICE_KEY))[DEVICE_KEY];
    if (!isObj(v) || typeof v.deviceCode !== 'string' || typeof v.expiresAt !== 'number' || typeof v.interval !== 'number') return undefined;
    return { deviceCode: v.deviceCode, expiresAt: v.expiresAt, interval: v.interval };
  }

  /** Clears the flow only if it is still the one polled: a newer `start` must survive an older poll finishing. */
  private async clearFlow(deviceCode: string): Promise<void> {
    try {
      if ((await this.pending())?.deviceCode === deviceCode) await this.deps.session.remove(DEVICE_KEY);
    } catch { /* best effort */ }
  }

  private async updateFlow(deviceCode: string, next: PendingFlow): Promise<void> {
    try {
      if ((await this.pending())?.deviceCode === deviceCode) await this.deps.session.set({ [DEVICE_KEY]: next });
    } catch { /* best effort */ }
  }

  private githubError(b: Record<string, unknown>): string {
    const desc = str(b.error_description);
    return `GitHub sign-in failed: ${String(b.error)}${desc ? ` (${desc})` : ''}`;
  }

  /** Form-encoded POST with Accept: application/json, credentials omitted, 15 s timeout. Never throws. */
  private async post(url: string, params: Record<string, string>): Promise<Posted> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        credentials: 'omit',
        signal: ctrl.signal,
      });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      if (!isObj(body)) return { ok: false, status: res.status, error: `GitHub returned an unexpected response (${res.status})` };
      return { ok: true, status: res.status, body };
    } catch (e) {
      if (ctrl.signal.aborted) return { ok: false, error: `GitHub did not respond within ${REQUEST_TIMEOUT_MS / 1000} s` };
      return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private async clean(message: string, extra: string[] = []): Promise<string> {
    let known: string[] = [];
    try { known = await this.deps.secrets.knownSecrets(); } catch { /* redact token shapes only */ }
    return redact(message, [...extra, ...known]);
  }
}
