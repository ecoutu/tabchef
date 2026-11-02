// SourceService (M3 T11): collects the source lookups rules ask for (`Rule.source`), batches them through the
// ConnectionManager, caches results (SourceCache: storage.local `sourceCache`, LRU), falls back to the page adapters when there
// is no usable connection, and reports tabs whose data changed so rules re-evaluate.
//
// Resolution per lookup: 1. the cache (a `final` entry is never refetched, a fresh one not within its TTL); 2. the
// API, when a rule asking for it runs at its connection alternative (`levelFor`, M3-R65) and the connection is `ok`;
// 3. the page adapter (`fallback`) of a loaded, live tab on a granted host, for rules whose level allows page access
// (connection or page); 4. `via: 'none'`. Failures keep the previous data with `stale: true` and `error`: good data never becomes unknown.
import { adapterOf } from '../core/adapters';
import type { AdapterId } from '../core/adapters';
import type { ApiRequest, ApiResult, ConnErrorKind, ConnectionState } from '../core/connections/types';
import { DEFAULT_KEY_PATTERN } from '../core/keys/jira-key';
import { evalCond } from '../core/lang/cond';
import { DURATION, parseDuration } from '../core/lang/duration';
import { varsOf } from '../core/lang/evaluate';
import type { NeedsKind } from '../core/lang/needs';
import type { CompiledRule, Cond, Program, Rule, SourceQueryKind, TabFacts } from '../core/lang/types';
import { matchesPattern } from '../core/match/pattern';
import { renderTemplate } from '../core/match/template';
import { buildKeySearchQuery, buildPrStateQuery, parseKeySearchResponse, parsePrStateResponse, prKey, type PrRef } from '../core/sources/github';
import { buildIssueSearch, parseIssueSearch, resolveInHalves, type IssueFailureDetail } from '../core/sources/jira';
import { pickFields, SOURCE_QUERIES } from '../core/sources/registry';
import type { JiraIssue, PrInfo, SourceEntry } from '../core/sources/types';
import type { Snapshot } from '../core/types';
import { isExemptUrl } from '../core/url/normalize';
import type { BrowserPort } from '../platform/browser-port';
import type { ConnectionManager } from './connections/manager';
import { resourceFor, type RateLimiter } from './connections/rate-limiter';
import type { KeyValueArea } from './connections/secret-store';
import type { PageFacts } from './page-facts';
import { hasData, publicOf, SourceCache, type CacheEntry } from './source-cache';

export { CACHE_MAX, SOURCE_CACHE_KEY } from './source-cache';
export const SOURCES_ALARM = 'sources.refresh';
export const SOURCES_PERIOD_MINUTES = 5;
export const POPUP_THROTTLE_MS = 30_000;
/** The shortest `sources.refresh` period, as the `refreshEvery` params' `min` (M3-R75). */
export const SOURCES_MIN_PERIOD_MINUTES = 1;

/**
 * The `sources.refresh` alarm period (M3-R75): the smallest `refreshEvery` among the enabled recipes that declare it
 * as a duration param (Program.refreshEvery, M3-R78), in minutes; SOURCES_PERIOD_MINUTES when none does. Never below 1 minute.
 */
export function refreshPeriodMinutes(p: Program): number {
  const periods = Object.values(p.refreshEvery ?? {}).flatMap((d) => (DURATION.test(d) ? [parseDuration(d) / 60_000] : []));
  return periods.length ? Math.max(SOURCES_MIN_PERIOD_MINUTES, Math.min(...periods)) : SOURCES_PERIOD_MINUTES;
}
/** The connection ids linkedFor / issues use (the built-in GitHub and Jira connections). */
const GITHUB = 'github';
const JIRA = 'jira';

export type RefreshReason = 'alarm' | 'popup' | 'tabs' | 'manual';
type Target = { pr: PrRef } | { issue: string };
/** One tab's lookup for one rule. `key` is the cache key (connection, query and the normalized target). */
export interface SourceRequest {
  tabId: number; url: string; ruleKey: string; connection: string; query: SourceQueryKind; key: string; target: Target;
  fields: Record<string, string>; fallback?: AdapterId;
  /** Not discarded and not frozen: only such a tab's page can be read. */
  live: boolean;
}
export type TabSourceFacts = Record<string /* ruleKey */, SourceEntry<Record<string, unknown>>>;

