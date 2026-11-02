// The SourceService's cache (M3 T11): source entries by cache key, persisted in storage.local (`sourceCache`) with
// LRU eviction above CACHE_MAX. Failures keep the previous data with `stale: true` and `error`. Nothing is written
// before the stored cache loaded (a failed load is retried), nor when no entry changed.
import type { ConnErrorKind } from '../core/connections/types';
import type { IssueFailureDetail } from '../core/sources/jira';
import type { SourceEntry } from '../core/sources/types';
import type { KeyValueArea } from './connections/secret-store';

export const SOURCE_CACHE_KEY = 'sourceCache';
export const CACHE_MAX = 2000;

export type CacheEntry = SourceEntry & { usedAt: number };
const VIA = new Set(['api', 'page', 'none']);

/** Has data a rule can read (a `none` entry's placeholder data does not count). */
export const hasData = (e: CacheEntry | undefined): boolean => !!e && e.via !== 'none' && e.data !== undefined;
/** The entry without its LRU bookkeeping. */
export function publicOf(e: CacheEntry): SourceEntry {
  const out: SourceEntry & { usedAt?: number } = { ...e };
  delete out.usedAt;
  return out;
}
const sameDetail = (e: CacheEntry, error: ConnErrorKind, d: IssueFailureDetail): boolean =>
  e.error === error && e.retryAt === d.retryAt && JSON.stringify(e.sso) === JSON.stringify(d.sso);

export class SourceCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** The stored cache loaded. Until then nothing is saved (it would replace the stored cache). */
  private loaded = false;
  /** Entries changed since the last save. */
  private dirty = false;

  constructor(private readonly local: Pick<KeyValueArea, 'get' | 'set'>) {}

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  /** The entry, marked used at `now` (LRU). */
  touch(key: string, now: number): CacheEntry | undefined {
    const e = this.entries.get(key);
    if (e) e.usedAt = now;
    return e;
  }

  /** Reads the stored cache; entries this worker set since (a retried load) win. On failure `loaded` stays false. */
  async load(): Promise<void> {
    try {
      const raw = (await this.local.get(SOURCE_CACHE_KEY))[SOURCE_CACHE_KEY];
      for (const x of Array.isArray(raw) ? raw : []) {
        const [k, e] = Array.isArray(x) ? x as [unknown, Partial<CacheEntry>] : [];
        if (typeof k !== 'string' || typeof e !== 'object' || e === null || typeof e.fetchedAt !== 'number' || !VIA.has(e.via as string)) continue;
        if (this.entries.has(k)) continue;
        this.entries.set(k, { ...e, final: e.final === true, stale: e.stale === true, usedAt: typeof e.usedAt === 'number' ? e.usedAt : 0 } as CacheEntry);
      }
      this.loaded = true;
    } catch (e) {
      console.warn('[tabchef] source cache load failed; retrying before the next write', e);
    }
  }

  /** Retries a failed load. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  markStale(e: CacheEntry, error: ConnErrorKind): void {
    if (e.stale && e.error === error) return;
    e.stale = true;
    e.error = error;
    this.dirty = true;
  }

  /** A stale final entry whose connection is usable again. */
  unstale(e: CacheEntry): void {
    if (!e.stale) return;
    e.stale = false;
    delete e.error;
    this.dirty = true;
  }

  put(key: string, e: SourceEntry, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { ...e, usedAt: now });
    this.dirty = true;
  }

  /**
   * A page reading: never final (it lacks fields such as mergedAt); unchanged data is left as it is. A retryAt still
   * ahead is kept, so the API is not asked again before it.
   */
  putPage(key: string, data: object, now: number): void {
    const e = this.entries.get(key);
    if (e?.via === 'page' && !e.stale && JSON.stringify(e.data) === JSON.stringify(data)) return;
    const retryAt = e?.retryAt !== undefined && e.retryAt > now ? e.retryAt : undefined;
    this.put(key, { data, via: 'page', fetchedAt: now, final: false, stale: false, ...(retryAt !== undefined && { retryAt }) }, now);
  }

  /** A failed lookup: the previous data stays (stale, with the error); without any, a `none` entry with `noneData`. */
  fail(key: string, error: ConnErrorKind, d: IssueFailureDetail, now: number, noneData?: object): void {
    const e = this.entries.get(key);
    if (e && hasData(e)) {
      this.markStale(e, error);
      if ((d.retryAt !== undefined && e.retryAt !== d.retryAt) || (d.sso && JSON.stringify(e.sso) !== JSON.stringify(d.sso))) {
        Object.assign(e, d);
        this.dirty = true;
      }
      return;
    }
    if (e?.via === 'none' && sameDetail(e, error, d)) return; // the same failure again: nothing to write
    this.put(key, { ...(noneData && { data: noneData }), via: 'none', fetchedAt: now, final: false, stale: false, error, ...d }, now);
  }

  /**
   * Evicts the least recently used entries above CACHE_MAX, then writes the cache when an entry changed (LRU touches
   * alone are not written: they ride along with the next change). Never before the stored cache loaded.
   */
  async save(): Promise<void> {
    if (!this.loaded || !this.dirty) return;
    if (this.entries.size > CACHE_MAX) {
      const old = [...this.entries].sort(([, a], [, b]) => a.usedAt - b.usedAt).slice(0, this.entries.size - CACHE_MAX);
      for (const [k] of old) this.entries.delete(k);
    }
    await this.local.set({ [SOURCE_CACHE_KEY]: [...this.entries] });
    this.dirty = false;
  }
}
