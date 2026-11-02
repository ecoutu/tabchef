import type { ApiResult, ConnErrorKind } from './types';

/** Backoff for a rate limit that names no retry time (GitHub secondary limits often omit headers) [call]. */
export const SECONDARY_LIMIT_BACKOFF_MS = 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * `X-GitHub-SSO: required; url=<u>` → `{org, url}`. Only github.com /orgs/<org>/sso URLs are accepted, since the URL is
 * shown to the user as a link. `partial-results; organizations=…` (a 200 with hidden orgs) yields nothing.
 */
export function parseSsoHeader(v: string | null): { org: string; url: string } | undefined {
  const m = v ? /^\s*required\s*;\s*url=(\S+)/i.exec(v) : null;
  if (!m) return undefined;
  let u: URL;
  try {
    u = new URL(m[1]!);
  } catch {
    return undefined;
  }
  const org = /^\/orgs\/([^/]+)\/sso$/.exec(u.pathname)?.[1];
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !org) return undefined;
  return { org: decodeURIComponent(org), url: m[1]! };
}

/** The server's own error text (GitHub `message`, Jira `errorMessages`, GraphQL `errors[].message`), unredacted. */
function bodyMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.slice(0, 300) || undefined;
  if (!isObj(body)) return undefined;
  if (typeof body.message === 'string') return body.message;
  if (Array.isArray(body.errorMessages) && body.errorMessages.length) return body.errorMessages.map(String).join('; ');
  if (Array.isArray(body.errors)) {
    const msgs = body.errors.map((e) => (isObj(e) && typeof e.message === 'string' ? e.message : undefined)).filter(Boolean);
    if (msgs.length) return msgs.join('; ');
  }
  return undefined;
}

/** The shortest block a rate-limited result imposes, so a past HTTP date or a skewed reset still backs off (M3-R51). */
export const MIN_RATE_LIMIT_BLOCK_MS = 1_000;

/**
 * retry-after (delta seconds or an HTTP date); else x-ratelimit-reset (epoch seconds) only when x-ratelimit-remaining
 * is 0 (a primary limit: GitHub sends the reset on every response, so a secondary limit must not wait for it); else
 * now + 60 s. Floored at now + 1 s.
 */
function retryAtFrom(headers: Headers, now: number): number {
  const floor = (t: number) => Math.max(t, now + MIN_RATE_LIMIT_BLOCK_MS);
  const ra = headers.get('retry-after');
  if (ra !== null) {
    if (/^\s*\d+\s*$/.test(ra)) return floor(now + Number(ra) * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return floor(d);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (headers.get('x-ratelimit-remaining')?.trim() === '0' && reset !== null && /^\s*\d+\s*$/.test(reset)) {
    return floor(Number(reset) * 1000);
  }
  return floor(now + SECONDARY_LIMIT_BACKOFF_MS);
}

const fail = (kind: ConnErrorKind, status: number, message: string, extra: Partial<Extract<ApiResult, { ok: false }>> = {}): ApiResult =>
  ({ ok: false, kind, status, message, ...extra });

/** GraphQL `errors[]` entries without a path hit the whole response; with a path they are per-item (the source parsers classify those). */
function graphqlRateLimited(body: unknown): boolean {
  if (!isObj(body) || !Array.isArray(body.errors)) return false;
  return body.errors.some((e) => isObj(e) && e.type === 'RATE_LIMITED' && !(Array.isArray(e.path) && e.path.length));
}

/**
 * Maps an HTTP response to an ApiResult (pure). Messages carry server text verbatim: ConnectionManager redacts them.
 * A plain 403 is a per-request failure ('not-found', as GitHub hides inaccessible resources), never 'unauthorized':
 * only a 401 can flag the connection for re-auth.
 */
export function classifyResponse(r: { status: number; headers: Headers; body?: unknown }, now: number): ApiResult {
  const { status, headers, body } = r;
  const text = bodyMessage(body);
  const msg = (fallback: string) => (text ? `${fallback}: ${text}` : fallback);

  if (status >= 200 && status < 300) {
    if (graphqlRateLimited(body)) return fail('rate-limited', status, msg('Rate limit reached'), { retryAt: retryAtFrom(headers, now) });
    return { ok: true, status, data: body };
  }
  if (status === 401) return fail('unauthorized', status, msg('Unauthorized'));
  if (status === 403 || status === 429) {
    const sso = status === 403 ? parseSsoHeader(headers.get('x-github-sso')) : undefined;
    if (sso) return fail('sso-required', status, `SAML SSO authorization required for ${sso.org}`, { sso });
    const limited = status === 429 || headers.has('retry-after') || headers.get('x-ratelimit-remaining')?.trim() === '0'
      || /rate limit/i.test(text ?? '');
    if (limited) return fail('rate-limited', status, msg('Rate limit reached'), { retryAt: retryAtFrom(headers, now) });
    return fail('not-found', status, msg('Forbidden'));
  }
  if (status === 404) return fail('not-found', status, msg('Not found'));
  if (status >= 400 && status < 500) return fail('bad-request', status, msg(`Bad request (${status})`));
  return fail('server', status, msg(`Server error (${status})`));
}