export interface SourceServiceDeps {
  conn: Pick<ConnectionManager, 'fetch' | 'status' | 'defs'>;
  /** The background budget check (RateLimiter.canSend): background batches are skipped while it says no. */
  limiter?: Pick<RateLimiter, 'canSend'>;
  getProgram: () => Program | Promise<Program>;
  /** The kind of alternative a rule key runs at (PermissionsManager.levelFor); undefined while paused. */
  levelFor: (ruleKey: string) => Promise<NeedsKind | undefined>;
  port: Pick<BrowserPort, 'snapshot' | 'hasPermission'>;
  facts: Pick<PageFacts, 'get'>;
  local: Pick<KeyValueArea, 'get' | 'set'>;
  now?: () => number;
  onUpdated: (tabIds: number[]) => void;
}

const KEY_RE = new RegExp(`^${DEFAULT_KEY_PATTERN}$`);
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const TRUE: Cond = { all: [] };
const NO_DATA = '[]';

function hasField(c: Cond): boolean {
  if ('field' in c) return true;
  if ('all' in c) return c.all.some(hasField);
  if ('any' in c) return c.any.some(hasField);
  if ('not' in c) return hasField(c.not);
  return false;
}
/** `c` with every `field` condition (and every `not` over one) true: the captures of a match the data may still allow. */
function optimistic(c: Cond): Cond {
  if ('field' in c) return TRUE;
  if ('all' in c) return { all: c.all.map(optimistic) };
  if ('any' in c) return { any: c.any.map(optimistic) };
  if ('not' in c) return hasField(c.not) ? TRUE : c;
  return c;
}
const optimisticOf = new WeakMap<Rule, Cond>();

/** The lookup target of rendered `args`, or undefined (missing / malformed args, or a query rules cannot name). */
function targetOf(query: SourceQueryKind, a: Record<string, string>): { target: Target; id: string } | undefined {
  if (query === 'github.pull_request') {
    const [owner, repo, n] = [a.owner?.toLowerCase(), a.repo?.toLowerCase(), a.number]; // M3-R61
    if (!owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo) || !n || !/^[1-9]\d{0,9}$/.test(n)) return undefined;
    const pr = { owner, repo, number: Number(n) };
    return { target: { pr }, id: prKey(pr) };
  }
  if (query === 'jira.issue' && a.key && KEY_RE.test(a.key)) return { target: { issue: a.key }, id: a.key };
  return undefined;
}
const cacheKey = (connection: string, query: SourceQueryKind, id: string) => `${connection}|${query}|${id}`;

