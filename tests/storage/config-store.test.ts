import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { ConfigStore, QUOTA_WARNING } from '../../src/storage/config-store';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config } from '../../src/core/types';

const big = (kb: number, tag = 'x'): Config => {
  const c = defaultConfig();
  c.dedupe.allowDuplicates = Array.from({ length: Math.ceil((kb * 1024) / 30) }, (_, i) => `https://${tag}${i}.example.com/p`);
  return c;
};
const withSite = (s: string): Config => {
  const c = defaultConfig();
  c.dedupe.alwaysSwitchSites = [s];
  return c;
};
const bytes = (s: string) => new TextEncoder().encode(s).length;
const mk = (retryMs = 5000) => new ConfigStore({ debounceMs: 2000, retryMs });
const sync = () => browser.storage.sync;
const local = () => browser.storage.local;

describe('ConfigStore', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('first run returns defaults', async () => {
    expect(await mk().get()).toEqual(defaultConfig());
  });

  it('round-trips a 20 KB config in 3+ chunks, each <= 8192 B including key', async () => {
    const a = mk();
    const c = big(20);
    await a.set(c);
    await a.flush();
    const all = await sync().get(null);
    const meta = all['cfg:meta'] as { n: number };
    expect(meta.n).toBeGreaterThanOrEqual(3);
    for (const [k, v] of Object.entries(all)) expect(bytes(k) + bytes(JSON.stringify(v))).toBeLessThanOrEqual(8192);
    expect(await mk().get()).toEqual(c);
  });

  it('chunks stay under the limit for quote-heavy and multi-byte content', async () => {
    const c = defaultConfig();
    c.dedupe.alwaysSwitchSites = Array.from({ length: 800 }, (_, i) => `https://日本語-é${i}.example.com`);
    const a = mk();
    await a.set(c);
    await a.flush();
    const all = await sync().get(null);
    for (const [k, v] of Object.entries(all)) expect(bytes(k) + bytes(JSON.stringify(v))).toBeLessThanOrEqual(8192);
    expect(await mk().get()).toEqual(c);
  });

  it('corrupted chunk -> lastGood, not a partial config', async () => {
    const a = mk();
    const good = big(20);
    await a.set(good);
    await a.flush();
    const chunk = (await sync().get('cfg:1'))['cfg:1'] as string;
    await sync().set({ 'cfg:1': chunk.slice(0, -5) + 'ZZZZZ' });
    const b = mk();
    expect(await b.get()).toEqual(good);
    expect((await b.status()).warning).toBeTruthy();
  });

  it('meta present but chunk missing -> lastGood', async () => {
    const a = mk();
    const good = big(20);
    await a.set(good);
    await a.flush();
    await sync().remove('cfg:2');
    expect(await mk().get()).toEqual(good);
  });

  it('retries the read after the retry delay and recovers (default 5 s)', async () => {
    const a = mk();
    const good = big(20);
    await a.set(good);
    await a.flush();
    const orig = (await sync().get('cfg:1'))['cfg:1'] as string;
    await sync().set({ 'cfg:1': 'garbage' });
    const b = mk(30);
    expect(await b.get()).toEqual(good);
    expect((await b.status()).warning).toBeTruthy();
    await sync().set({ 'cfg:1': orig });
    await vi.waitFor(async () => expect((await b.status()).warning).toBeUndefined());
  });

  it('stops retrying after 3 attempts', async () => {
    const a = mk();
    await a.set(big(20));
    await a.flush();
    const orig = (await sync().get('cfg:1'))['cfg:1'] as string;
    await sync().set({ 'cfg:1': 'garbage' });
    const b = mk(100);
    await b.get();
    // Repair after the 3rd retry has failed (initial + 3 retries at 100 ms); no 4th retry may pick it up.
    await new Promise((r) => setTimeout(r, 450));
    await sync().set({ 'cfg:1': orig });
    await new Promise((r) => setTimeout(r, 400));
    expect((await b.status()).warning).toBeTruthy();
  });

  it('default retry delay is 5 s', async () => {
    const a = mk();
    await a.set(big(20));
    await a.flush();
    const orig = (await sync().get('cfg:1'))['cfg:1'] as string;
    await sync().set({ 'cfg:1': 'garbage' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const b = mk();
    await b.get();
    await sync().set({ 'cfg:1': orig });
    await vi.advanceTimersByTimeAsync(4999);
    expect((await b.status()).warning).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => expect((await b.status()).warning).toBeUndefined(), { interval: 5 });
  });

  it('fills missing fields from defaults (forward-compatible migration)', async () => {
    const old = defaultConfig() as unknown as { dedupe: Record<string, unknown> };
    delete old.dedupe.alwaysSwitchSites;
    const json = JSON.stringify(old);
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    await sync().set({ 'cfg:0': json, 'cfg:meta': { v: 1, n: 1, sha, at: 1 } });
    const c = await mk().get();
    expect(c.dedupe.alwaysSwitchSites).toEqual([]);
  });

  it('invalid stored config -> lastGood + warning', async () => {
    const a = mk();
    const good = withSite('a.com');
    await a.set(good);
    await a.flush();
    const json = '{"version":1,"groupRules":"nope"}';
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    await sync().set({ 'cfg:0': json, 'cfg:meta': { v: 1, n: 1, sha, at: 2 } });
    const b = mk();
    expect(await b.get()).toEqual(good);
    expect((await b.status()).warning).toBeTruthy();
  });

  it('95 KB config is stored locally with the exact warning', async () => {
    const a = mk();
    const c = big(95);
    await a.set(c);
    await a.flush();
    expect((await a.status()).warning).toBe('Config too large to sync; saved on this device only.');
    expect(QUOTA_WARNING).toBe('Config too large to sync; saved on this device only.');
    expect(await sync().get('cfg:meta')).toEqual({});
    expect(await mk().get()).toEqual(c);
  });

  it('a QUOTA error from sync falls back to local with the warning', async () => {
    const a = mk();
    vi.spyOn(sync(), 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
    const c = withSite('q.com');
    await a.set(c);
    await a.flush();
    expect((await a.status()).warning).toBe(QUOTA_WARNING);
    expect(await mk().get()).toEqual(c);
  });

  it('21 sets keep 20 backups, newest first', async () => {
    const a = mk();
    for (let i = 0; i < 21; i++) await a.set(withSite(`s${i}.com`));
    const b = await a.backups();
    expect(b).toHaveLength(20);
    expect(b[0]!.config.dedupe.alwaysSwitchSites).toEqual(['s20.com']);
    await a.flush();
  });

  it('restore(at) restores that version', async () => {
    const a = mk();
    await a.set(withSite('one.com'));
    await a.set(withSite('two.com'));
    const old = (await a.backups()).find((b) => b.config.dedupe.alwaysSwitchSites[0] === 'one.com')!;
    await a.restore(old.at);
    expect((await a.get()).dedupe.alwaysSwitchSites).toEqual(['one.com']);
    await a.flush();
    expect((await mk().get()).dedupe.alwaysSwitchSites).toEqual(['one.com']);
  });

  it('set resolves immediately; sync write is debounced 2 s; get returns latest', async () => {
    vi.useFakeTimers();
    const a = mk();
    await a.set(withSite('d.com'));
    expect((await a.get()).dedupe.alwaysSwitchSites).toEqual(['d.com']);
    expect(await sync().get('cfg:meta')).toEqual({});
    expect((await a.status()).syncing).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await a.flush();
    expect((await sync().get('cfg:meta'))['cfg:meta']).toBeTruthy();
    expect((await a.status()).syncing).toBe(false);
  });

  it('coalesces rapid sets into one sync write', async () => {
    const a = mk();
    const spy = vi.spyOn(sync(), 'set');
    await a.set(withSite('1.com'));
    await a.set(withSite('2.com'));
    await a.flush();
    expect(spy).toHaveBeenCalledTimes(2); // chunks, then meta
    expect(await mk().get()).toEqual(withSite('2.com'));
  });

  it('removes stale chunks beyond the new n', async () => {
    const a = mk();
    await a.set(big(20));
    await a.flush();
    await a.set(withSite('small.com'));
    await a.flush();
    const keys = Object.keys(await sync().get(null)).sort();
    expect(keys).toEqual(['cfg:0', 'cfg:meta']);
  });

  it('a pending (unsynced) set survives a worker restart', async () => {
    const a = mk();
    await a.set(withSite('p.com')); // never flushed: worker killed
    const b = mk();
    expect((await b.get()).dedupe.alwaysSwitchSites).toEqual(['p.com']);
    await b.flush();
    expect((await mk().get()).dedupe.alwaysSwitchSites).toEqual(['p.com']);
  });

  it('rejects an invalid config without touching storage', async () => {
    const a = mk();
    await expect(a.set({ version: 1 } as unknown as Config)).rejects.toThrow();
    expect(await local().get(null)).toEqual({});
  });

  it('onChange fires for a remote write, not for our own echo', async () => {
    const a = mk();
    const got: Config[] = [];
    a.onChange((c) => got.push(c));
    await a.get();
    await a.set(withSite('mine.com'));
    expect(got).toHaveLength(1); // local set
    await a.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(1); // echo ignored

    // another device writes
    const other = withSite('theirs.com');
    const json = JSON.stringify(other);
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    await sync().set({ 'cfg:0': json });
    await sync().set({ 'cfg:meta': { v: 1, n: 1, sha, at: 99 } });
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[1]).toEqual(other);
    expect(await a.get()).toEqual(other);
  });

  it('does not fire onChange for a remote write that fails verification', async () => {
    const a = mk();
    const got: Config[] = [];
    a.onChange((c) => got.push(c));
    const mine = withSite('mine.com');
    await a.set(mine);
    await a.flush();
    got.length = 0;
    await sync().set({ 'cfg:0': 'nonsense', 'cfg:meta': { v: 1, n: 1, sha: 'bad', at: 5 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(0);
    expect(await a.get()).toEqual(mine);
  });

  it('unsubscribe stops callbacks', async () => {
    const a = mk();
    const cb = vi.fn();
    const off = a.onChange(cb);
    off();
    await a.set(withSite('z.com'));
    expect(cb).not.toHaveBeenCalled();
    await a.flush();
  });

  it('update(): concurrent updates are all kept (cold and warm)', async () => {
    const add = (site: string) => (c: Config): Config => ({ ...c, dedupe: { ...c.dedupe, alwaysSwitchSites: [...c.dedupe.alwaysSwitchSites, site] } });
    const cold = mk();
    await Promise.all([cold.update(add('a.com')), cold.update(add('b.com'))]);
    expect((await cold.get()).dedupe.alwaysSwitchSites.sort()).toEqual(['a.com', 'b.com']);
    await Promise.all([cold.update(add('c.com')), cold.update(add('d.com')), cold.update(add('e.com'))]);
    expect((await cold.get()).dedupe.alwaysSwitchSites).toHaveLength(5);
    await cold.flush();
    expect((await mk().get()).dedupe.alwaysSwitchSites).toHaveLength(5);
  });

  it('rate-limit errors keep the config dirty and retry with backoff; never local-only', async () => {
    const a = new ConfigStore({ debounceMs: 10, retryMs: 5000, backoffMs: 40 });
    const spy = vi.spyOn(sync(), 'set').mockRejectedValueOnce(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded'));
    const c = withSite('rl.com');
    await a.set(c);
    await a.flush();
    const st = await a.status();
    expect(st.warning).not.toBe(QUOTA_WARNING);
    expect(st.syncing).toBe(true);
    expect(await sync().get('cfg:meta')).toEqual({});
    spy.mockRestore();
    await vi.waitFor(async () => expect((await sync().get('cfg:meta'))['cfg:meta']).toBeTruthy());
    await vi.waitFor(async () => expect((await a.status()).syncing).toBe(false));
    expect((await a.status()).warning).toBeUndefined();
    expect((await local().get('cfg:localOnly'))['cfg:localOnly']).toBe(false);
  });

  it('other write errors also back off and retry', async () => {
    const a = new ConfigStore({ debounceMs: 10, backoffMs: 40 });
    vi.spyOn(sync(), 'set').mockRejectedValueOnce(new Error('network down'));
    await a.set(withSite('net.com'));
    await a.flush();
    expect((await a.status()).warning).not.toBe(QUOTA_WARNING);
    await vi.waitFor(async () => expect((await sync().get('cfg:meta'))['cfg:meta']).toBeTruthy());
  });

  it('backoff doubles from the base and is capped at 10 min', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = new ConfigStore({ debounceMs: 2000 });
    vi.spyOn(sync(), 'set').mockRejectedValue(new Error('MAX_WRITE_OPERATIONS_PER_HOUR'));
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await a.set(withSite('b.com'));
    const delays = () => spy.mock.calls.map((c) => c[1]);
    await a.flush();
    expect(delays()).toContain(30_000);
    for (let i = 0; i < 6; i++) await a.flush();
    expect(Math.max(...delays().filter((d): d is number => typeof d === 'number'))).toBe(600_000);
    expect(delays()).toContain(60_000);
    expect(delays()).toContain(120_000);
  });

  it('QUOTA_BYTES keeps a newer set that arrived during the write', async () => {
    const a = mk();
    const second = withSite('newer.com');
    vi.spyOn(sync(), 'set').mockImplementationOnce(async () => {
      await a.set(second);
      throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
    });
    await a.set(withSite('older.com'));
    await a.flush();
    expect((await a.status()).warning).not.toBe(QUOTA_WARNING);
    await a.flush();
    expect((await mk().get())).toEqual(second);
  });

  it('a loaded synced config is backed up before the first set replaces it', async () => {
    const a = mk();
    const synced = withSite('synced.com');
    await a.set(synced);
    await a.flush();
    await local().clear(); // fresh device: only sync has data
    const b = mk();
    expect(await b.get()).toEqual(synced);
    await b.set(withSite('bad.com'));
    const hit = (await b.backups()).find((x) => x.config.dedupe.alwaysSwitchSites[0] === 'synced.com')!;
    expect(hit).toBeTruthy();
    await b.restore(hit.at);
    expect((await b.get()).dedupe.alwaysSwitchSites).toEqual(['synced.com']);
    await b.flush();
  });

  it('a failed load is not cached', async () => {
    const a = mk();
    const spy = vi.spyOn(local(), 'get').mockRejectedValueOnce(new Error('boom'));
    await expect(a.get()).rejects.toThrow('boom');
    spy.mockRestore();
    expect(await a.get()).toEqual(defaultConfig());
  });

  it('crash between chunk write and meta write: new chunks + old meta -> lastGood, never mixed', async () => {
    const a = mk();
    const old = big(20, 'old');
    await a.set(old);
    await a.flush();
    const newer = big(20, 'new');
    const chunks = (await import('../../src/storage/config-store')).splitChunks(JSON.stringify(newer));
    await sync().set(Object.fromEntries(chunks.map((c, i) => [`cfg:${i}`, c]))); // meta not updated
    await local().set({ 'cfg:pending': false });
    const b = mk();
    expect(await b.get()).toEqual(old);
    expect((await b.status()).warning).toBeTruthy();
  });

  it('remote change during a pending local write: local wins (last write wins), no onChange for the remote', async () => {
    const a = mk();
    const got: Config[] = [];
    await a.get();
    a.onChange((c) => got.push(c));
    const mine = withSite('mine.com');
    await a.set(mine);
    got.length = 0;
    const json = JSON.stringify(withSite('theirs.com'));
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))]
      .map((x) => x.toString(16).padStart(2, '0')).join('');
    await sync().set({ 'cfg:0': json });
    await sync().set({ 'cfg:meta': { v: 1, n: 1, sha, at: 7 } });
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toHaveLength(0);
    expect(await a.get()).toEqual(mine);
    await a.flush();
    expect(await mk().get()).toEqual(mine);
  });
});
