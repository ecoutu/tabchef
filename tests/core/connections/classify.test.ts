import { describe, expect, it } from 'vitest';
import { MIN_RATE_LIMIT_BLOCK_MS, SECONDARY_LIMIT_BACKOFF_MS, classifyResponse, parseSsoHeader } from '../../../src/core/connections/classify';

const NOW = 1_700_000_000_000;
const h = (o: Record<string, string> = {}) => new Headers(o);
const SSO_URL = 'https://github.com/orgs/acme/sso?authorization_request=x';

describe('classifyResponse', () => {
  it('2xx → ok with the body as data', () => {
    expect(classifyResponse({ status: 200, headers: h(), body: { a: 1 } }, NOW)).toEqual({ ok: true, status: 200, data: { a: 1 } });
    expect(classifyResponse({ status: 204, headers: h() }, NOW)).toEqual({ ok: true, status: 204, data: undefined });
  });

  it('401 → unauthorized', () => {
    expect(classifyResponse({ status: 401, headers: h(), body: { message: 'Bad credentials' } }, NOW))
      .toMatchObject({ ok: false, kind: 'unauthorized', status: 401, message: expect.stringContaining('Bad credentials') });
  });

  it('Review Focus #3: 403 with X-GitHub-SSO required → sso-required with {org, url}', () => {
    const r = classifyResponse({ status: 403, headers: h({ 'X-GitHub-SSO': `required; url=${SSO_URL}` }) }, NOW);
    expect(r).toMatchObject({ ok: false, kind: 'sso-required', status: 403, sso: { org: 'acme', url: SSO_URL } });
  });

  it('Review Focus #2: 403 with retry-after: 120 → rate-limited at now + 120 s', () => {
    expect(classifyResponse({ status: 403, headers: h({ 'retry-after': '120' }) }, NOW))
      .toMatchObject({ ok: false, kind: 'rate-limited', status: 403, retryAt: NOW + 120_000 });
  });

  it('429 with an HTTP-date retry-after → that date', () => {
    const at = new Date(NOW + 30_000).toUTCString();
    const r = classifyResponse({ status: 429, headers: h({ 'retry-after': at }) }, NOW);
    expect(r).toMatchObject({ kind: 'rate-limited', retryAt: Date.parse(at) });
  });

  it('primary limit: x-ratelimit-remaining 0 → retryAt from x-ratelimit-reset (epoch seconds)', () => {
    const reset = Math.floor(NOW / 1000) + 900;
    const r = classifyResponse({ status: 403, headers: h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }) }, NOW);
    expect(r).toMatchObject({ kind: 'rate-limited', retryAt: reset * 1000 });
  });

  it('secondary limit without headers → now + 60 s [call]', () => {
    expect(SECONDARY_LIMIT_BACKOFF_MS).toBe(60_000);
    expect(classifyResponse({ status: 429, headers: h() }, NOW)).toMatchObject({ kind: 'rate-limited', retryAt: NOW + 60_000 });
    const body = { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' };
    expect(classifyResponse({ status: 403, headers: h(), body }, NOW)).toMatchObject({ kind: 'rate-limited', retryAt: NOW + 60_000 });
  });

  it('an unparseable retry-after, or remaining 0 without a reset, backs off 60 s', () => {
    expect(classifyResponse({ status: 429, headers: h({ 'retry-after': 'soon' }) }, NOW)).toMatchObject({ retryAt: NOW + 60_000 });
    expect(classifyResponse({ status: 403, headers: h({ 'x-ratelimit-remaining': '0' }) }, NOW)).toMatchObject({ retryAt: NOW + 60_000 });
  });

  it('fix 2: a secondary limit carrying normal rate-limit headers (remaining 4000, reset in 50 min) → now + 60 s', () => {
    const reset = String(Math.floor(NOW / 1000) + 50 * 60);
    const headers = h({ 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset });
    expect(classifyResponse({ status: 429, headers }, NOW)).toMatchObject({ kind: 'rate-limited', retryAt: NOW + 60_000 });
    const body = { message: 'You have exceeded a secondary rate limit.' };
    expect(classifyResponse({ status: 403, headers, body }, NOW)).toMatchObject({ kind: 'rate-limited', retryAt: NOW + 60_000 });
    const withRa = h({ 'retry-after': '5', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': reset });
    expect(classifyResponse({ status: 403, headers: withRa }, NOW)).toMatchObject({ retryAt: NOW + 5_000 });
  });

  it('M3-R51: retryAt is floored at now + 1 s (past HTTP date, retry-after 0, skewed reset)', () => {
    expect(MIN_RATE_LIMIT_BLOCK_MS).toBe(1_000);
    const past = new Date(NOW - 3_600_000).toUTCString();
    expect(classifyResponse({ status: 429, headers: h({ 'retry-after': past }) }, NOW)).toMatchObject({ retryAt: NOW + 1_000 });
    expect(classifyResponse({ status: 429, headers: h({ 'retry-after': '0' }) }, NOW)).toMatchObject({ retryAt: NOW + 1_000 });
    const skewed = h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1000) - 30) });
    expect(classifyResponse({ status: 403, headers: skewed }, NOW)).toMatchObject({ retryAt: NOW + 1_000 });
    const gql = { errors: [{ type: 'RATE_LIMITED', message: 'x' }] };
    expect(classifyResponse({ status: 200, headers: skewed, body: gql }, NOW)).toMatchObject({ retryAt: NOW + 1_000 });
  });

  it('a plain 403 is a per-request failure, never unauthorized', () => {
    expect(classifyResponse({ status: 403, headers: h(), body: { message: 'Resource not accessible by integration' } }, NOW))
      .toMatchObject({ ok: false, kind: 'not-found', status: 403 });
  });

  it('404 → not-found, 400/422 → bad-request, 5xx → server', () => {
    expect(classifyResponse({ status: 404, headers: h() }, NOW)).toMatchObject({ kind: 'not-found', status: 404 });
    expect(classifyResponse({ status: 400, headers: h() }, NOW)).toMatchObject({ kind: 'bad-request', status: 400 });
    expect(classifyResponse({ status: 422, headers: h() }, NOW)).toMatchObject({ kind: 'bad-request', status: 422 });
    expect(classifyResponse({ status: 502, headers: h() }, NOW)).toMatchObject({ kind: 'server', status: 502 });
  });

  it('uses Jira errorMessages for the message', () => {
    const r = classifyResponse({ status: 400, headers: h(), body: { errorMessages: ['Field x is bad'] } }, NOW);
    expect(r).toMatchObject({ message: expect.stringContaining('Field x is bad') });
  });

  it('M3-R50: GraphQL 200 with a path-less RATE_LIMITED error → rate-limited', () => {
    const body = { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] };
    expect(classifyResponse({ status: 200, headers: h(), body }, NOW)).toMatchObject({ ok: false, kind: 'rate-limited', status: 200, retryAt: NOW + 60_000 });
    const reset = Math.floor(NOW / 1000) + 300;
    const withReset = classifyResponse({ status: 200, headers: h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }), body }, NOW);
    expect(withReset).toMatchObject({ kind: 'rate-limited', retryAt: reset * 1000 });
  });

  it('GraphQL per-item errors (with a path) stay ok: the source parsers classify them', () => {
    const body = {
      data: { r0: null },
      errors: [
        { type: 'FORBIDDEN', path: ['r0'], message: 'no' },
        { type: 'NOT_FOUND', path: ['r1', 'p0'], message: 'no' },
        { type: 'RATE_LIMITED', path: ['r2'], message: 'later' },
      ],
    };
    expect(classifyResponse({ status: 200, headers: h(), body }, NOW)).toEqual({ ok: true, status: 200, data: body });
  });
});

describe('parseSsoHeader', () => {
  it('parses required; url=… into {org, url}', () => {
    expect(parseSsoHeader(`required; url=${SSO_URL}`)).toEqual({ org: 'acme', url: SSO_URL });
  });
  it('ignores partial-results, non-github urls and garbage', () => {
    expect(parseSsoHeader('partial-results; organizations=1,2')).toBeUndefined();
    expect(parseSsoHeader('required; url=https://evil.com/orgs/acme/sso')).toBeUndefined();
    expect(parseSsoHeader('required; url=not a url')).toBeUndefined();
    expect(parseSsoHeader(null)).toBeUndefined();
  });
});
