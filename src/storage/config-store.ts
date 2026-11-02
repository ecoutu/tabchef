import { browser } from 'wxt/browser';
import { defaultConfig } from '../core/config/defaults';
import { fillConfigDefaults, fillConfigV1, migrateConfig } from '../core/config/migrate';
import { repairConfig, validateConfig } from '../core/config/schema';
import type { Config, ConfigV1 } from '../core/types';

export const QUOTA_WARNING = 'Config too large to sync; saved on this device only.';
export const ADOPTED_REMOTE_WARNING = 'Synced settings were found and loaded; your change on this device was saved as a backup.';
const META_KEY = 'cfg:meta';
const LAST_GOOD_KEY = 'cfg:lastGood';
const BACKUPS_KEY = 'cfg:backups';
const PENDING_KEY = 'cfg:pending'; // local edit not yet confirmed written to sync
const LOCAL_ONLY_KEY = 'cfg:localOnly'; // config too large for sync; local copy is authoritative
const SYNCED_SHA_KEY = 'cfg:syncedSha'; // sha this device last read from / wrote to sync (absent: never synced)
const FRESH_KEY = 'cfg:freshDevice'; // device was fresh (never synced, no local state) when it first loaded; cleared on first sync contact
const CHUNK_BYTES = 7000; // measured on the JSON-escaped value, so the stored item stays far below 8,192 B
const MAX_SYNC_BYTES = 90_000;
const MAX_BACKUPS = 20;
const MAX_RETRIES = 3;

interface Meta { v: 1; n: number; sha: string; at: number }
/** Backups are mixed: a v1 copy is kept when a stored M1 config is migrated (restore() migrates it again). */
export interface Backup { at: number; config: ConfigV1 | Config }
export interface ConfigStoreOptions { debounceMs?: number; retryMs?: number; backoffMs?: number }
const MAX_BACKOFF_MS = 600_000;

type ReadResult =
  | { kind: 'none' }
  | { kind: 'ok'; config: Config; original: ConfigV1 | Config; sha: string; warnings: string[]; migratedFrom?: 1 }
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

type Loaded =
  | { ok: true; config: Config; original: ConfigV1 | Config; warnings: string[]; migratedFrom?: 1 }
  | { ok: false; reason: string };

/**
 * Load path for any stored config (sync, lastGood, backups): migrateConfig (v1 -> v2), fill defaults, repair (see
 * repairConfig), then validate. `original` is what a backup must hold: the default-filled v1 when it migrated (so
 * the only v1 copy is never lost), else the pre-repair v2. Never writes (ruling R2).
 */
function loadStored(raw: unknown): Loaded {
  const m = migrateConfig(raw);
  if (!m.ok) return { ok: false, reason: `invalid: ${m.errors[0] ?? ''}` };
  const filled = fillConfigDefaults(m.config);
  const { config, warnings } = repairConfig(filled);
  const r = validateConfig(config);
  if (!r.ok) return { ok: false, reason: `invalid: ${r.errors[0] ?? ''}` };
  const original = (m.migratedFrom === 1 ? fillConfigV1(raw) : filled) as ConfigV1 | Config;
  return { ok: true, config: r.config, original, warnings, ...(m.migratedFrom && { migratedFrom: m.migratedFrom }) };
}

