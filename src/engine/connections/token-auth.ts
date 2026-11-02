import { builtinConnectionDefs } from '../../core/connections/builtin';
import { redact } from '../../core/connections/redact';
import type { ConnectionDef, ConnectionStatus } from '../../core/connections/types';
import type { BrowserPort } from '../../platform/browser-port';
import { REQUEST_TIMEOUT_MS, type AuthProvider, type ConnectionManager, type StatusSnapshot } from './manager';
import type { AccessToken, SecretStore, StoredSecret } from './secret-store';

type HeaderBuilder = (token: string) => Record<string, string>;

/** GitHub REST headers for a bearer token (PAT, or a GitHub App user token from the device flow). */
export const githubHeaders: HeaderBuilder = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

/**
 * Per-kind header builders for personal access tokens. Task 6 adds `jira` (Basic base64(email:token)) here; Jira's
 * secret is the email:token pair, so its builder will read more than the bare token.
 */
const BUILDERS: Partial<Record<ConnectionDef['kind'], HeaderBuilder>> = {
  github: githubHeaders,
};

/** Sends the stored personal access token. No `refresh`: a rejected PAT leads to needs-reauth. */
export class TokenAuth implements AuthProvider {
  async headers(def: ConnectionDef, secrets: SecretStore): Promise<Record<string, string> | null> {
    const build = BUILDERS[def.kind];
    if (!build) return null;
    const s = await secrets.getSecret(def.id);
    return s ? build(s.token) : null;
  }
}

export interface SetTokenDeps {
  manager: ConnectionManager;
  secrets: SecretStore;
  port: Pick<BrowserPort, 'hasPermission'>;
  fetch: typeof fetch;
  allowLocalhost?: boolean;
}
export type SetTokenResult = { ok: true; status: ConnectionStatus; login?: string } | { ok: false; error: string };

const MAX_TOKEN_LENGTH = 512;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,100}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const fail = (error: string): SetTokenResult => ({ ok: false, error });

/** Only GitHub's login charset is stored; anything else becomes undefined rather than an arbitrary string. */
export const githubLogin = (raw: unknown): string | undefined =>
  typeof raw === 'string' && GITHUB_LOGIN.test(raw) ? raw : undefined;

/** `x-oauth-scopes` as a list; absent (fine-grained PATs, GitHub App user tokens) → [] (M3-R47). */
export const githubScopes = (headers: Headers): string[] =>
  (headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export interface ReplaceCredentialsDeps {
  manager: Pick<ConnectionManager, 'defs' | 'save' | 'remove' | 'snapshotStatus' | 'restoreStatus'>;
  secrets: SecretStore;
}

/**
 * Switches a connection to new credentials: new values first, stale ones last, with rollback, so a storage failure
 * never drops the previous working credentials. Order: setSecret(new) → setAccess(new) if given → save(def) →
 * clearAccess when no new access token was given. On failure the previous def, status (needs-reauth, last error),
 * secret and access token are restored (best effort) and the original error is rethrown; callers redact it.
 */
export async function replaceCredentials(
  deps: ReplaceCredentialsDeps, def: ConnectionDef, secret: StoredSecret, access?: AccessToken,
): Promise<void> {
  // Captures run before the try: if one throws, nothing has been written yet, so there is nothing to roll back — and
  // rolling back with an undefined capture would delete the working connection.
  const prevStatus: StatusSnapshot = await deps.manager.snapshotStatus(def.id);
  const prevSecret: StoredSecret | undefined = await deps.secrets.getSecret(def.id);
  const prevAccess: AccessToken | undefined = await deps.secrets.getAccess(def.id);
  const prevDef: ConnectionDef | undefined = (await deps.manager.defs()).find((d) => d.id === def.id);
  try {
    await deps.secrets.setSecret(def.id, secret);
    if (access) await deps.secrets.setAccess(def.id, access);
    await deps.manager.save(def);
    if (!access) await deps.secrets.clearAccess(def.id);
  } catch (e) {
    try {
      if (prevDef) await deps.manager.save(prevDef); else await deps.manager.remove(def.id);
    } catch { /* best effort */ }
    try {
      await deps.manager.restoreStatus(prevStatus);
    } catch { /* best effort */ }
    try {
      if (prevSecret) await deps.secrets.setSecret(def.id, prevSecret); else await deps.secrets.clear(def.id);
    } catch { /* best effort */ }
    try {
      if (prevAccess) await deps.secrets.setAccess(def.id, prevAccess); else if (access) await deps.secrets.clearAccess(def.id);
    } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Validates a GitHub personal access token with `GET /user`, then stores it and switches the github connection to
 * `auth: 'token'`. Validate-before-store: the candidate token goes out in a direct request here (same
 * allowed-base, host-permission, timeout and redact rules as the manager) so a rejected token never reaches storage
 * and the manager's needs-reauth/limiter state never sees a token that is not stored. Nothing is stored on failure.
 */
export async function setGitHubToken(deps: SetTokenDeps, rawToken: string): Promise<SetTokenResult> {
  const token = rawToken.trim();
  if (token === '') return fail('Enter a token');
  if (token.length > MAX_TOKEN_LENGTH) return fail('The token is too long');
  if (!PRINTABLE_ASCII.test(token)) return fail('The token contains spaces or invalid characters');

  const def: ConnectionDef = { ...builtinConnectionDefs().github, auth: 'token' };
  // A storage read failure must not turn an honest error result into a rejection; the candidate is always redacted.
  const known = async () => [token, ...(await deps.secrets.knownSecrets().catch(() => [] as string[]))];
  const clean = async (m: string) => redact(m, await known());

  if (!(await deps.port.hasPermission({ origins: def.hosts }))) {
    return fail(`Tabchef needs access to ${def.hosts.map((h) => h.replace(/^https:\/\/|\/\*$/g, '')).join(' and ')}`);
  }

  // Deliberately no limiter check: GitHub limits per token, so a new token must not inherit the old one's block (M3-R52).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await deps.fetch(`${def.apiBaseUrl}/user`, {
      method: 'GET',
      headers: githubHeaders(token),
      credentials: 'omit',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (ctrl.signal.aborted) return fail(`GitHub did not respond within ${REQUEST_TIMEOUT_MS / 1000} s`);
    return fail(await clean(`Network error: ${e instanceof Error ? e.message : String(e)}`));
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
    return fail('GitHub rate limit reached; try again later');
  }
  if (res.status === 401 || res.status === 403) return fail(`GitHub rejected this token (${res.status})`);
  if (!res.ok) return fail(`GitHub returned an unexpected response (${res.status})`);

  let rawLogin: unknown;
  try {
    rawLogin = ((await res.json()) as { login?: unknown }).login;
  } catch {
    rawLogin = undefined;
  }
  if (typeof rawLogin !== 'string' || rawLogin === '') return fail('GitHub returned an unexpected response');
  const login = githubLogin(rawLogin);

  try {
    await replaceCredentials(deps, { ...def, scopes: githubScopes(res.headers), ...(login !== undefined && { login }) }, { token });
  } catch (e) {
    return fail(await clean(`Could not save the token; the previous connection was kept: ${e instanceof Error ? e.message : String(e)}`));
  }
  const [status] = await deps.manager.status(def.id);
  return { ok: true, status: status!, ...(login !== undefined && { login }) };
}
