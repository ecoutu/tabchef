import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { ConfigStore, QUOTA_WARNING } from '../../src/storage/config-store';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config, ConfigV1, GroupRule } from '../../src/core/types';
import { v1Config, withGroupRules } from '../helpers/config';

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
async function putSync(json: string): Promise<void> {
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))]
    .map((x) => x.toString(16).padStart(2, '0')).join('');
  await sync().set({ 'cfg:0': json });
  await sync().set({ 'cfg:meta': { v: 1, n: 1, sha, at: Date.now() } });
}

describe('ConfigStore', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('first run returns defaults', async () => {
    expect(await mk().get()).toEqual(defaultConfig());
  });

  it('R56: a stored v2 config without ruleEnabled loads unchanged; one with it round-trips', async () => {
    const old = withGroupRules([{ id: 'a', name: 'A', enabled: true, match: { url: 'a.com/*' }, group: { title: 'A', color: 'blue' } }]);
    await putSync(JSON.stringify(old));
    expect(await mk().get()).toEqual(old);
    const off: Config = { ...old, recipes: old.recipes.map((r) => (r.id === 'finished' ? { ...r, ruleEnabled: { 'meet-ended': false } } : r)) };
    const a = mk();
    await a.set(off);
    await a.flush();
    expect(await mk().get()).toEqual(off);
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

  it('M2/R68: a stored config missing a built-in recipe loads with that ref appended, disabled; existing refs and order kept', async () => {
    const d = defaultConfig();
    const old: Config = {
      ...d,
      recipes: [{ ...d.recipes.find((r) => r.id === 'github-prs')!, enabled: false }, d.recipes.find((r) => r.id === 'duplicates')!],
    };
    await putSync(JSON.stringify(old));
    const c = await mk().get();
    expect(c.recipes).toEqual([...old.recipes, ...['finished', 'merged-prs', 'jira-ticket-title', 'jira-ticket-branch', 'jira-ticket-either', 'github-issue', 'manual-project'].map((id) => ({ id, enabled: false, params: {}, source: 'builtin' }))]);
    expect(await sync().get('cfg:0')).toEqual({ 'cfg:0': JSON.stringify(old) }); // loading never writes (R2)
  });

  it('M2/R68: nothing missing: the loaded recipes are exactly the stored ones (no churn)', async () => {
    const old: Config = { ...defaultConfig(), recipes: [...defaultConfig().recipes].reverse() };
    await putSync(JSON.stringify(old));
    expect(await mk().get()).toEqual(old);
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
    await a.set(withSite('first.com'));
    await a.flush(); // this device has synced before (a never-synced device adopts the remote instead: I4)
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
  it('fresh device: a remote config that appears before the first write is adopted; the local edit becomes a backup (I4)', async () => {
    const b = mk();
    await b.get(); // nothing synced yet: defaults
    const got: Config[] = [];
    b.onChange((c) => got.push(c));
    const mine = withSite('mine.com');
    await b.set(mine);
    // Chrome sync delivers the account's config (written by another device) while our write is debounced.
    const theirs = withSite('theirs.com');
    const json = JSON.stringify(theirs);
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)))]
      .map((x) => x.toString(16).padStart(2, '0')).join('');
    await sync().set({ 'cfg:0': json });
    await sync().set({ 'cfg:meta': { v: 1, n: 1, sha, at: 7 } });
    got.length = 0;
    await b.flush();
    expect(await b.get()).toEqual(theirs);
    expect((await sync().get('cfg:meta'))['cfg:meta']).toMatchObject({ sha });
    expect(await mk().get()).toEqual(theirs);
    expect((await b.backups()).some((x) => JSON.stringify(x.config) === JSON.stringify(mine))).toBe(true);
    expect((await b.status()).warning).toBe('Synced settings were found and loaded; your change on this device was saved as a backup.');
    expect(got).toEqual([theirs]);
    expect((await local().get('cfg:pending'))['cfg:pending']).toBe(false);
  });

  it('fresh device: the fresh state survives a worker kill before the debounced sync write', async () => {
    const a = mk();
    await a.get();
    const mine = withSite('mine.com');
    await a.set(mine); // worker killed here: no flush
    const theirs = withSite('theirs.com');
    await putSync(JSON.stringify(theirs));
    const b = mk(); // new worker over the same storage
    expect(await b.get()).toEqual(mine);
    await b.flush();
    expect(await b.get()).toEqual(theirs);
    expect((await b.backups()).some((x) => JSON.stringify(x.config) === JSON.stringify(mine))).toBe(true);
    expect((await b.status()).warning).toContain('Synced settings were found and loaded');
    expect((await local().get('cfg:freshDevice'))['cfg:freshDevice']).toBe(false);
  });

  it('fresh flag is cleared after a successful sync write', async () => {
    const a = mk();
    await a.set(withSite('mine.com'));
    await a.flush();
    expect((await local().get('cfg:freshDevice'))['cfg:freshDevice']).toBe(false);
  });

  it('fresh device with nothing in sync still writes the local edit (I4)', async () => {
    const b = mk();
    await b.set(withSite('mine.com'));
    await b.flush();
    expect(await mk().get()).toEqual(withSite('mine.com'));
    expect((await b.status()).warning).toBeUndefined();
  });

  it('set() is serialized with update(): a set issued after an update is never overwritten by it (T13)', async () => {
    const a = mk();
    await a.get();
    const u = a.update((c) => ({ ...c, dedupe: { ...c.dedupe, alwaysSwitchSites: ['u.com'] } }));
    const s = a.set(withSite('s.com'));
    await Promise.all([u, s]);
    expect((await a.get()).dedupe.alwaysSwitchSites).toEqual(['s.com']);
  });

  describe('stored configs from laxer versions are repaired, not discarded (CR#1)', () => {
    const okRule: GroupRule = { id: 'ok', name: 'Fine', enabled: true, match: { url: 'https://a.com/*' }, group: { title: 'A', color: 'blue' } };
    const badRule: GroupRule = { id: 'gh', name: 'GH repos', enabled: true, match: { url: ['github.com/:org/:repo/*', 'example.com/*'] }, group: { title: 'GH {repo}', color: 'red' } };
    const legacy = () => v1Config([okRule, badRule]);
    const WARN = '1 rule(s) disabled: GH repos — fix them on the Rules page.';
    const expectRepaired = (c: Config) => {
      expect(c.rules.map((r) => [r.id, r.enabled])).toEqual([['ok', true], ['gh', false]]);
      expect(c.rules[1]!.actions[0]).toEqual({ group: { title: 'GH {repo}', color: 'red' } });
      expect(c.rules[0]).toEqual(withGroupRules([okRule]).rules[0]);
    };
    it('from sync: the bad rule is disabled with a warning; other rules intact; no fallback to defaults', async () => {
      await putSync(JSON.stringify(legacy()));
      const s = mk();
      expectRepaired(await s.get());
      expect((await s.status()).warning).toContain(WARN);
    });
    it('from lastGood (pending local edit)', async () => {
      await local().set({ 'cfg:lastGood': legacy(), 'cfg:pending': true });
      const s = mk();
      expectRepaired(await s.get());
      expect((await s.status()).warning).toContain(WARN);
    });
    it('from lastGood when sync is corrupt', async () => {
      await local().set({ 'cfg:lastGood': legacy(), 'cfg:syncedSha': 'x' });
      await sync().set({ 'cfg:0': '{', 'cfg:meta': { v: 1, n: 1, sha: 'nope', at: 1 } });
      expectRepaired(await mk().get());
    });
    it('load backs up the ORIGINAL (pre-repair) config; current is repaired; restoring it re-repairs with the warning', async () => {
      await putSync(JSON.stringify(legacy()));
      const s = mk();
      expectRepaired(await s.get());
      const [b] = await s.backups();
      expect((b!.config as ConfigV1).groupRules.map((r) => [r.id, r.enabled])).toEqual([['ok', true], ['gh', true]]);
      await s.set(withSite('x.com'));
      await s.restore(b!.at);
      expectRepaired(await s.get());
      expect((await s.status()).warning).toContain(WARN);
    });
    it('restore() of such a backup', async () => {
      const s = mk();
      await s.get();
      await local().set({ 'cfg:backups': [{ at: 5, config: legacy() }] });
      await s.restore(5);
      expectRepaired(await s.get());
      expect((await s.status()).warning).toContain(WARN);
    });
  });

  it('restore() of an old backup with an over-long urlTransform (T18 cap) succeeds: the entry is removed with a warning', async () => {
    const s = mk();
    await s.get();
    const old = { ...defaultConfig(), dedupe: { ...defaultConfig().dedupe, urlTransforms: [{ pattern: 'a'.repeat(600), replacement: '' }, { pattern: 'ok', replacement: '' }] } };
    await local().set({ 'cfg:backups': [{ at: 5, config: old }] });
    await s.restore(5);
    expect((await s.get()).dedupe.urlTransforms).toEqual([{ pattern: 'ok', replacement: '' }]);
    expect((await s.status()).warning).toMatch(/1 Duplicates setting\(s\) removed: urlTransforms\/0 \(regex too long/);
  });

  describe('adopt-remote only on a genuinely fresh device (CR#2, CR#3)', () => {
    it('upgraded device with a PENDING local edit and no synced sha: local wins over sync', async () => {
      const mine = withSite('mine.com');
      await local().set({ 'cfg:lastGood': mine, 'cfg:pending': true });
      await putSync(JSON.stringify(withSite('theirs.com')));
      const s = mk();
      expect(await s.get()).toEqual(mine);
      await s.flush();
      expect(await s.get()).toEqual(mine);
      expect((await s.status()).warning).toBeUndefined();
      expect(await mk().get()).toEqual(mine);
      expect(typeof (await local().get('cfg:syncedSha'))['cfg:syncedSha']).toBe('string');
    });
    it('upgraded LOCAL_ONLY device with no synced sha: a new edit that fits is written, not replaced by sync', async () => {
      await local().set({ 'cfg:lastGood': withSite('old-local.com'), 'cfg:localOnly': true });
      await putSync(JSON.stringify(withSite('theirs.com')));
      const s = mk();
      await s.get();
      const mine = withSite('mine.com');
      await s.set(mine);
      await s.flush();
      expect(await s.get()).toEqual(mine);
      expect(await mk().get()).toEqual(mine);
    });
    it('load saw a corrupt sync; user saves; sync is repaired by another device: the saved edit survives', async () => {
      await sync().set({ 'cfg:0': '{', 'cfg:meta': { v: 1, n: 1, sha: 'nope', at: 1 } });
      const s = new ConfigStore({ debounceMs: 2000, retryMs: 60_000 });
      expect(await s.get()).toEqual(defaultConfig());
      const mine = withSite('mine.com');
      await s.set(mine);
      await putSync(JSON.stringify(withSite('theirs.com')));
      await s.flush();
      expect(await s.get()).toEqual(mine);
      expect(await mk().get()).toEqual(mine);
    });
  });

  describe('v1 -> v2 migration on load (M2 T1, R2)', () => {
    const r1: GroupRule = { id: 'r1', name: 'One', enabled: true, match: { url: 'https://a.com/*' }, group: { title: 'A', color: 'blue' }, strict: true, merge: true };
    const r2: GroupRule = { id: 'R 2', name: 'Two', enabled: true, match: { url: 'https://b.com/*' }, group: { title: 'B', color: 'red' } };
    const old = () => v1Config([r1, r2]);
    const v1Backups = async (s: ConfigStore) => (await s.backups()).filter((b) => (b.config as { version: number }).version === 1);
    const syncJson = async () => {
      const all = await sync().get(null);
      const n = (all['cfg:meta'] as { n: number }).n;
      return Array.from({ length: n }, (_, i) => all[`cfg:${i}`] as string).join('');
    };

    it('from sync: get() returns v2; exactly one backup holds the v1 JSON; lastGood and then sync become v2', async () => {
      await putSync(JSON.stringify(old()));
      const s = mk();
      const c = await s.get();
      expect(c.version).toBe(2);
      expect(c.rules.map((r) => r.id)).toEqual(['r1', 'r-2']);
      expect(c.order).toEqual(['user/r1', 'user/r-2']);
      const v1 = await v1Backups(s);
      expect(v1).toHaveLength(1);
      expect(v1[0]!.config).toEqual(old());
      expect((await local().get('cfg:lastGood'))['cfg:lastGood']).toEqual(c);
      expect((await local().get('cfg:pending'))['cfg:pending']).toBe(true);
      await s.flush();
      expect(JSON.parse(await syncJson())).toEqual(c);
      expect((await local().get('cfg:pending'))['cfg:pending']).toBe(false);
      // A second load reads v2 and adds no further v1 backup.
      const s2 = mk();
      expect(await s2.get()).toEqual(c);
      expect(await v1Backups(s2)).toHaveLength(1);
    });

    it('from a PENDING lastGood: backs up the v1, lastGood becomes v2, and the write is scheduled', async () => {
      await local().set({ 'cfg:lastGood': old(), 'cfg:pending': true });
      const s = mk();
      const c = await s.get();
      expect(c.version).toBe(2);
      expect((await v1Backups(s)).map((b) => b.config)).toEqual([old()]);
      expect((await local().get('cfg:lastGood'))['cfg:lastGood']).toEqual(c);
      expect((await s.status()).syncing).toBe(true);
      await s.flush();
      expect(JSON.parse(await syncJson())).toEqual(c);
    });

    it('from a LOCAL_ONLY lastGood: backs up the v1 and stores v2 locally', async () => {
      await local().set({ 'cfg:lastGood': old(), 'cfg:localOnly': true });
      const s = mk();
      const c = await s.get();
      expect(c.version).toBe(2);
      expect((await v1Backups(s)).map((b) => b.config)).toEqual([old()]);
      expect((await local().get('cfg:lastGood'))['cfg:lastGood']).toEqual(c);
    });

    it('invalid v1 in sync: get() returns lastGood and nothing is written', async () => {
      const a = mk();
      const good = withSite('a.com');
      await a.set(good);
      await a.flush();
      await putSync('{"version":1,"groupRules":[{"id":"x"}]}');
      const before = await sync().get(null);
      const s = mk();
      expect(await s.get()).toEqual(good);
      await s.flush();
      expect(await sync().get(null)).toEqual(before);
      expect(await v1Backups(s)).toHaveLength(0);
    });

    it('migration does not call set(): concurrent update() during the first load completes (no deadlock)', async () => {
      await putSync(JSON.stringify(old()));
      const s = mk();
      const next = await s.update((c) => ({ ...c, dryRun: true }));
      expect(next.dryRun).toBe(true);
      expect(next.rules).toHaveLength(2);
    });

    it('restore() of a v1 backup migrates it', async () => {
      const s = mk();
      await s.get();
      await local().set({ 'cfg:backups': [{ at: 5, config: old() }] });
      await s.restore(5);
      const c = await s.get();
      expect(c.version).toBe(2);
      expect(c.rules.map((r) => r.id)).toEqual(['r1', 'r-2']);
    });
  });

  // dispose() must be terminal: work already in flight when it runs (a remote read, a retry, a sync write, a load) must
  // not arm a timer or write storage afterwards, or it lands in the next test's storage (#155). Each test holds one
  // storage call open, disposes, then lets the call finish.
  describe('dispose', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    const settle = async () => {
      for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
    };

    /** Holds the next sync read of cfg:meta open; every other call goes through. */
    function gateMetaRead() {
      const gate = deferred<void>();
      const entered = deferred<void>();
      // Callers pass one key, a list of keys (readSync's chunk read) or null.
      const real = sync().get.bind(sync()) as (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
      let armed = true;
      vi.spyOn(sync(), 'get').mockImplementation(async (keys?: unknown) => {
        if (armed && keys === 'cfg:meta') {
          armed = false;
          entered.resolve();
          await gate.promise;
        }
        return real(keys as string | string[] | null);
      });
      return { gate, entered };
    }

    /** Holds the next sync write open; `real` decides whether it then goes through. */
    function gateSyncWrite() {
      const gate = deferred<void>();
      const entered = deferred<void>();
      const real = sync().set.bind(sync());
      let armed = true;
      vi.spyOn(sync(), 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if (armed) {
          armed = false;
          entered.resolve();
          await gate.promise;
        }
        return real(items);
      });
      return { gate, entered };
    }

    it('a remote read that fails verification after dispose arms no retry', async () => {
      const s = mk();
      await s.get();
      const { gate, entered } = gateMetaRead();
      // Another device writes a meta whose chunk is missing: the store starts a remote read nobody awaits.
      await sync().set({ 'cfg:meta': { v: 1, n: 1, sha: 'x'.repeat(64), at: 1 } });
      await entered.promise;
      s.dispose();
      gate.resolve();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a remote read that succeeds after dispose applies nothing', async () => {
      const s = mk();
      await s.get();
      const seen = vi.fn();
      s.onChange(seen);
      const { gate, entered } = gateMetaRead();
      const json = JSON.stringify(withSite('remote.example'));
      await putSync(json);
      // Records the read's checksum, so the test can prove the read got as far as applying the remote config.
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      const digests: Promise<ArrayBuffer>[] = [];
      vi.spyOn(crypto.subtle, 'digest').mockImplementation((...a: Parameters<typeof realDigest>) => {
        const d = realDigest(...a);
        digests.push(d);
        return d;
      });
      await entered.promise;
      s.dispose();
      // What the next test's beforeEach does; keep the remote copy so the held read still finds it.
      const synced = await sync().get(null);
      fakeBrowser.reset();
      await sync().set(synced);
      gate.resolve();
      await settle();
      // The held read went on to verify the chunk, and its checksum matched: it reached applyRemote.
      expect(digests).toHaveLength(1);
      const hex = [...new Uint8Array(await digests[0]!)].map((x) => x.toString(16).padStart(2, '0')).join('');
      expect(hex).toBe((synced['cfg:meta'] as { sha: string }).sha);
      await settle();
      expect(await s.get()).toEqual(defaultConfig()); // the remote config was not applied, even in memory
      expect(await local().get(null)).toEqual({});
      expect(seen).not.toHaveBeenCalled();
    });

    it('a read retry in flight at dispose arms no further retry', async () => {
      await sync().set({ 'cfg:meta': { v: 1, n: 1, sha: 'y'.repeat(64), at: 1 } }); // chunk missing: 'bad'
      const s = mk();
      await s.get();
      expect(vi.getTimerCount()).toBe(1);
      const { gate, entered } = gateMetaRead();
      vi.advanceTimersByTime(5000); // the retry fires and its read is held
      await entered.promise;
      s.dispose();
      gate.resolve();
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a sync write that fails after dispose arms no backoff', async () => {
      const s = new ConfigStore({ debounceMs: 2000, retryMs: 5000, backoffMs: 30_000 });
      await s.get();
      await s.set(withSite('local.example'));
      const hold = deferred<void>();
      const entered = deferred<void>();
      vi.spyOn(sync(), 'set').mockImplementation(async () => {
        entered.resolve();
        await hold.promise;
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.advanceTimersByTime(2000); // the debounce fires and the sync write is held
      await entered.promise;
      s.dispose();
      hold.reject(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE'));
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a sync write that succeeds after dispose writes no meta and leaves the edit pending', async () => {
      const s = mk();
      await s.get();
      await s.set(withSite('local.example'));
      const { gate, entered } = gateSyncWrite();
      vi.advanceTimersByTime(2000); // the debounce fires and the chunk write is held
      await entered.promise;
      s.dispose();
      gate.resolve();
      await settle();
      expect((await sync().get('cfg:meta'))['cfg:meta']).toBeUndefined();
      expect((await local().get('cfg:pending'))['cfg:pending']).toBe(true);
    });

    it('a sync write still hashing at dispose writes no chunk to sync', async () => {
      const s = mk();
      await s.get();
      await s.set(withSite('local.example'));
      const gate = deferred<void>();
      const entered = deferred<void>();
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      let armed = true;
      vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...a: Parameters<typeof realDigest>) => {
        if (armed) {
          armed = false;
          entered.resolve();
          await gate.promise;
        }
        return realDigest(...a);
      });
      vi.advanceTimersByTime(2000); // the debounce fires and the write's checksum is held
      await entered.promise;
      s.dispose();
      gate.resolve();
      await settle();
      expect(await sync().get(null)).toEqual({});
    });

    it('a meta write in flight at dispose removes no chunk from sync', async () => {
      const s = mk();
      await s.get();
      await s.set(withSite('local.example'));
      const realSet = sync().set.bind(sync());
      const gate = deferred<void>();
      const entered = deferred<void>();
      vi.spyOn(sync(), 'set').mockImplementation(async (items: Record<string, unknown>) => {
        if ('cfg:meta' in items) {
          entered.resolve();
          await gate.promise;
        }
        return realSet(items);
      });
      vi.advanceTimersByTime(2000); // the debounce fires, the chunk is written and the meta write is held
      await entered.promise;
      s.dispose();
      await realSet({ 'cfg:7': 'next test' }); // a later test's chunk, above this store's chunk count
      gate.resolve();
      await settle();
      expect((await sync().get('cfg:7'))['cfg:7']).toBe('next test');
    });

    it('flush() after dispose touches no sync storage', async () => {
      const s = mk();
      await s.get();
      await s.set(withSite('local.example')); // pending, and this device never synced: the write would read sync first
      s.dispose();
      const get = vi.spyOn(sync(), 'get');
      const set = vi.spyOn(sync(), 'set');
      const digest = vi.spyOn(crypto.subtle, 'digest');
      await s.flush();
      await settle();
      expect(get).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    });

    it('a remote change after dispose is never read', async () => {
      const s = mk();
      await s.get();
      s.dispose();
      const get = vi.spyOn(sync(), 'get');
      await putSync(JSON.stringify(withSite('remote.example')));
      await settle();
      expect(get).not.toHaveBeenCalled();
    });

    it('set() after dispose notifies no listener', async () => {
      const s = mk();
      await s.get();
      const seen = vi.fn();
      s.onChange(seen);
      s.dispose();
      await s.set(withSite('later.example'));
      expect(seen).not.toHaveBeenCalled();
    });

    it('a load in flight at dispose arms no sync write for a pending edit', async () => {
      await local().set({ 'cfg:lastGood': defaultConfig(), 'cfg:pending': true });
      const s = mk();
      const loading = s.get(); // a caller that has not awaited it when the test ends
      s.dispose();
      await loading;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('set() after dispose updates only the in-memory copy', async () => {
      const s = mk();
      await s.get();
      const before = await local().get(null);
      s.dispose();
      await s.set(withSite('later.example'));
      await settle();
      expect(await s.get()).toEqual(withSite('later.example'));
      expect(await local().get(null)).toEqual(before);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

// Regression guard (M3-R33): held before connections existed. Secrets live in storage.local under conn.*; nothing the
// ConfigStore returns (the export source) or backs up may pick them up.
describe('ConfigStore output never includes connection secrets (regression guard)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useRealTimers();
  });

  it('get, backups and lastGood lack conn.* keys and token values', async () => {
    await local().set({
      'conn.secret.github': { token: 'gho_SECRETSECRETSECRET' },
      'conn.secret.jira': { token: 'ATATTSECRETSECRETSECRET' },
      connections: [{ id: 'github' }],
    });
    const s = mk();
    await s.set(withSite('https://example.com'));
    const out = JSON.stringify([await s.get(), await s.backups(), (await local().get('cfg:lastGood'))['cfg:lastGood']]);
    expect(out).not.toMatch(/conn\.|SECRET|"connections"/);
  });
});
