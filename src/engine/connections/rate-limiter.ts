import type { ApiResult } from '../../core/connections/types';
import type { KeyValueArea } from './secret-store';

/** storage.session key: survives a worker restart, so a restarted worker honours an earlier block. */
export const RATE_KEY = 'conn.rate';
/** Background requests stop while remaining < 10% of the limit, leaving the rest for user-initiated ones [call]. */
export const BACKGROUND_BUDGET_FRACTION = 0.1;

/** GitHub's `x-ratelimit-resource` buckets (M3-R51). A response without the header counts as `core`. */
export type RateResource = 'core' | 'graphql' | 'search';
const RESOURCES: readonly RateResource[] = ['core', 'graphql', 'search'];
export interface Budget { remaining: number; limit?: number; resetAt: number }
/** `blockedUntil` is per connection; the remaining/limit observations are per resource. */
export interface RateState { blockedUntil?: number; budgets?: Partial<Record<RateResource, Budget>> }
type RateMap = Record<string, RateState>;

/** The bucket a request draws from: GraphQL → graphql, /search/ → search, else core. */
export function resourceFor(path: string): RateResource {
  if (/(^|\/)graphql$/.test(path)) return 'graphql';
  if (path.startsWith('/search/')) return 'search';
  return 'core';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const intHeader = (h: Headers | undefined, name: string): number | undefined => {
  const v = h?.get(name);
  return v != null && /^\s*\d+\s*$/.test(v) ? Number(v) : undefined;
};

function sanitize(raw: unknown): RateMap {
  const out: RateMap = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    const s: RateState = {};
    const bu = num(o.blockedUntil);
    if (bu !== undefined) s.blockedUntil = bu;
    const b = o.budgets;
    if (typeof b === 'object' && b !== null) {
      for (const res of RESOURCES) {
        const e = (b as Record<string, unknown>)[res];
        if (typeof e !== 'object' || e === null) continue;
        const remaining = num((e as Record<string, unknown>).remaining);
        const resetAt = num((e as Record<string, unknown>).resetAt);
        const limit = num((e as Record<string, unknown>).limit);
        if (remaining === undefined || resetAt === undefined) continue;
        (s.budgets ??= {})[res] = { remaining, resetAt, ...(limit !== undefined && { limit }) };
      }
    }
    out[id] = s;
  }
  return out;
}

const asResource = (v: string | null | undefined): RateResource =>
  (RESOURCES as readonly string[]).includes(v ?? '') ? (v as RateResource) : 'core';

/** Per-connection rate state in storage.session `conn.rate`. Writes are serialized; reads always go to storage. */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly session: KeyValueArea, private readonly now: () => number = Date.now) {}

  private async load(): Promise<RateMap> {
    return sanitize((await this.session.get(RATE_KEY))[RATE_KEY]);
  }

  /** `resource`: the bucket the request will use (see resourceFor); the 10% background rule reads only that one. */
  async canSend(id: string, background: boolean, resource: RateResource = 'core'): Promise<{ ok: boolean; retryAt?: number }> {
    await this.chain;
    const s = (await this.load())[id];
    const now = this.now();
    if (!s) return { ok: true };
    if (s.blockedUntil !== undefined && s.blockedUntil > now) return { ok: false, retryAt: s.blockedUntil };
    const b = s.budgets?.[resource];
    if (background && b && b.limit !== undefined && b.limit > 0 && b.resetAt > now && b.remaining < b.limit * BACKGROUND_BUDGET_FRACTION) {
      return { ok: false, retryAt: b.resetAt };
    }
    return { ok: true };
  }

  /**
   * Records a result: a `rate-limited` retryAt blocks the connection; `x-ratelimit-*` headers update the budget of
   * their `x-ratelimit-resource` (default core) and a GraphQL `rateLimit {remaining limit resetAt}` the graphql one.
   */
  record(id: string, r: ApiResult, headers?: Headers, graphqlRate?: { remaining: number; limit?: number; resetAt: string }): Promise<void> {
    const run = this.chain.then(async () => {
      const map = await this.load();
      const s: RateState = { ...map[id] };
      const now = this.now();
      if (s.blockedUntil !== undefined && s.blockedUntil <= now) delete s.blockedUntil;
      if (!r.ok && r.kind === 'rate-limited' && r.retryAt !== undefined) s.blockedUntil = Math.max(s.blockedUntil ?? 0, r.retryAt);

      const remaining = intHeader(headers, 'x-ratelimit-remaining');
      const reset = intHeader(headers, 'x-ratelimit-reset');
      if (remaining !== undefined && reset !== undefined) {
        const limit = intHeader(headers, 'x-ratelimit-limit');
        (s.budgets ??= {})[asResource(headers?.get('x-ratelimit-resource'))] = { remaining, resetAt: reset * 1000, ...(limit !== undefined && { limit }) };
      }
      const gqlReset = graphqlRate ? Date.parse(graphqlRate.resetAt) : NaN;
      if (graphqlRate && Number.isFinite(graphqlRate.remaining) && Number.isFinite(gqlReset)) {
        const limit = graphqlRate.limit !== undefined && Number.isFinite(graphqlRate.limit) ? graphqlRate.limit : undefined;
        (s.budgets ??= {}).graphql = { remaining: graphqlRate.remaining, resetAt: gqlReset, ...(limit !== undefined && { limit }) };
      }
      if (Object.keys(s).length) map[id] = s; else delete map[id];
      await this.session.set({ [RATE_KEY]: map });
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
