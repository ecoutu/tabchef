import { JIRA_TOKEN_EXPIRED, UNSUPPORTED_HOST_MESSAGE, isJiraSite, jiraDef, jiraTokenExpiresInDays } from '../../core/connections/builtin';
import { base64Utf8, redact } from '../../core/connections/redact';
import type { ConnectionDef } from '../../core/connections/types';
import { REQUEST_TIMEOUT_MS, ReauthRequiredError, type AuthProvider } from './manager';
import type { SecretStore } from './secret-store';
import { replaceCredentials, type SetTokenDeps, type SetTokenResult } from './token-auth';

/** `Authorization: Basic base64(email:token)` (UTF-8). */
export const jiraBasic = (email: string, token: string): Record<string, string> => ({
  Authorization: `Basic ${base64Utf8(`${email}:${token}`)}`,
});

const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MYSELF = '/rest/api/3/myself';

/**
 * Jira API tokens (auth 'token'; TokenAuth hands kind 'jira' here): Basic email:token, the email from the def's
 * metadata and the token from SecretStore. Scoped tokens call api.atlassian.com/ex/jira/<cloudId>, classic ones the
 * site. No `refresh`: a rejected token leads to needs-reauth. A token past its user-entered expiry is never sent.
 */
export class JiraAuth implements AuthProvider {
  constructor(private readonly deps: { fetch: typeof fetch; secrets: SecretStore; now: () => number }) {}

  async headers(def: ConnectionDef, secrets: SecretStore): Promise<Record<string, string> | null> {
    const email = def.jira?.email;
    if (def.kind !== 'jira' || !email) return null;
    if ((jiraTokenExpiresInDays(def, this.deps.now()) ?? 1) <= 0) throw new ReauthRequiredError(JIRA_TOKEN_EXPIRED);
    const s = await secrets.getSecret(def.id);
    return s ? jiraBasic(email, s.token) : null;
  }

  /** The site's cloudId from `GET https://<site>/_edge/tenant_info` (unauthenticated). Throws for a site outside *.atlassian.net, before any fetch. */
  async discoverCloudId(site: string): Promise<string> {
    if (!isJiraSite(site)) throw new Error(UNSUPPORTED_HOST_MESSAGE);
    const res = await timed(this.deps.fetch, `https://${site}/_edge/tenant_info`, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) throw new Error(`Could not look up the Jira site ${site} (${res.status})`);
    let cloudId: unknown;
    try {
      cloudId = ((await res.json()) as { cloudId?: unknown }).cloudId;
    } catch {
      cloudId = undefined;
    }
    if (typeof cloudId !== 'string' || !CLOUD_ID.test(cloudId)) throw new Error(`Could not look up the Jira site ${site}`);
    return cloudId;
  }
}

/** Jira session mode (auth 'session'): the browser's Jira cookies, no Authorization header. The manager allows GET only. */
export class JiraSessionAuth implements AuthProvider {
  readonly credentials: RequestCredentials = 'include';

  async headers(): Promise<Record<string, string>> {
    return {};
  }
}

