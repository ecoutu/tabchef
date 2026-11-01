import { browser } from 'wxt/browser';
import { defaultConfig } from '../core/config/defaults';
import { validateConfig } from '../core/config/schema';
import type { Config } from '../core/types';

export const QUOTA_WARNING = 'Config too large to sync; saved on this device only.';
const META_KEY = 'cfg:meta';
const LAST_GOOD_KEY = 'cfg:lastGood';
const BACKUPS_KEY = 'cfg:backups';
const PENDING_KEY = 'cfg:pending'; // local edit not yet confirmed written to sync
const LOCAL_ONLY_KEY = 'cfg:localOnly'; // config too large for sync; local copy is authoritative
const CHUNK_BYTES = 7000; // measured on the JSON-escaped value, so the stored item stays far below 8,192 B
const MAX_SYNC_BYTES = 90_000;
const MAX_BACKUPS = 20;
const MAX_RETRIES = 3;

interface Meta { v: 1; n: number; sha: string; at: number }
export interface Backup { at: number; config: Config }
export interface ConfigStoreOptions { debounceMs?: number; retryMs?: number; backoffMs?: number }
const MAX_BACKOFF_MS = 600_000;

type ReadResult =
  | { kind: 'none' }
  | { kind: 'ok'; config: Config; sha: string }
  | { kind: 'bad'; reason: string };

