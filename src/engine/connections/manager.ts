import { UNSUPPORTED_HOST_MESSAGE, isAllowedBase } from '../../core/connections/builtin';
import { classifyResponse } from '../../core/connections/classify';
import { redact } from '../../core/connections/redact';
import type {
  ApiRequest, ApiResult, AuthStyle, ConnErrorKind, ConnectionDef, ConnectionState, ConnectionStatus,
} from '../../core/connections/types';
import type { BrowserPort } from '../../platform/browser-port';
import { resourceFor, type RateLimiter } from './rate-limiter';
import { CONNECTIONS_KEY, type KeyValueArea, type SecretStore } from './secret-store';

export const REQUEST_TIMEOUT_MS = 15_000;
/** At most 2 requests in flight per connection [call]. */
export const CONCURRENCY_PER_CONNECTION = 2;
/** storage.session: needs-reauth, last error and SSO orgs per connection (survives a worker restart) [call]. */
export const STATUS_KEY = 'conn.status';

/** Builds a connection's auth headers. Tasks 5a/5b/6 implement it (TokenAuth, GitHubDeviceAuth, Jira, session). */
export interface AuthProvider {
  /** null = not configured (nothing stored). */
  headers(def: ConnectionDef, secrets: SecretStore): Promise<Record<string, string> | null>;
  /** Called at most once per request after a 401; true = new credentials stored, retry. */
  refresh?(def: ConnectionDef, secrets: SecretStore): Promise<boolean>;
  credentials?: RequestCredentials;
}

/**
 * Thrown by `AuthProvider.headers()` when the stored credentials can no longer work (e.g. a rejected or expired
 * refresh token): the manager answers unauthorized and marks needs-reauth without sending a request or refreshing.
 */
export class ReauthRequiredError extends Error {
  constructor(message = 'Sign in again') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

declare const SNAPSHOT: unique symbol;
/** Opaque copy of one connection's runtime status (needs-reauth, last error, SSO), from `snapshotStatus`. */
export type StatusSnapshot = { readonly [SNAPSHOT]: true };
interface SnapshotData { id: string; rt?: Runtime }

/** Structural why-log (engine/reconciler WhyLog shape). */
export interface ConnLog { add(e: { action: string; detail: string; at: number }): void }

export interface ConnectionManagerDeps {
  /** storage.local: the `connections` metadata. */
  local: KeyValueArea;
  /** storage.session: `conn.status`. */
  session: KeyValueArea;
  secrets: SecretStore;
  limiter: RateLimiter;
  port: Pick<BrowserPort, 'hasPermission'>;
  fetch: typeof fetch;
  now?: () => number;
  log?: ConnLog;
  auth: Record<AuthStyle, AuthProvider>;
  /** The WXT_E2E_LOCALHOST build flag (M3-R35): the background passes it; core never reads import.meta.env. */
  allowLocalhost?: boolean;
}

interface Runtime {
  needsReauth?: true;
  lastUsedAt?: number;
  lastError?: string;
  lastKind?: ConnErrorKind;
  /** The last rate-limited result's retryAt: only so an extended block changes the signature and emits. */
  retryAt?: number;
  ssoRequired?: { org: string; url: string }[];
}
type RuntimeMap = Record<string, Runtime>;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ERROR_KINDS = new Set<ConnErrorKind>(['network', 'timeout', 'server']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const reauthMessage = (def: ConnectionDef) => `Sign in to ${def.label} again`;
const notConfigured = (message: string): ApiResult => ({ ok: false, kind: 'not-configured', message });
const is401 = (r: ApiResult) => !r.ok && r.kind === 'unauthorized' && r.status === 401;
const TIMED_OUT = Symbol('timed out');

/** Races `p` against the request timeout; a provider that hangs must not hold a slot forever (M3-R51). */
async function withTimeout<T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMED_OUT>((res) => { timer = setTimeout(() => res(TIMED_OUT), REQUEST_TIMEOUT_MS); });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeRuntime(raw: unknown): RuntimeMap {
  if (!isObj(raw) || Array.isArray(raw)) return {};
  const out: RuntimeMap = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!isObj(v)) continue;
    const r: Runtime = {};
    if (v.needsReauth === true) r.needsReauth = true;
    if (typeof v.lastUsedAt === 'number') r.lastUsedAt = v.lastUsedAt;
    if (typeof v.lastError === 'string') r.lastError = v.lastError;
    if (typeof v.lastKind === 'string') r.lastKind = v.lastKind as ConnErrorKind;
    if (typeof v.retryAt === 'number') r.retryAt = v.retryAt;
    if (Array.isArray(v.ssoRequired)) {
      r.ssoRequired = v.ssoRequired.filter((s): s is { org: string; url: string } => isObj(s) && typeof s.org === 'string' && typeof s.url === 'string');
    }
    out[id] = r;
  }
  return out;
}