function parseConfig(json: string): Loaded {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  return loadStored(raw);
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
  private repairWarning?: string; // rules disabled while loading a stored config; cleared by the next save
  /**
   * Genuinely fresh device: load found no synced sha, no lastGood, no PENDING/LOCAL_ONLY flag, and sync was empty.
   * Only then may the first write adopt a config that appeared in sync meanwhile (I4). After a 'bad' read, or on any
   * device with local state, the local edit is authoritative.
   */
  private freshDevice = false;
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

  /** Stores a config. Serialized with update(), so a set issued after an update is never overwritten by it. */
  set(c: Config): Promise<void> {
    return this.serial(() => this.write(c));
  }

  private async write(c: Config): Promise<void> {
    const r = validateConfig(c);
    if (!r.ok) throw new Error(`Refusing to store invalid config: ${r.errors.join('; ')}`);
    await this.get();
    const json = JSON.stringify(c);
    const tooBig = syncCost(splitChunks(json)) > MAX_SYNC_BYTES;
    this.current = c;
    this.repairWarning = undefined;
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

  /**
   * Read-modify-write on the latest config; updates and sets are serialized so none is lost. `fn` may throw to abort
   * (e.g. an optimistic-concurrency check), which rejects the returned promise and writes nothing.
   */
  update(fn: (c: Config) => Config): Promise<Config> {
    return this.serial(async () => {
      const next = fn(await this.get());
      await this.write(next);
      return next;
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
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
    const l = loadStored(b.config);
    if (!l.ok) throw new Error(`Backup at ${at} is not a valid config (${l.reason})`);
    await this.set(l.config);
    this.repairWarning = l.warnings.join(' ') || undefined;
  }

  async status(): Promise<{ syncing: boolean; warning?: string }> {
    await this.get();
    const warning = [this.warning, this.repairWarning].filter(Boolean).join(' ');
    return { syncing: this.dirty !== undefined || this.inflight, ...(warning ? { warning } : {}) };
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

  private async readLastGood(): Promise<{ config: Config; original: ConfigV1 | Config; warnings: string[]; migratedFrom?: 1 } | undefined> {
    const v = (await browser.storage.local.get(LAST_GOOD_KEY))[LAST_GOOD_KEY];
    if (v === undefined) return undefined;
    const r = loadStored(v);
    return r.ok ? r : undefined;
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
    return p.ok
      ? { kind: 'ok', config: p.config, original: p.original, sha, warnings: p.warnings, ...(p.migratedFrom && { migratedFrom: p.migratedFrom }) }
      : { kind: 'bad', reason: p.reason };
  }

  private async load(): Promise<Config> {
    const local = await browser.storage.local.get([LOCAL_ONLY_KEY, PENDING_KEY, SYNCED_SHA_KEY, FRESH_KEY]);
    if (typeof local[SYNCED_SHA_KEY] === 'string') this.syncedSha = local[SYNCED_SHA_KEY];
    const stored = await this.readLastGood();
    const lastGood = stored?.config;
    const lastGoodWarning = stored?.warnings.join(' ') || undefined;
    const hasLocalFlag = local[PENDING_KEY] === true || local[LOCAL_ONLY_KEY] === true;
    if (lastGood && local[LOCAL_ONLY_KEY] === true) {
      this.localOnly = true;
      this.warning = QUOTA_WARNING;
      this.repairWarning = lastGoodWarning;
      // Too large for sync: keep the migrated copy local only (no PENDING; the next fitting save syncs).
      if (stored?.migratedFrom === 1) await this.keepMigrated(stored.original, lastGood, false);
      return (this.current = lastGood);
    }
    if (lastGood && local[PENDING_KEY] === true) {
      // An edit made on this device never reached sync (worker killed inside the debounce window): it wins.
      this.dirty = JSON.stringify(lastGood);
      this.freshDevice = local[FRESH_KEY] === true; // persisted: first save of a fresh device whose sync write was lost
      this.repairWarning = lastGoodWarning;
      if (stored?.migratedFrom === 1) await this.keepMigrated(stored.original, lastGood, true);
      this.scheduleWrite();
      return (this.current = lastGood);
    }
    const r = await this.readSync();
    if (r.kind === 'ok') {
      this.syncedSha = r.sha;
      this.repairWarning = r.warnings.join(' ') || undefined;
      const migrated = r.migratedFrom === 1;
      // Migrated from v1: write the v2 back to sync (PENDING + dirty, never write(): it awaits get(), ruling R2).
      if (migrated) this.dirty = JSON.stringify(r.config);
      await this.enqueueLocal(async () => {
        // Keep the loaded version restorable: a later set() replaces it.
        const backups = await this.readBackups();
        // Back up the original (pre-repair; pre-migration v1) config so restoring gives back exactly what the user had.
        if (JSON.stringify(backups[0]?.config) !== JSON.stringify(r.original)) {
          backups.unshift({ at: this.nextAt(backups), config: r.original });
          backups.length = Math.min(backups.length, MAX_BACKUPS);
        }
        await browser.storage.local.set({
          [LAST_GOOD_KEY]: r.config, [BACKUPS_KEY]: backups, [SYNCED_SHA_KEY]: r.sha, [FRESH_KEY]: false,
          ...(migrated && { [PENDING_KEY]: true }),
        });
      });
      if (migrated) this.scheduleWrite();
      return (this.current = r.config);
    }
    this.repairWarning = lastGood ? lastGoodWarning : undefined;
    if (r.kind === 'none') {
      this.freshDevice = this.syncedSha === undefined && lastGood === undefined && !hasLocalFlag;
      if (this.freshDevice) await this.enqueueLocal(() => browser.storage.local.set({ [FRESH_KEY]: true }));
      if (lastGood && stored?.migratedFrom === 1) {
        this.dirty = JSON.stringify(lastGood);
        await this.keepMigrated(stored.original, lastGood, true);
        this.scheduleWrite();
      }
      return (this.current = lastGood ?? defaultConfig());
    }
    this.warning = `Synced config failed verification (${r.reason}); using the last good copy on this device.`;
    // Sync is unreadable: migrate the local copy only; writing it could overwrite a partially synced newer config.
    if (lastGood && stored?.migratedFrom === 1) await this.keepMigrated(stored.original, lastGood, false);
    this.scheduleRetry(1);
    return (this.current = lastGood ?? defaultConfig());
  }

  /**
   * After a load migrated a v1 lastGood: back up the v1 (unless it is already the newest backup) and store the v2 as
   * lastGood, optionally marking it PENDING for sync. Local-only; never write()/set() (they await get(): deadlock).
   */
  private keepMigrated(v1: ConfigV1 | Config, v2: Config, pending: boolean): Promise<void> {
    return this.enqueueLocal(async () => {
      const backups = await this.readBackups();
      if (JSON.stringify(backups[0]?.config) !== JSON.stringify(v1)) {
        backups.unshift({ at: this.nextAt(backups), config: v1 });
        backups.length = Math.min(backups.length, MAX_BACKUPS);
      }
      await browser.storage.local.set({ [LAST_GOOD_KEY]: v2, [BACKUPS_KEY]: backups, ...(pending && { [PENDING_KEY]: true }) });
    });
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
    if (r.kind !== 'ok') return;
    // Repaired to the version this device already has: nothing to apply, the verification warning is stale.
    if (r.sha === this.syncedSha && this.dirty === undefined && !this.localOnly) this.warning = undefined;
    else await this.applyRemote(r.config, r.sha, r.warnings, r.original);
  }

  private async onRemote(): Promise<void> {
    await this.get();
    if (this.dirty !== undefined || this.localOnly) return; // our pending local write supersedes
    const r = await this.readSync();
    if (r.kind === 'ok') {
      await this.applyRemote(r.config, r.sha, r.warnings, r.original);
    } else if (r.kind === 'bad') {
      this.warning = `Synced config failed verification (${r.reason}); keeping the current config.`;
      this.scheduleRetry(1);
    }
  }

  /** `original` (default: config) is what the backup holds: the v1 when another, older device wrote one to sync. */
  private async applyRemote(config: Config, sha: string, warnings: string[], original: ConfigV1 | Config = config): Promise<void> {
    if (this.dirty !== undefined || this.localOnly || sha === this.syncedSha) return;
    this.syncedSha = sha;
    this.freshDevice = false;
    this.warning = undefined;
    this.repairWarning = warnings.join(' ') || undefined;
    this.current = config;
    await this.enqueueLocal(async () => {
      const backups = await this.readBackups();
      backups.unshift({ at: this.nextAt(backups), config: original });
      backups.length = Math.min(backups.length, MAX_BACKUPS);
      await browser.storage.local.set({ [LAST_GOOD_KEY]: config, [BACKUPS_KEY]: backups, [SYNCED_SHA_KEY]: sha, [FRESH_KEY]: false });
    });
    this.emit(config);
  }

  /**
   * First write from a device that never synced (e.g. a fresh install whose account data arrived after load):
   * the synced config wins and becomes current; the local edit stays restorable as a backup.
   */
  private async adoptRemoteOverLocal(localJson: string, remote: { config: Config; sha: string; warnings: string[] }): Promise<void> {
    this.dirty = undefined;
    this.syncedSha = remote.sha;
    this.freshDevice = false;
    const same = JSON.stringify(remote.config) === localJson;
    if (!same) {
      this.current = remote.config;
      this.warning = ADOPTED_REMOTE_WARNING;
      this.repairWarning = remote.warnings.join(' ') || undefined;
    }
    await this.enqueueLocal(async () => {
      const backups = await this.readBackups();
      if (!same && !backups.some((b) => JSON.stringify(b.config) === localJson)) {
        backups.unshift({ at: this.nextAt(backups), config: JSON.parse(localJson) as Config });
        backups.length = Math.min(backups.length, MAX_BACKUPS);
      }
      await browser.storage.local.set({
        [LAST_GOOD_KEY]: remote.config, [BACKUPS_KEY]: backups, [PENDING_KEY]: false, [LOCAL_ONLY_KEY]: false,
        [SYNCED_SHA_KEY]: remote.sha, [FRESH_KEY]: false,
      });
    });
    if (!same) this.emit(remote.config);
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
      if (this.freshDevice && this.syncedSha === undefined) {
        const remote = await this.readSync();
        if (remote.kind === 'ok') {
          await this.adoptRemoteOverLocal(this.dirty ?? json, remote);
          return;
        }
      }
      const chunks = splitChunks(json);
      const sha = await sha256(json);
      const meta: Meta = { v: 1, n: chunks.length, sha, at: Date.now() };
      this.syncedSha = sha; // set before writing so our own onChanged echo is recognised
      this.freshDevice = false;
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
        await this.enqueueLocal(() => browser.storage.local.set({ [PENDING_KEY]: false, [LOCAL_ONLY_KEY]: false, [SYNCED_SHA_KEY]: sha, [FRESH_KEY]: false }));
      } else {
        await this.enqueueLocal(() => browser.storage.local.set({ [SYNCED_SHA_KEY]: sha, [FRESH_KEY]: false }));
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