const enc = new TextEncoder();
const chunkKey = (i: number) => `cfg:${i}`;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** UTF-8 aware split; each chunk's JSON-escaped size is <= CHUNK_BYTES (so a chunk never splits a code point). */
export function splitChunks(json: string): string[] {
  const out: string[] = [];
  let cur = '';
  let size = 0;
  for (const ch of json) {
    const cost = enc.encode(JSON.stringify(ch)).length - 2;
    if (size + cost > CHUNK_BYTES) {
      out.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += cost;
  }
  if (cur || out.length === 0) out.push(cur);
  return out;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Forward-compatible: fill fields missing from an older stored config with current defaults (stored values win). */
function migrate(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const d = defaultConfig();
  return { ...d, ...raw, dedupe: { ...d.dedupe, ...(isObj(raw.dedupe) ? raw.dedupe : {}) } };
}

function parseConfig(json: string): { ok: true; config: Config } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  const r = validateConfig(migrate(raw));
  return r.ok ? { ok: true, config: r.config } : { ok: false, reason: `invalid: ${r.errors[0] ?? ''}` };
}

/** Sync cost of a config: sum of JSON-escaped chunk sizes plus keys and meta. */
function syncCost(chunks: string[]): number {
  return chunks.reduce((n, c, i) => n + enc.encode(JSON.stringify(c)).length + chunkKey(i).length, 0) + 150;
}

export class ConfigStore {
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly backoffMs: number;
  private failures = 0;
  private updateChain: Promise<unknown> = Promise.resolve();
  private current?: Config;
  private loading?: Promise<Config>;
  private listeners = new Set<(c: Config) => void>();
  private warning?: string;
  private localOnly = false;
  private dirty?: string; // JSON awaiting a sync write
  private inflight = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private syncedSha?: string; // sha of the last config this device read from or wrote to sync
  private localChain: Promise<void> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: ConfigStoreOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.retryMs = opts.retryMs ?? 5000;
    this.backoffMs = opts.backoffMs ?? 30_000;
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[META_KEY]) return;
      const meta = changes[META_KEY].newValue as Meta | undefined;
      if (!meta || meta.sha === this.syncedSha) return; // removed, or our own echo
      this.onRemote().catch((e: unknown) => console.warn('[tabchef] remote config read failed', e));
    });
  }

  get(): Promise<Config> {
    if (this.current) return Promise.resolve(this.current);
    this.loading ??= this.load().catch((e: unknown) => {
      this.loading = undefined; // do not cache a failed load: the next get() retries
      throw e;
    });
    return this.loading;
  }

  async set(c: Config): Promise<void> {
    const r = validateConfig(c);
    if (!r.ok) throw new Error(`Refusing to store invalid config: ${r.errors.join('; ')}`);
    await this.get();
    const json = JSON.stringify(c);
    const tooBig = syncCost(splitChunks(json)) > MAX_SYNC_BYTES;
    this.current = c;
    this.localOnly = tooBig;
    this.warning = tooBig ? QUOTA_WARNING : undefined;
    if (tooBig) {
      this.dirty = undefined;
      clearTimeout(this.timer);
    } else {
      this.dirty = json;
    }
    await this.enqueueLocal(async () => {
      const backups = await this.readBackups();
      backups.unshift({ at: this.nextAt(backups), config: c });
      backups.length = Math.min(backups.length, MAX_BACKUPS);
      await browser.storage.local.set({
        [LAST_GOOD_KEY]: c, [BACKUPS_KEY]: backups, [PENDING_KEY]: !tooBig, [LOCAL_ONLY_KEY]: tooBig,
      });
    });
    if (!tooBig) this.scheduleWrite();
    this.emit(c);
  }

  /** Read-modify-write on the latest config; concurrent updates are serialized so none is lost. */
  update(fn: (c: Config) => Config): Promise<Config> {
    const run = async () => {
      const next = fn(await this.get());
      await this.set(next);
      return next;
    };
    const p = this.updateChain.then(run, run);
    this.updateChain = p.catch(() => {});
    return p;
  }

  onChange(cb: (c: Config) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async backups(): Promise<Backup[]> {
    await this.localChain;
    return this.readBackups();
  }

  async restore(at: number): Promise<void> {
    const b = (await this.backups()).find((x) => x.at === at);
    if (!b) throw new Error(`No backup at ${at}`);
    await this.set(b.config);
  }

  async status(): Promise<{ syncing: boolean; warning?: string }> {
    await this.get();
    return { syncing: this.dirty !== undefined || this.inflight, ...(this.warning ? { warning: this.warning } : {}) };
  }

  /** Writes any pending config to sync now (tests, runtime.onSuspend). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.writeChain = this.writeChain.then(() => this.writeSync());
    return this.writeChain;
  }

  // ---- internals ----

  private emit(c: Config): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(c);
      } catch (e) {
        console.warn('[tabchef] config listener failed', e);
      }
    }
  }

  private enqueueLocal(fn: () => Promise<void>): Promise<void> {
    const p = this.localChain.then(fn);
    this.localChain = p.catch(() => {});
    return p;
  }

  /** Backup ids are timestamps; keep them unique and increasing so restore(at) is unambiguous. */
  private nextAt(backups: Backup[]): number {
    return Math.max(Date.now(), (backups[0]?.at ?? 0) + 1);
  }

  private async readBackups(): Promise<Backup[]> {
    const v = (await browser.storage.local.get(BACKUPS_KEY))[BACKUPS_KEY];
    return Array.isArray(v) ? (v as Backup[]) : [];
  }

  private async readLastGood(): Promise<Config | undefined> {
    const v = (await browser.storage.local.get(LAST_GOOD_KEY))[LAST_GOOD_KEY];
    if (v === undefined) return undefined;
    const r = validateConfig(migrate(v));
    return r.ok ? r.config : undefined;
  }

  private async readSync(): Promise<ReadResult> {
    const meta = (await browser.storage.sync.get(META_KEY))[META_KEY] as Meta | undefined;
    if (meta === undefined) return { kind: 'none' };
    if (!isObj(meta) || meta.v !== 1 || !Number.isInteger(meta.n) || meta.n < 1 || meta.n > 500 || typeof meta.sha !== 'string') {
      return { kind: 'bad', reason: 'bad meta' };
    }
    const keys = Array.from({ length: meta.n }, (_, i) => chunkKey(i));
    const got = await browser.storage.sync.get(keys);
    let json = '';
    for (const k of keys) {
      const part = got[k];
      if (typeof part !== 'string') return { kind: 'bad', reason: `missing chunk ${k}` };
      json += part;
    }
    const sha = await sha256(json);
    if (sha !== meta.sha) return { kind: 'bad', reason: 'checksum mismatch' };
    const p = parseConfig(json);
    return p.ok ? { kind: 'ok', config: p.config, sha } : { kind: 'bad', reason: p.reason };
  }

  private async load(): Promise<Config> {
    const local = await browser.storage.local.get([LOCAL_ONLY_KEY, PENDING_KEY]);
    const lastGood = await this.readLastGood();
    if (lastGood && local[LOCAL_ONLY_KEY] === true) {
      this.localOnly = true;
      this.warning = QUOTA_WARNING;
      return (this.current = lastGood);
    }
    if (lastGood && local[PENDING_KEY] === true) {
      // An edit made on this device never reached sync (worker killed inside the debounce window): it wins.
      this.dirty = JSON.stringify(lastGood);
      this.scheduleWrite();
      return (this.current = lastGood);
    }
    const r = await this.readSync();
    if (r.kind === 'ok') {
      this.syncedSha = r.sha;
      await this.enqueueLocal(async () => {
        // Keep the loaded version restorable: a later set() replaces it.
        const backups = await this.readBackups();
        if (JSON.stringify(backups[0]?.config) !== JSON.stringify(r.config)) {
          backups.unshift({ at: this.nextAt(backups), config: r.config });
          backups.length = Math.min(backups.length, MAX_BACKUPS);
        }
        await browser.storage.local.set({ [LAST_GOOD_KEY]: r.config, [BACKUPS_KEY]: backups });
      });
      return (this.current = r.config);
    }
    if (r.kind === 'none') return (this.current = lastGood ?? defaultConfig());
    this.warning = `Synced config failed verification (${r.reason}); using the last good copy on this device.`;
    this.scheduleRetry(1);
    return (this.current = lastGood ?? defaultConfig());
  }

  private scheduleRetry(attempt: number): void {
    clearTimeout(this.retryTimer);
    if (attempt > MAX_RETRIES) return;
    this.retryTimer = setTimeout(() => {
      this.retryRead(attempt).catch((e: unknown) => console.warn('[tabchef] config re-read failed', e));
    }, this.retryMs);
  }

  private async retryRead(attempt: number): Promise<void> {
    const r = await this.readSync();
    if (r.kind === 'bad') return this.scheduleRetry(attempt + 1);
    if (r.kind === 'ok') await this.applyRemote(r.config, r.sha);
  }

  private async onRemote(): Promise<void> {
    await this.get();
    if (this.dirty !== undefined || this.localOnly) return; // our pending local write supersedes
    const r = await this.readSync();
    if (r.kind === 'ok') {
      await this.applyRemote(r.config, r.sha);
    } else if (r.kind === 'bad') {
      this.warning = `Synced config failed verification (${r.reason}); keeping the current config.`;
      this.scheduleRetry(1);
    }
  }

  private async applyRemote(config: Config, sha: string): Promise<void> {
    if (this.dirty !== undefined || this.localOnly || sha === this.syncedSha) return;
    this.syncedSha = sha;
    this.warning = undefined;
    this.current = config;
    await this.enqueueLocal(async () => {
      const backups = await this.readBackups();
      backups.unshift({ at: this.nextAt(backups), config });
      backups.length = Math.min(backups.length, MAX_BACKUPS);
      await browser.storage.local.set({ [LAST_GOOD_KEY]: config, [BACKUPS_KEY]: backups });
    });
    this.emit(config);
  }

  private scheduleWrite(delay = this.debounceMs): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().catch((e: unknown) => console.warn('[tabchef] config sync failed', e));
    }, delay);
  }

  private async writeSync(): Promise<void> {
    const json = this.dirty;
    if (json === undefined) return;
    this.inflight = true;
    try {
      const chunks = splitChunks(json);
      const sha = await sha256(json);
      const meta: Meta = { v: 1, n: chunks.length, sha, at: Date.now() };
      this.syncedSha = sha; // set before writing so our own onChanged echo is recognised
      const items: Record<string, string> = {};
      chunks.forEach((c, i) => { items[chunkKey(i)] = c; });
      await browser.storage.sync.set(items);
      await browser.storage.sync.set({ [META_KEY]: meta });
      const stale = Object.keys(await browser.storage.sync.get(null)).filter((k) => {
        const m = /^cfg:(\d+)$/.exec(k);
        return m !== null && Number(m[1]) >= chunks.length;
      });
      if (stale.length) await browser.storage.sync.remove(stale);
      this.failures = 0;
      if (this.dirty === json) {
        this.dirty = undefined;
        this.warning = undefined;
        await this.enqueueLocal(() => browser.storage.local.set({ [PENDING_KEY]: false, [LOCAL_ONLY_KEY]: false }));
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/QUOTA_BYTES/.test(msg)) {
        // Too large for sync (total or per-item). Rate limits (MAX_WRITE_OPERATIONS_*) are NOT this.
        if (this.dirty === json) {
          this.localOnly = true;
          this.warning = QUOTA_WARNING;
          this.dirty = undefined;
          await this.enqueueLocal(() => browser.storage.local.set({ [PENDING_KEY]: false, [LOCAL_ONLY_KEY]: true }));
        } else {
          this.scheduleWrite(); // a newer set arrived during the write; it decides
        }
      } else {
        // Rate limit or transient error: stay dirty (pending flag is persisted) and retry with backoff.
        this.failures++;
        this.warning = 'Could not sync config; saved on this device and will retry.';
        console.warn('[tabchef] config sync write failed', e);
        this.scheduleWrite(Math.min(this.backoffMs * 2 ** (this.failures - 1), MAX_BACKOFF_MS));
      }
    } finally {
      this.inflight = false;
    }
  }
}