const signature = (r: Runtime | undefined) => JSON.stringify([r?.needsReauth, r?.lastError, r?.lastKind, r?.retryAt, r?.ssoRequired]);

function graphqlRate(body: unknown): { remaining: number; limit?: number; resetAt: string } | undefined {
  const rl = isObj(body) && isObj(body.data) ? body.data.rateLimit : undefined;
  if (!isObj(rl) || typeof rl.remaining !== 'number' || typeof rl.resetAt !== 'string') return undefined;
  return { remaining: rl.remaining, resetAt: rl.resetAt, ...(typeof rl.limit === 'number' && { limit: rl.limit }) };
}

/** `apiBaseUrl + path` + query, or undefined when the path could leave apiBaseUrl (absolute, `..`, encoded dots, …). */
export function buildUrl(apiBaseUrl: string, req: Pick<ApiRequest, 'path' | 'query'>): string | undefined {
  const p = req.path;
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('://') || p.includes('..') || /%2e|%2f|%5c/i.test(p) || /[\\?#\s]/.test(p)) return undefined;
  const baseStr = apiBaseUrl.replace(/\/+$/, '');
  let u: URL;
  let base: URL;
  try {
    base = new URL(baseStr);
    u = new URL(baseStr + p);
  } catch {
    return undefined;
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  if (u.origin !== base.origin || !u.pathname.startsWith(`${basePath}/`)) return undefined;
  for (const [k, v] of Object.entries(req.query ?? {})) u.searchParams.append(k, v);
  return u.href;
}

/**
 * Every request to a connection's API goes through `fetch`: existence, allowed base, host permission, rate limits and
 * a per-connection concurrency limit are checked before the network; 401s get one refresh; every message that leaves
 * is redacted.
 */
export class ConnectionManager {
  private readonly now: () => number;
  private readonly listeners = new Set<(s: ConnectionStatus) => void>();
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();
  /**
   * Credential generation per connection, bumped by a successful refresh and by save/remove. A 401 on a request sent
   * with an older generation retries with the current credentials instead of refreshing (GitHub App refresh tokens are
   * single-use), and at most one refresh runs per generation. In memory: a restarted worker starts every id at 0.
   */
  private readonly generation = new Map<string, number>();
  private readonly refreshes = new Map<string, { gen: number; p: Promise<boolean> }>();
  /**
   * Per connection, the status last emitted (JSON): permissionsChanged emits only what differs. Updated only when a
   * status is emitted — a status() read (page list, levels, SourceService) between a permission change and its event
   * must not hide the change. Memory only; a connection never emitted since worker start counts as changed.
   */
  private readonly seen = new Map<string, string>();
  private defsChain: Promise<unknown> = Promise.resolve();
  private runtimeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ---- metadata ----

  async defs(): Promise<ConnectionDef[]> {
    const raw = (await this.deps.local.get(CONNECTIONS_KEY))[CONNECTIONS_KEY];
    return Array.isArray(raw) ? (raw as unknown[]).filter((d): d is ConnectionDef => isObj(d) && typeof d.id === 'string') : [];
  }

  /** Adds or replaces a connection. Saving (re-auth) clears needs-reauth, the last error and the SSO list. */
  async save(def: ConnectionDef): Promise<void> {
    if (!ID.test(def.id)) throw new Error(`Invalid connection id: ${def.id}`);
    for (const u of [def.baseUrl, def.apiBaseUrl]) {
      if (u !== '' && !isAllowedBase(u, this.deps.allowLocalhost)) throw new Error(UNSUPPORTED_HOST_MESSAGE);
    }
    await this.serialDefs(async () => {
      const defs = await this.defs();
      const i = defs.findIndex((d) => d.id === def.id);
      if (i >= 0) defs[i] = def; else defs.push(def);
      await this.deps.local.set({ [CONNECTIONS_KEY]: defs });
    });
    this.bumpGeneration(def.id);
    await this.updateRuntime(def.id, () => undefined);
    await this.emit(def.id);
  }

  async remove(id: string): Promise<void> {
    await this.serialDefs(async () => {
      await this.deps.local.set({ [CONNECTIONS_KEY]: (await this.defs()).filter((d) => d.id !== id) });
    });
    await this.deps.secrets.clear(id);
    this.bumpGeneration(id);
    await this.updateRuntime(id, () => undefined);
    await this.emit(id);
  }

  /**
   * Signs out (Connections page): clears the secrets (storage.local and the session access token) and the runtime
   * status, and keeps the def, without the account's login and scopes, so it lists as not-configured.
   */
  async disconnect(id: string): Promise<void> {
    await this.deps.secrets.clear(id);
    this.bumpGeneration(id);
    await this.serialDefs(async () => {
      const defs = await this.defs();
      const i = defs.findIndex((d) => d.id === id);
      if (i < 0) return;
      const next: ConnectionDef = { ...defs[i]!, scopes: [] };
      delete next.login;
      defs[i] = next;
      await this.deps.local.set({ [CONNECTIONS_KEY]: defs });
    });
    await this.updateRuntime(id, () => undefined);
    await this.emit(id);
  }

  /** Snapshot of a connection's runtime status, taken before a credential switch that may need rolling back. */
  async snapshotStatus(id: string): Promise<StatusSnapshot> {
    const rt = await this.runtime(id);
    return { id, ...(rt && { rt: structuredClone(rt) }) } satisfies SnapshotData as unknown as StatusSnapshot;
  }

  /**
   * Rollback only: puts back a status from `snapshotStatus` after a failed credential switch (whose `save` of the
   * previous def cleared needs-reauth / the last error). Accepts nothing but a snapshot, so it cannot invent a state.
   */
  async restoreStatus(snapshot: StatusSnapshot): Promise<void> {
    const { id, rt } = snapshot as unknown as SnapshotData;
    if (await this.updateRuntime(id, () => (rt ? structuredClone(rt) : undefined))) await this.emit(id);
  }

  onStatusChange(cb: (s: ConnectionStatus) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async status(id?: string): Promise<ConnectionStatus[]> {
    const defs = await this.defs();
    const rt = await this.runtimeMap();
    const ids = id !== undefined ? [id] : defs.map((d) => d.id);
    return Promise.all(ids.map((i) => this.statusOf(i, defs.find((d) => d.id === i), rt[i])));
  }

  private async statusOf(id: string, def: ConnectionDef | undefined, rt: Runtime | undefined): Promise<ConnectionStatus> {
    if (!def) return { id, state: 'not-configured', ssoRequired: [], scopes: [] };
    const gate = await this.deps.limiter.canSend(id, false);
    let state: ConnectionState;
    const stored = await this.configured(def);
    // Revoked host access (chrome://extensions, site access "on click") makes a connection with stored credentials
    // unusable: not-configured, so its rules drop to their next alternative (M3-R65) and the page fallback is tried.
    // It wins over needs-reauth: nothing works until the hosts are granted again. `hostsMissing` (origins only, never
    // a secret) tells the Connections page credentials are stored, so it offers Grant access and Disconnect (M3-R96).
    const missing = stored ? await this.missingHosts(def) : [];
    if (missing.length) {
      return {
        id, state: 'not-configured',
        ...(rt?.lastUsedAt !== undefined && { lastUsedAt: rt.lastUsedAt }),
        ...(rt?.lastError !== undefined && { lastError: rt.lastError }),
        hostsMissing: missing,
        ssoRequired: rt?.ssoRequired ?? [],
        scopes: def.scopes,
      };
    }
    // A disconnected connection is not-configured even while an earlier rate-limit block lasts.
    if (rt?.needsReauth) state = 'needs-reauth';
    else if (!stored) state = 'not-configured';
    else if (!gate.ok) state = 'rate-limited';
    else if (rt?.lastKind && ERROR_KINDS.has(rt.lastKind)) state = 'error';
    else state = 'ok';
    return {
      id, state,
      ...(rt?.lastUsedAt !== undefined && { lastUsedAt: rt.lastUsedAt }),
      ...(rt?.lastError !== undefined && { lastError: rt.lastError }),
      ...(!gate.ok && gate.retryAt !== undefined && { blockedUntil: gate.retryAt }),
      ssoRequired: rt?.ssoRequired ?? [],
      scopes: def.scopes,
    };
  }

  /**
   * The def's hosts the extension does not hold (callers ask only for a connection with stored credentials). A
   * failing permission check counts as all missing.
   */
  private async missingHosts(def: ConnectionDef): Promise<string[]> {
    if (!def.hosts.length) return [];
    const has = async (origins: string[]) => {
      try {
        return await this.deps.port.hasPermission({ origins });
      } catch {
        return false;
      }
    };
    if (await has(def.hosts)) return [];
    const missing: string[] = [];
    for (const o of def.hosts) if (!(await has([o]))) missing.push(o);
    return missing.length ? missing : def.hosts;
  }

  /**
   * Host permissions were granted or revoked (permissions.onAdded / onRemoved): each connection whose status differs
   * from the one last emitted is emitted, so the Connections page and capability levels re-list (M3-R96). Entries of
   * removed connections are dropped.
   */
  async permissionsChanged(): Promise<void> {
    const defs = await this.defs();
    for (const id of [...this.seen.keys()]) if (!defs.some((d) => d.id === id)) this.seen.delete(id);
    for (const d of defs) {
      const [st] = await this.status(d.id);
      if (this.seen.get(d.id) !== JSON.stringify(st)) this.notify(st!);
    }
  }

  /** Has a usable base and stored credentials (session auth needs none). No network. */
  private async configured(def: ConnectionDef): Promise<boolean> {
    if (!def.apiBaseUrl || !isAllowedBase(def.apiBaseUrl, this.deps.allowLocalhost)) return false;
    if (def.auth === 'session') return true;
    const [s, a] = await Promise.all([this.deps.secrets.getSecret(def.id), this.deps.secrets.getAccess(def.id)]);
    return !!(s || a);
  }

  // ---- fetch ----

  async fetch(id: string, req: ApiRequest): Promise<ApiResult> {
    return this.redactResult(await this.fetchInner(id, req));
  }

  private async fetchInner(id: string, req: ApiRequest): Promise<ApiResult & { extraSecrets?: string[] }> {
    const def = (await this.defs()).find((d) => d.id === id);
    if (!def) return notConfigured(`${id} is not connected`);
    if ((await this.runtime(id))?.needsReauth) return this.unauthorized(def);
    if (!def.apiBaseUrl) return notConfigured(def.kind === 'jira' ? 'cloudId not discovered yet' : `${def.label} has no API address`);
    if (!isAllowedBase(def.apiBaseUrl, this.deps.allowLocalhost)) return notConfigured(UNSUPPORTED_HOST_MESSAGE);
    if (!(await this.deps.port.hasPermission({ origins: def.hosts }))) {
      const missing: string[] = [];
      for (const o of def.hosts) if (!(await this.deps.port.hasPermission({ origins: [o] }))) missing.push(o);
      return notConfigured(`needs ${(missing.length ? missing : def.hosts).join(', ')}`);
    }
    const resource = resourceFor(req.path);
    const gate = await this.deps.limiter.canSend(id, !!req.background, resource);
    if (!gate.ok) return this.rateLimited(def, gate.retryAt);

    const release = await this.acquire(id);
    try {
      // Re-check after waiting for a slot: a request queued behind a 401 or a rate limit must not go out.
      if ((await this.runtime(id))?.needsReauth) return this.unauthorized(def);
      const again = await this.deps.limiter.canSend(id, !!req.background, resource);
      if (!again.ok) return this.rateLimited(def, again.retryAt);
      const url = buildUrl(def.apiBaseUrl, req);
      if (!url) return { ok: false, kind: 'bad-request', message: 'Invalid request path' };
      return await this.send(def, url, req);
    } finally {
      release();
    }
  }

  private unauthorized(def: ConnectionDef): ApiResult {
    return { ok: false, kind: 'unauthorized', status: 401, message: reauthMessage(def) };
  }

  private rateLimited(def: ConnectionDef, retryAt?: number): ApiResult {
    return { ok: false, kind: 'rate-limited', message: `${def.label} rate limit reached`, ...(retryAt !== undefined && { retryAt }) };
  }

  private async send(def: ConnectionDef, url: string, req: ApiRequest): Promise<ApiResult & { extraSecrets?: string[] }> {
    const provider = this.deps.auth[def.auth];
    if (!provider) return notConfigured(`Unsupported sign-in method for ${def.label}`);
    const extraSecrets: string[] = [];
    let attempt = await this.attempt(def, provider, url, req, extraSecrets);
    if (is401(attempt.result) && !attempt.reauthRequired) {
      // Credentials changed since this request was sent (another request's refresh, or a re-auth save): retry with
      // them. Otherwise refresh, sharing one refresh per generation, and retry once if it succeeded.
      if (this.gen(def.id) !== attempt.gen) attempt = await this.attempt(def, provider, url, req, extraSecrets);
      else if (provider.refresh && (await this.refreshFor(def, provider, attempt.gen))) {
        attempt = await this.attempt(def, provider, url, req, extraSecrets);
      }
    }
    let { result } = attempt;
    if (attempt.headers || (!result.ok && result.kind === 'rate-limited')) {
      await this.deps.limiter.record(def.id, result, attempt.headers, result.ok ? graphqlRate(result.data) : undefined);
    }
    const final401 = is401(result);
    if (final401) result = this.unauthorized(def);
    // A 401 for credentials a save has since replaced must not flag the new ones (M3-R51 save race).
    const reauth = final401 && this.gen(def.id) === attempt.gen;
    await this.afterResult(def, result, reauth, extraSecrets);
    return { ...result, extraSecrets };
  }

  private async attempt(def: ConnectionDef, provider: AuthProvider, url: string, req: ApiRequest, extraSecrets: string[]):
    Promise<{ result: ApiResult; headers?: Headers; gen: number; reauthRequired?: true }> {
    const gen = this.gen(def.id);
    let auth: Record<string, string> | null | typeof TIMED_OUT;
    try {
      auth = await withTimeout(provider.headers(def, this.deps.secrets));
    } catch (e) {
      if (e instanceof ReauthRequiredError) return { gen, reauthRequired: true, result: this.unauthorized(def) };
      return { gen, result: notConfigured(`Could not sign in to ${def.label}: ${e instanceof Error ? e.message : String(e)}`) };
    }
    if (auth === TIMED_OUT) return { gen, result: { ok: false, kind: 'timeout', message: `${def.label} sign-in did not respond within ${REQUEST_TIMEOUT_MS / 1000} s` } };
    if (auth === null) return { gen, result: notConfigured(`Not signed in to ${def.label}`) };
    for (const v of Object.values(auth)) if (v.length >= 8) extraSecrets.push(v, v.replace(/^\S+\s+/, ''));

    const headers: Record<string, string> = { Accept: 'application/json', ...auth };
    if (req.json !== undefined) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(url, {
        method: req.method,
        headers,
        ...(req.json !== undefined && { body: JSON.stringify(req.json) }),
        credentials: provider.credentials ?? 'omit',
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body: unknown;
      if (text !== '') {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      return { gen, result: classifyResponse({ status: res.status, headers: res.headers, body }, this.now()), headers: res.headers };
    } catch (e) {
      if (ctrl.signal.aborted) return { gen, result: { ok: false, kind: 'timeout', message: `${def.label} did not respond within ${REQUEST_TIMEOUT_MS / 1000} s` } };
      return { gen, result: { ok: false, kind: 'network', message: `Network error: ${e instanceof Error ? e.message : String(e)}` } };
    } finally {
      clearTimeout(timer);
    }
  }

  private gen(id: string): number {
    return this.generation.get(id) ?? 0;
  }

  private bumpGeneration(id: string): void {
    this.generation.set(id, this.gen(id) + 1);
  }

  /**
   * One refresh per credential generation: every 401 sent with `gen` shares it, including 401s arriving after it
   * settled (a failed refresh is not retried for the same generation). Success bumps the generation. A throwing or
   * hung (> 15 s) refresh counts as failed.
   */
  private refreshFor(def: ConnectionDef, provider: AuthProvider, gen: number): Promise<boolean> {
    const cur = this.refreshes.get(def.id);
    if (cur && cur.gen === gen) return cur.p;
    const p = (async () => {
      try {
        const ok = (await withTimeout(provider.refresh!(def, this.deps.secrets))) === true;
        if (ok && this.gen(def.id) === gen) this.bumpGeneration(def.id);
        return ok;
      } catch {
        return false;
      }
    })();
    this.refreshes.set(def.id, { gen, p });
    return p;
  }

  private async afterResult(def: ConnectionDef, r: ApiResult, reauth: boolean, extraSecrets: string[]): Promise<void> {
    const now = this.now();
    const secrets = r.ok ? [] : [...(await this.deps.secrets.knownSecrets()), ...extraSecrets];
    const message = r.ok ? '' : redact(r.message, secrets);
    let logDetail: string | undefined;
    const changed = await this.updateRuntime(def.id, (prev) => {
      const next: Runtime = { ...prev };
      if (r.ok) {
        next.lastUsedAt = now;
        delete next.lastError;
        delete next.lastKind;
        delete next.retryAt;
        return next;
      }
      if (reauth) {
        next.needsReauth = true;
        logDetail = `${def.id}: needs re-auth`;
      } else if (r.kind === 'sso-required' && r.sso) {
        const list = next.ssoRequired ?? [];
        if (!list.some((s) => s.org === r.sso!.org)) next.ssoRequired = [...list, r.sso];
        logDetail = `${def.id}: SAML SSO required for ${r.sso.org}`;
        next.lastUsedAt = now;
        return next;
      } else if (r.kind === 'rate-limited') {
        if (r.retryAt !== undefined) next.retryAt = r.retryAt;
        logDetail = `${def.id}: rate limited${r.retryAt !== undefined ? ` until ${new Date(r.retryAt).toISOString()}` : ''}`;
      } else if (!ERROR_KINDS.has(r.kind)) {
        // not-found / bad-request / not-configured: the request failed, the connection did not.
        if (r.status !== undefined) next.lastUsedAt = now;
        return next;
      }
      if (r.kind !== 'rate-limited') delete next.retryAt;
      next.lastError = message;
      next.lastKind = r.kind;
      return next;
    });
    if (logDetail) this.deps.log?.add({ action: 'connection', detail: redact(logDetail, secrets), at: now });
    if (changed) await this.emit(def.id);
  }

  private async redactResult(r: ApiResult & { extraSecrets?: string[] }): Promise<ApiResult> {
    const { extraSecrets = [], ...result } = r;
    if (result.ok) return result as ApiResult;
    const secrets = [...(await this.deps.secrets.knownSecrets()), ...extraSecrets];
    return { ...result, message: redact(result.message, secrets) } as ApiResult;
  }

  // ---- concurrency ----

  private async acquire(id: string): Promise<() => void> {
    if ((this.active.get(id) ?? 0) >= CONCURRENCY_PER_CONNECTION) {
      await new Promise<void>((resolve) => {
        const q = this.waiters.get(id) ?? [];
        q.push(resolve);
        this.waiters.set(id, q);
      });
    } else {
      this.active.set(id, (this.active.get(id) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.get(id)?.shift();
      if (next) next(); // hand the slot over: the active count stays the same
      else this.active.set(id, (this.active.get(id) ?? 1) - 1);
    };
  }

  // ---- runtime status (storage.session conn.status) ----

  private async runtimeMap(): Promise<RuntimeMap> {
    await this.runtimeChain;
    return sanitizeRuntime((await this.deps.session.get(STATUS_KEY))[STATUS_KEY]);
  }

  private async runtime(id: string): Promise<Runtime | undefined> {
    return (await this.runtimeMap())[id];
  }

  /** Serialized read-modify-write of one connection's runtime entry; `fn` returning undefined deletes it. True if it changed. */
  private updateRuntime(id: string, fn: (prev: Runtime | undefined) => Runtime | undefined): Promise<boolean> {
    const run = this.runtimeChain.then(async () => {
      const map = sanitizeRuntime((await this.deps.session.get(STATUS_KEY))[STATUS_KEY]);
      const prev = map[id];
      const next = fn(prev);
      if (next) map[id] = next; else delete map[id];
      await this.deps.session.set({ [STATUS_KEY]: map });
      return signature(prev) !== signature(next);
    });
    this.runtimeChain = run.catch(() => {});
    return run;
  }

  private serialDefs(fn: () => Promise<void>): Promise<void> {
    const run = this.defsChain.then(fn);
    this.defsChain = run.catch(() => {});
    return run;
  }

  private async emit(id: string): Promise<void> {
    if (!this.listeners.size) return;
    const [s] = await this.status(id);
    this.notify(s!);
  }

  /** Delivers a status to the listeners and records it as the last emitted one (only here, never in status()). */
  private notify(s: ConnectionStatus): void {
    this.seen.set(s.id, JSON.stringify(s));
    for (const cb of this.listeners) {
      try { cb(s); } catch { /* a listener must not break fetch */ }
    }
  }
}