/** The error of an entry whose connection is not `ok`, or not usable at its rules' level ('ok' → not-configured; M3-R62: stale and none entries always carry one). */
function stateError(s: ConnectionState | undefined): ConnErrorKind {
  if (s === 'needs-reauth') return 'unauthorized';
  if (s === 'rate-limited') return 'rate-limited';
  if (s === 'error') return 'server';
  return 'not-configured';
}
const detailOf = (r: { retryAt?: number; sso?: { org: string; url: string } }): IssueFailureDetail =>
  ({ ...(r.retryAt !== undefined && { retryAt: r.retryAt }), ...(r.sso && { sso: r.sso }) });
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export class SourceService {
  private readonly cache: SourceCache;
  private byTab = new Map<number, { url: string; reqs: SourceRequest[] }>();
  private lastPopup = -Infinity;
  /** Per indexed tab, the picked data last reported through onUpdated (or seen at load): what rules have read. */
  private reported = new Map<number, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  /** The cache loaded and the open tabs indexed (no network): factsFor answers from here on. */
  readonly ready: Promise<void>;

  constructor(private readonly deps: SourceServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.cache = new SourceCache(deps.local);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    await this.cache.load();
    try {
      this.index(await this.deps.port.snapshot(), await this.deps.getProgram());
      this.reported = this.dataByTab();
    } catch (e) {
      console.warn('[tabchef] source index failed; the next refresh indexes', e);
    }
  }

  /** Awaits the first load and retries a failed one. */
  private async ensureLoaded(): Promise<void> {
    await this.ready;
    await this.cache.ensureLoaded();
  }

  /**
   * Runs `fn`, then settles, also when `fn` failed midway (what changed is saved and reported). `fn`'s own error wins:
   * a settle failing after it is logged, not thrown over it.
   */
  private async settling<T>(fn: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      await this.settle().catch((s: unknown) => { console.warn('[tabchef] source save failed after a failed refresh', s); });
      throw e;
    }
    await this.settle();
    return result;
  }

  /** Saves, then reports the indexed tabs whose picked data differs from what was last reported. */
  private async settle(): Promise<void> {
    await this.cache.save();
    const now = this.dataByTab();
    const changed = [...now].filter(([id, d]) => (this.reported.get(id) ?? NO_DATA) !== d).map(([id]) => id);
    this.reported = now;
    if (changed.length) this.deps.onUpdated(changed);
  }

  /**
   * Every rule with a `source`, on every tab whose URL is not exempt (discarded and frozen tabs too: only the URL is
   * needed): the match with `field` conditions taken as true gives the captures that render the `args`.
   */
  requestsFor(snap: Snapshot, p: Program): SourceRequest[] {
    const rules = p.rules.filter((r): r is CompiledRule & { rule: { source: NonNullable<Rule['source']> } } => !!r.rule.source);
    const out: SourceRequest[] = [];
    if (!rules.length) return out;
    const byId = new Map(snap.tabs.map((t) => [t.id, t]));
    const titles = new Map(snap.groups.map((g) => [g.id, g.title]));
    for (const t of snap.tabs) {
      const url = t.pendingUrl || t.url;
      if (isExemptUrl(url)) continue;
      const live = !t.discarded && !t.frozen;
      const page = live ? this.deps.facts.get(t.id) : undefined;
      const opener = t.openerTabId !== undefined ? byId.get(t.openerTabId) : undefined;
      const groupTitle = t.groupId !== -1 ? titles.get(t.groupId) : undefined;
      const f: TabFacts = { tab: t, ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }), ...(page && { page }) };
      for (const r of rules) {
        let cond = optimisticOf.get(r.rule);
        if (!cond) optimisticOf.set(r.rule, (cond = optimistic(r.rule.match)));
        const c = evalCond(cond, f, this.now());
        if (!c.ok) continue;
        const { vars } = varsOf(r, c.captures, f);
        const s = r.rule.source;
        const args = Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, renderTemplate(v, vars, p.tables)]));
        const tg = targetOf(s.query, args);
        if (!tg) continue;
        out.push({
          tabId: t.id, url, ruleKey: r.key, connection: s.connection, query: s.query, key: cacheKey(s.connection, s.query, tg.id),
          target: tg.target, fields: s.fields, live, ...(s.fallback && { fallback: s.fallback.adapter }),
        });
      }
    }
    return out;
  }

  private index(snap: Snapshot, p: Program): SourceRequest[] {
    const reqs = this.requestsFor(snap, p);
    const urls = new Map(snap.tabs.map((t) => [t.id, t.pendingUrl || t.url]));
    this.byTab = new Map();
    for (const r of reqs) {
      const e = this.byTab.get(r.tabId) ?? { url: urls.get(r.tabId) ?? r.url, reqs: [] };
      e.reqs.push(r);
      this.byTab.set(r.tabId, e);
    }
    return reqs;
  }

  /**
   * The tab's source entries per rule key, `data` projected to the rule's `fields` (pickFields: PrState 'unknown' is
   * never a value, M3-R45). Undefined when nothing is known, or when `url` differs from the URL the tab was indexed at.
   */
  factsFor(tabId: number, url?: string): TabSourceFacts | undefined {
    const t = this.byTab.get(tabId);
    if (!t || (url !== undefined && url !== t.url)) return undefined;
    const out: TabSourceFacts = {};
    for (const r of t.reqs) {
      const e = this.cache.get(r.key);
      if (!e) continue;
      const { data, ...rest } = publicOf(e);
      out[r.ruleKey] = { ...rest, ...(data !== undefined && { data: pickFields(data, r.fields) }) };
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** Popup refreshes run at most once per POPUP_THROTTLE_MS; refreshes run one at a time. */
  refresh(reason: RefreshReason): Promise<void> {
    if (reason === 'popup') {
      if (this.now() - this.lastPopup < POPUP_THROTTLE_MS) return Promise.resolve();
      this.lastPopup = this.now();
    }
    return this.serial(() => this.run(reason));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async run(reason: RefreshReason): Promise<void> {
    await this.ensureLoaded();
    const [p, snap] = [await this.deps.getProgram(), await this.deps.port.snapshot()];
    const reqs = this.index(snap, p);
    await this.settling(() => this.resolve(reqs, reason));
  }

  private async resolve(reqs: SourceRequest[], reason: RefreshReason): Promise<void> {
    const now = this.now();
    const background = reason === 'alarm' || reason === 'tabs';
    const states = new Map((await this.deps.conn.status()).map((s) => [s.id, s.state]));
    const kinds = new Map<string, NeedsKind | undefined>();
    for (const r of reqs) if (!kinds.has(r.ruleKey)) kinds.set(r.ruleKey, await this.deps.levelFor(r.ruleKey));
    const byKey = new Map<string, SourceRequest[]>();
    for (const r of reqs) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    const apiGroups = new Map<string, SourceRequest[]>(); // `${connection}|${query}` -> one request per key
    for (const [key, rs] of byKey) {
      const r = rs[0]!;
      const e = this.cache.touch(key, now);
      const state = states.get(r.connection);
      const blocked = (e?.retryAt ?? 0) > now;
      // M3-R65: the API only for a rule at its connection alternative; the page for one whose level allows page access.
      const api = state === 'ok' && rs.some((x) => kinds.get(x.ruleKey) === 'connection');
      if (e && (e.final || this.fresh(e, r.query, now))) {
        if (!api) this.cache.markStale(e, stateError(state));
        else this.cache.unstale(e); // a final entry, usable again
        continue;
      }
      if (api && !blocked) {
        const g = `${r.connection}|${r.query}`;
        apiGroups.set(g, [...(apiGroups.get(g) ?? []), r]);
        continue;
      }
      const page = await this.readPage(rs.filter((x) => { const k = kinds.get(x.ruleKey); return k === 'connection' || k === 'page'; }));
      if (page) this.cache.putPage(key, page, now);
      else this.fail(key, r.target, blocked ? 'rate-limited' : stateError(state), blocked ? { retryAt: e!.retryAt! } : {}, now);
    }
    for (const rs of apiGroups.values()) {
      const { connection, query } = rs[0]!;
      if (query === 'github.pull_request') await this.fetchPrs(connection, rs, background, now);
      else await this.fetchIssues(connection, rs.map((r) => (r.target as { issue: string }).issue), background, now);
    }
  }

  /**
   * Per indexed tab, its picked data and whether it is stale (JSON; NO_DATA when none): what rules and closes read. A
   * stale flag flipping is a change (M3-R92): a close never acts on stale data (M3-R90), so fresh -> stale must cancel a
   * pending close and stale -> fresh (same data, e.g. after a re-auth) must re-arm it. The error kind alone is no change.
   */
  private dataByTab(): Map<number, string> {
    const out = new Map<number, string>();
    for (const id of this.byTab.keys()) {
      const f = this.factsFor(id) ?? {};
      out.set(id, JSON.stringify(Object.entries(f).filter(([, e]) => e.data && Object.keys(e.data).length)
        .map(([k, e]) => (e.stale ? [k, e.data, 'stale'] : [k, e.data]))));
    }
    return out;
  }

  private fresh(e: CacheEntry, query: SourceQueryKind, now: number): boolean {
    return e.via === 'api' && !e.stale && now - e.fetchedAt < SOURCE_QUERIES[query].ttlMs;
  }

  /** A failed lookup (SourceCache.fail); a PR's `none` entry holds the PR with state 'unknown'. */
  private fail(key: string, target: Target | undefined, error: ConnErrorKind, d: IssueFailureDetail, now: number): void {
    const data = target && 'pr' in target
      ? { ...target.pr, state: 'unknown', url: `https://github.com/${target.pr.owner}/${target.pr.repo}/pull/${target.pr.number}` } : undefined;
    this.cache.fail(key, error, d, now, data);
  }

  /** The page adapter's reading of a loaded, live tab on a granted host (the first usable one), or undefined. */
  private async readPage(rs: SourceRequest[]): Promise<object | undefined> {
    for (const r of rs) {
      const a = r.fallback !== undefined ? adapterOf(r.fallback) : undefined;
      if (!a || !r.live || !matchesPattern(a.urlPattern, r.url)) continue;
      const page = this.deps.facts.get(r.tabId);
      if (!page || !(await this.deps.port.hasPermission({ origins: [`${new URL(r.url).origin}/*`] }))) continue;
      const parsed = a.parse(page.extracts) as Partial<PrInfo & JiraIssue>;
      if ('pr' in r.target) {
        if (parsed.state !== undefined && parsed.state !== 'unknown') return { ...r.target.pr, url: r.url, ...parsed };
      } else if (Object.keys(parsed).length) return { key: r.target.issue, url: r.url, ...parsed };
    }
    return undefined;
  }

  private async send(connection: string, req: ApiRequest, background: boolean): Promise<ApiResult | undefined> {
    if (background && this.deps.limiter && !(await this.deps.limiter.canSend(connection, true, resourceFor(req.path))).ok) return undefined;
    try {
      return await this.deps.conn.fetch(connection, { ...req, background });
    } catch (e) {
      return { ok: false, kind: 'network', message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async fetchPrs(connection: string, rs: SourceRequest[], background: boolean, now: number): Promise<void> {
    for (const batch of chunks(rs, SOURCE_QUERIES['github.pull_request'].batch)) {
      const q = buildPrStateQuery(batch.map((r) => (r.target as { pr: PrRef }).pr));
      const res = await this.send(connection, { method: 'POST', path: '/graphql', json: { query: q.query, variables: q.variables } }, background);
      if (!res) return; // background budget spent: leave the rest as they are
      if (!res.ok) {
        for (const r of batch) this.fail(r.key, r.target, res.kind, detailOf(res), now);
        continue;
      }
      const parsed = parsePrStateResponse(res.data, q.aliases);
      const errors = new Map(parsed.errors.map((e) => [e.key, e]));
      for (const r of batch) {
        const id = prKey((r.target as { pr: PrRef }).pr);
        const err = errors.get(id);
        const info = parsed.prs.get(id);
        if (err || !info) this.fail(r.key, r.target, err?.kind ?? 'not-found', detailOf(err ?? {}), now);
        else this.cache.put(r.key, { data: info, via: 'api', fetchedAt: now, final: SOURCE_QUERIES['github.pull_request'].final(info), stale: false }, now);
      }
    }
  }

  /** jira.issue lookups of `keys` in batches (bad requests bisected, M3-R31); stops when the background budget is spent. */
  private async fetchIssues(connection: string, keys: string[], background: boolean, now: number): Promise<void> {
    const def = (await this.deps.conn.defs()).find((d) => d.id === connection);
    if (!def) return;
    const site = def.jira?.site ?? new URL(def.baseUrl).host;
    let revalidated = false;
    for (const batch of chunks(keys, SOURCE_QUERIES['jira.issue'].batch)) {
      let spent = false;
      const r = await resolveInHalves(batch, async (ks) => {
        const res = await this.send(connection, buildIssueSearch(ks), background);
        if (!res) { spent = true; return { ok: true, issues: new Map() }; }
        return res.ok ? { ok: true, issues: parseIssueSearch(res.data, site) } : { ok: false, kind: res.kind, ...detailOf(res) };
      });
      if (spent) return;
      // M3-R100: an answer without one requested key may be an anonymous / expired session; /myself tells (a 401
      // there flags needs-reauth through the manager). Once per call: the following batches see that state.
      if (r.untrusted && !revalidated) {
        revalidated = true;
        await this.send(connection, { method: 'GET', path: '/rest/api/3/myself' }, background);
      }
      for (const k of batch) {
        const key = cacheKey(connection, 'jira.issue', k);
        const issue = r.issues.get(k);
        if (issue) this.cache.put(key, { data: issue, via: 'api', fetchedAt: now, final: false, stale: false }, now);
        else this.fail(key, { issue: k }, r.errors.get(k) ?? 'not-found', r.details.get(k) ?? {}, now);
      }
    }
  }

  /** Keys whose entry is due a fetch on an `ok` connection (not fresh, final or before its retryAt); touches them. */
  private async due(connection: string, keys: string[], query: SourceQueryKind, key: (k: string) => string, now: number): Promise<string[]> {
    const [st] = await this.deps.conn.status(connection);
    const out: string[] = [];
    for (const k of keys) {
      const e = this.cache.touch(key(k), now);
      if (st?.state === 'ok' && !(e && (e.final || this.fresh(e, query, now) || (e.retryAt ?? 0) > now))) out.push(k);
    }
    return out;
  }

  /**
   * Linked PRs per Jira key (github.search_prs_by_key, 10 keys per query, 15 min TTL): searched in `orgs` (none =
   * `involves:@me`). Keys without results known yet are absent; a failed search keeps the previous results.
   */
  linkedFor(projectKeys: string[], orgs: string[]): Promise<Map<string, PrInfo[]>> {
    return this.serial(async () => {
      await this.ensureLoaded();
      const now = this.now();
      const o = [...new Set(orgs.map((x) => x.toLowerCase()))].sort();
      const keys = [...new Set(projectKeys)];
      const key = (k: string) => cacheKey(GITHUB, 'github.search_prs_by_key', `${k}|${o.join(',')}`);
      await this.settling(async () => {
        for (const batch of chunks(await this.due(GITHUB, keys, 'github.search_prs_by_key', key, now), SOURCE_QUERIES['github.search_prs_by_key'].batch)) {
          const q = buildKeySearchQuery(batch, o);
          const res = (await this.send(GITHUB, { method: 'POST', path: '/graphql', json: { query: q.query, variables: q.variables } }, false))!;
          const parsed = res.ok ? parseKeySearchResponse(res.data, q.aliases, {}, o) : undefined; // orgs: the SSO org (T8 carry)
          for (const k of batch) {
            const err = parsed ? parsed.errors.find((e) => e.key === k) : (res as ApiResult & { ok: false });
            if (err) this.fail(key(k), undefined, err.kind, detailOf(err), now);
            else this.cache.put(key(k), { data: parsed!.byKey.get(k) ?? [], via: 'api', fetchedAt: now, final: false, stale: false }, now);
          }
        }
      });
      const out = new Map<string, PrInfo[]>();
      for (const k of keys) {
        const e = this.cache.get(key(k));
        if (e && hasData(e)) out.set(k, e.data as PrInfo[]);
      }
      return out;
    });
  }

  /** jira.issue entries per key (shared with the tabs' lookups; 5 min TTL). Malformed keys are skipped. */
  issues(keys: string[]): Promise<Map<string, SourceEntry<JiraIssue>>> {
    return this.serial(async () => {
      await this.ensureLoaded();
      const now = this.now();
      const valid = [...new Set(keys)].filter((k) => KEY_RE.test(k));
      const key = (k: string) => cacheKey(JIRA, 'jira.issue', k);
      // Settled: tab rules read these entries too.
      await this.settling(async () => this.fetchIssues(JIRA, await this.due(JIRA, valid, 'jira.issue', key, now), false, now));
      const out = new Map<string, SourceEntry<JiraIssue>>();
      for (const k of valid) {
        const e = this.cache.get(key(k));
        if (e) out.set(k, publicOf(e) as SourceEntry<JiraIssue>);
      }
      return out;
    });
  }
}