/** fetch with the request timeout; a timeout rejects with a message naming no secret. */
async function timed(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await f(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`Jira did not respond within ${REQUEST_TIMEOUT_MS / 1000} s`);
    throw new Error(`Network error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface JiraTokenInput { site: string; email: string; token: string; tokenKind: 'scoped' | 'classic'; expiresAt?: number }
export interface JiraSetDeps extends SetTokenDeps {
  jira: Pick<JiraAuth, 'discoverCloudId'>;
  now?: () => number;
}

const MAX_TOKEN_LENGTH = 512;
const MAX_EMAIL_LENGTH = 254;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
// One @, a dot in the domain, no whitespace, control characters or ':' (Basic splits email:token at the first ':').
const EMAIL = /^[^\s@:\p{Cc}]+@[^\s@:\p{Cc}]+\.[^\s@:\p{Cc}]+$/u;
const fail = (error: string): SetTokenResult => ({ ok: false, error });
const hostList = (def: ConnectionDef) => def.hosts.map((h) => h.replace(/^https:\/\/|\/\*$/g, '')).join(' and ');

/** A bare `*.atlassian.net` host (trimmed, lowercased), or undefined: schemes, paths and ports are rejected. */
function siteOf(raw: unknown): string | undefined {
  const site = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return isJiraSite(site) ? site : undefined;
}

/**
 * `GET /rest/api/3/myself` with the candidate credentials, outside the manager (validate-before-store, as
 * setGitHubToken): the response, or an error message (unredacted: callers redact).
 */
async function myself(deps: JiraSetDeps, def: ConnectionDef, init: RequestInit): Promise<Response | string> {
  if (!(await deps.port.hasPermission({ origins: def.hosts }))) return `Tabchef needs access to ${hostList(def)}`;
  try {
    return await timed(deps.fetch, `${def.apiBaseUrl}${MYSELF}`, { method: 'GET', ...init });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A 2xx /myself body is a Jira account (an object with an accountId). */
async function isAccount(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { accountId?: unknown };
    return typeof body === 'object' && body !== null && typeof body.accountId === 'string' && body.accountId !== '';
  } catch {
    return false;
  }
}

/**
 * Validates a Jira API token with `GET /rest/api/3/myself` (scoped: after discovering the site's cloudId), then
 * stores it (SecretStore: the token; the def: site, email, kind, cloudId, the user-entered expiry) through
 * replaceCredentials. Nothing is stored on failure; every error is redacted against the candidate.
 */
export async function setJiraToken(deps: JiraSetDeps, input: JiraTokenInput): Promise<SetTokenResult> {
  const now = (deps.now ?? Date.now)();
  const site = siteOf(input.site);
  if (!site) return fail(UNSUPPORTED_HOST_MESSAGE);
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return fail('Enter the email address of your Atlassian account');
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (token === '') return fail('Enter a token');
  if (token.length > MAX_TOKEN_LENGTH) return fail('The token is too long');
  if (!PRINTABLE_ASCII.test(token)) return fail('The token contains spaces or invalid characters');
  if (input.tokenKind !== 'scoped' && input.tokenKind !== 'classic') return fail('Choose a scoped or classic token');
  const { expiresAt } = input;
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now)) {
    return fail('Enter an expiry date in the future');
  }

  const known = async () => [token, `${email}:${token}`, ...(await deps.secrets.knownSecrets().catch(() => [] as string[]))];
  const clean = async (m: string) => redact(m, await known());

  let def = jiraDef(site, input.tokenKind);
  if (input.tokenKind === 'scoped') {
    // tenant_info lives on the site: ask for both hosts before the first request.
    if (!(await deps.port.hasPermission({ origins: def.hosts }))) return fail(`Tabchef needs access to ${hostList(def)}`);
    try {
      def = jiraDef(site, 'scoped', await deps.jira.discoverCloudId(site));
    } catch (e) {
      return fail(await clean(e instanceof Error ? e.message : String(e)));
    }
  }
  def = { ...def, jira: { ...def.jira!, email, ...(expiresAt !== undefined && { tokenExpiresAt: expiresAt }) } };

  // Deliberately no limiter check: a new token must not inherit the old one's block (as setGitHubToken, M3-R52).
  const res = await myself(deps, def, { headers: { Accept: 'application/json', ...jiraBasic(email, token) }, credentials: 'omit' });
  if (typeof res === 'string') return fail(await clean(res));
  if (res.status === 429) return fail('Jira rate limit reached; try again later');
  if (res.status === 401 || res.status === 403) return fail(`Jira rejected this token (${res.status})`);
  if (!res.ok || !(await isAccount(res))) return fail(`Jira returned an unexpected response (${res.status})`);

  try {
    await replaceCredentials(deps, def, { token });
  } catch (e) {
    return fail(await clean(`Could not save the token; the previous connection was kept: ${e instanceof Error ? e.message : String(e)}`));
  }
  const [status] = await deps.manager.status(def.id);
  return { ok: true, status: status! };
}

/**
 * Switches Jira to session mode for `site` (read-only, the browser's Jira cookies) after `GET /rest/api/3/myself`
 * with those cookies answers with an account. A stored token is cleared once the session def is saved
 * (replaceCredentials with no secret).
 */
export async function setJiraSession(deps: JiraSetDeps, input: { site: string }): Promise<SetTokenResult> {
  const site = siteOf(input.site);
  if (!site) return fail(UNSUPPORTED_HOST_MESSAGE);
  const def = jiraDef(site, 'session');
  const clean = async (m: string) => redact(m, await deps.secrets.knownSecrets().catch(() => [] as string[]));

  const res = await myself(deps, def, { headers: { Accept: 'application/json' }, credentials: 'include' });
  if (typeof res === 'string') return fail(await clean(res));
  if (res.status === 429) return fail('Jira rate limit reached; try again later');
  if (res.status === 401 || res.status === 403) return fail(`Not signed in to ${site} in this browser; sign in to Jira and try again`);
  if (!res.ok || !(await isAccount(res))) return fail(`Jira returned an unexpected response (${res.status})`);

  try {
    await replaceCredentials(deps, def, null);
  } catch (e) {
    return fail(await clean(`Could not save the connection; the previous one was kept: ${e instanceof Error ? e.message : String(e)}`));
  }
  const [status] = await deps.manager.status(def.id);
  return { ok: true, status: status! };
}
