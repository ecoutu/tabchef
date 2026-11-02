import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { BACKGROUND_BUDGET_FRACTION, RATE_KEY, RateLimiter } from '../../../src/engine/connections/rate-limiter';

const NOW = 1_700_000_000_000;
let now = NOW;
const mk = () => new RateLimiter(browser.storage.session, () => now);
const limited = (retryAt: number) => ({ ok: false as const, kind: 'rate-limited' as const, status: 403, message: 'rate limited', retryAt });
const OK = { ok: true as const, status: 200, data: {} };

describe('RateLimiter', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    now = NOW;
  });

  it('an unknown connection can send', async () => {
    expect(await mk().canSend('github', true)).toEqual({ ok: true });
  });

  it('a rate-limited result blocks until retryAt, persisted in storage.session conn.rate', async () => {
    const l = mk();
    await l.record('github', limited(NOW + 120_000));
    expect(await l.canSend('github', false)).toEqual({ ok: false, retryAt: NOW + 120_000 });
    expect((await browser.storage.session.get(RATE_KEY))[RATE_KEY]).toMatchObject({ github: { blockedUntil: NOW + 120_000 } });
    expect(await l.canSend('jira', false)).toEqual({ ok: true });
    now = NOW + 120_000;
    expect(await l.canSend('github', false)).toEqual({ ok: true });
  });

  it('survives a new instance over the same storage (worker restart)', async () => {
    await mk().record('github', limited(NOW + 120_000));
    expect(await mk().canSend('github', true)).toEqual({ ok: false, retryAt: NOW + 120_000 });
  });

  it('Review Focus #2: GraphQL remaining 400 of 5,000 → background false, foreground true', async () => {
    expect(BACKGROUND_BUDGET_FRACTION).toBe(0.1);
    const l = mk();
    const resetAt = new Date(NOW + 30 * 60_000).toISOString();
    await l.record('github', OK, undefined, { remaining: 400, limit: 5000, resetAt });
    expect(await l.canSend('github', true, 'graphql')).toEqual({ ok: false, retryAt: Date.parse(resetAt) });
    expect(await l.canSend('github', false, 'graphql')).toEqual({ ok: true });
    // Other resources keep their own budget.
    expect(await l.canSend('github', true, 'core')).toEqual({ ok: true });
    // At or above 10% background polling continues.
    await l.record('github', OK, undefined, { remaining: 500, limit: 5000, resetAt });
    expect(await l.canSend('github', true, 'graphql')).toEqual({ ok: true });
  });

  it('the budget rule lapses once the window resets', async () => {
    const l = mk();
    await l.record('github', OK, undefined, { remaining: 10, limit: 5000, resetAt: new Date(NOW + 1000).toISOString() });
    expect((await l.canSend('github', true, 'graphql')).ok).toBe(false);
    now = NOW + 1000;
    expect((await l.canSend('github', true, 'graphql')).ok).toBe(true);
  });

  it('reads the budget from x-ratelimit-* headers', async () => {
    const l = mk();
    const reset = Math.floor(NOW / 1000) + 600;
    await l.record('github', OK, new Headers({ 'x-ratelimit-remaining': '20', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(reset) }));
    expect(await l.canSend('github', true)).toEqual({ ok: false, retryAt: reset * 1000 });
    expect(await l.canSend('github', false)).toEqual({ ok: true });
  });

  it('M3-R51: budgets are per x-ratelimit-resource; a REST 4990/5000 reading does not cancel a GraphQL 400/5000 one', async () => {
    const l = mk();
    const resetAt = new Date(NOW + 30 * 60_000).toISOString();
    const reset = String(Math.floor(NOW / 1000) + 600);
    await l.record('github', OK, new Headers({ 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '400', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset }), { remaining: 400, limit: 5000, resetAt });
    await l.record('github', OK, new Headers({ 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset }));
    expect((await l.canSend('github', true, 'graphql')).ok).toBe(false);
    expect((await l.canSend('github', true, 'core')).ok).toBe(true);
    // search has its own (small) budget: 2/30 is under 10%.
    await l.record('github', OK, new Headers({ 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '2', 'x-ratelimit-limit': '30', 'x-ratelimit-reset': reset }));
    expect((await l.canSend('github', true, 'search')).ok).toBe(false);
    expect((await l.canSend('github', true, 'core')).ok).toBe(true);
    // A missing resource header counts as core.
    await l.record('github', OK, new Headers({ 'x-ratelimit-remaining': '1', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset }));
    expect((await l.canSend('github', true)).ok).toBe(false);
    expect((await l.canSend('github', true, 'graphql')).ok).toBe(false);
  });

  it('blockedUntil stays per connection, whatever the resource', async () => {
    const l = mk();
    await l.record('github', limited(NOW + 5000), new Headers({ 'x-ratelimit-resource': 'search' }));
    for (const res of ['core', 'graphql', 'search'] as const) expect(await l.canSend('github', false, res)).toEqual({ ok: false, retryAt: NOW + 5000 });
  });

  it('a budget without a known limit never blocks background requests', async () => {
    const l = mk();
    await l.record('github', OK, undefined, { remaining: 1, resetAt: new Date(NOW + 1000).toISOString() });
    expect((await l.canSend('github', true, 'graphql')).ok).toBe(true);
  });

  it('concurrent records for different connections both persist', async () => {
    const l = mk();
    await Promise.all([l.record('github', limited(NOW + 5000)), l.record('jira', limited(NOW + 7000))]);
    expect(await mk().canSend('github', false)).toEqual({ ok: false, retryAt: NOW + 5000 });
    expect(await mk().canSend('jira', false)).toEqual({ ok: false, retryAt: NOW + 7000 });
  });

  it('ignores a corrupt conn.rate value', async () => {
    await browser.storage.session.set({ [RATE_KEY]: 'garbage' });
    expect(await mk().canSend('github', true)).toEqual({ ok: true });
    await browser.storage.session.set({ [RATE_KEY]: { github: { blockedUntil: 'x' } } });
    expect(await mk().canSend('github', true)).toEqual({ ok: true });
  });
});
