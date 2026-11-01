import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRev, badgeCount, createDebounce, createHandler, createOnMessage, type HandlerDeps } from '../../src/engine/messages';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config } from '../../src/core/types';

type Loose = { ok: boolean; data: { sets: { key: string }[]; pending: unknown[] }; errors: string[] };
const A = 'https://a.example/x';
const ui = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
const content = { id: 'ext', tab: { id: 9 }, url: 'https://evil.example/' };

function setup() {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  port.addWindow(2);
  const mk = (id: number, url: string, o = {}) =>
    port.addTab({ id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false, active: false, audible: false, ...o });
  let cfg: Config = defaultConfig();
  const added: unknown[] = [];
  const locked = new Set<number>();
  const set = vi.fn(async (c: Config) => { cfg = c; });
  const deps: HandlerDeps = {
    runtimeId: 'ext',
    extensionOrigin: 'chrome-extension://ext',
    store: {
      get: async () => cfg, set, backups: async () => [{ at: 1, config: cfg }], restore: vi.fn(async () => {}),
      status: async () => ({ syncing: true }),
    },
    port,
    getSettings: async () => cfg.dedupe,
    safety: {
      pause: vi.fn(), resume: vi.fn(), isPaused: () => false, lock: (id) => { locked.add(id); }, unlock: (id) => { locked.delete(id); },
      isLocked: (id) => locked.has(id), undo: vi.fn(async () => {}),
    },
    recentlyClosed: { list: () => [], add: (e) => { added.push(e); return 'id'; } },
    whyLog: { all: () => [], forTab: () => [], add: () => {} },
    ask: { listPending: async () => [{ newTabId: 5, existingTabId: 1, key: 'k', at: 1 }], resolvePending: vi.fn(async () => {}) },
    now: () => 42,
  };
  return { port, mk, deps, handle: createHandler(deps), set, added, locked, getCfg: () => cfg };
}

describe('messages', () => {
  it('dupes.closeExtras keeps the oldest, closes the rest, records them', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, A); s.mk(3, A);
    const key = ((await s.handle({ type: 'dupes.list' }, ui)) as Loose).data.sets[0]!.key;
    const r = await s.handle({ type: 'dupes.closeExtras', key }, ui);
    expect(r).toEqual({ ok: true, data: 2 });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([1]);
    expect(s.added).toHaveLength(2);
    expect(s.added[0]).toMatchObject({ reason: 'duplicate', url: A });
    expect(s.port.badge).toBe('1'); // 0 extras + 1 pending
  });

  it('never closes pinned or locked tabs', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, A, { pinned: true }); s.mk(3, A); s.mk(4, A);
    s.locked.add(3);
    const r = await s.handle({ type: 'dupes.closeAll' }, ui);
    expect(r).toEqual({ ok: true, data: 1 });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('tabs.list returns the snapshot tabs for extension pages only', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, 'https://b.example/');
    const r = (await s.handle({ type: 'tabs.list' }, ui)) as { ok: boolean; data: { id: number }[] };
    expect(r.data.map((t) => t.id)).toEqual([1, 2]);
    expect(await s.handle({ type: 'tabs.list' }, content)).toEqual({ ok: false, error: 'forbidden' });
  });

  it('dupes.list returns sets and pending', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, A);
    const r = (await s.handle({ type: 'dupes.list' }, ui)) as Loose;
    expect(r.data.sets).toHaveLength(1);
    expect(r.data.pending).toHaveLength(1);
  });

  it('dupes.list exposes closable extras per set (excludes pinned and locked)', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, A, { pinned: true }); s.mk(3, A); s.mk(4, A);
    s.locked.add(3);
    const r = (await s.handle({ type: 'dupes.list' }, ui)) as { data: { sets: { closable: number }[] } };
    expect(r.data.sets[0]?.closable).toBe(1);
  });

  it('unknown or malformed requests', async () => {
    const s = setup();
    for (const bad of [{ type: 'nope' }, null, 'x', { type: 'tab.focus' }, { type: 'dupes.closeExtras' }, {}]) {
      expect(await s.handle(bad, ui)).toEqual({ ok: false, error: 'unknown request' });
    }
  });

  it('config.set with invalid config reports errors and stores nothing', async () => {
    const s = setup();
    const r = (await s.handle({ type: 'config.set', config: { version: 2 } }, ui)) as Loose;
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(s.set).not.toHaveBeenCalled();
    expect(await s.handle({ type: 'config.set', config: defaultConfig() }, ui)).toEqual({ ok: true, data: null });
    expect(s.set).toHaveBeenCalledOnce();
  });

  it('config.get returns config and rev; config.set with stale baseRev conflicts', async () => {
    const s = setup();
    const g = (await s.handle({ type: 'config.get' }, ui)) as { ok: boolean; data: { config: Config; rev: string } };
    expect(g.data.config).toEqual(defaultConfig());
    expect(typeof g.data.rev).toBe('string');
    const changed = { ...defaultConfig(), groupRules: [{ id: 'r', name: 'r', enabled: true, match: { url: 'a.com/*' }, group: { title: 'r', color: 'blue' as const } }] };
    expect(await s.handle({ type: 'config.set', config: changed, baseRev: g.data.rev }, ui)).toEqual({ ok: true, data: null });
    expect(s.set).toHaveBeenCalledTimes(1);
    expect(await s.handle({ type: 'config.set', config: defaultConfig(), baseRev: g.data.rev }, ui)).toEqual({ ok: false, error: 'conflict' });
    expect(s.set).toHaveBeenCalledTimes(1);
    const g2 = (await s.handle({ type: 'config.get' }, ui)) as { data: { rev: string } };
    expect(g2.data.rev).not.toBe(g.data.rev);
    expect((await s.handle({ type: 'config.set', config: defaultConfig(), baseRev: g2.data.rev }, ui)).ok).toBe(true);
  });

  it('rejects content scripts and foreign senders', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, A);
    for (const sender of [content, { id: 'other' }, { id: 'ext', tab: { id: 1 }, url: 'https://x/' }, {}]) {
      for (const req of [{ type: 'dupes.closeAll' }, { type: 'config.set', config: defaultConfig() }]) {
        expect(await s.handle(req, sender)).toEqual({ ok: false, error: 'forbidden' });
      }
    }
    expect((await s.port.snapshot()).tabs).toHaveLength(2);
    expect(s.set).not.toHaveBeenCalled();
  });

  it('accepts extension-origin pages that have a tab (options in a tab)', async () => {
    const s = setup();
    const r = await s.handle({ type: 'safety.status' }, { id: 'ext', tab: { id: 3 }, url: 'chrome-extension://ext/options.html' });
    expect(r.ok).toBe(true);
  });

  it('safety, lock, focus, recent, why, config', async () => {
    const s = setup();
    s.mk(1, A, { windowId: 2 });
    expect(await s.handle({ type: 'tab.focus', tabId: 1 }, ui)).toEqual({ ok: true, data: null });
    expect(s.port.calls.some((c) => c.method === 'focusTab' && c.args[0] === 1 && c.args[1] === 2)).toBe(true);
    await s.handle({ type: 'safety.pause', d: '1h' }, ui);
    expect(s.deps.safety.pause).toHaveBeenCalledWith('1h');
    expect(await s.handle({ type: 'safety.pause', d: '9h' }, ui)).toEqual({ ok: false, error: 'unknown request' });
    await s.handle({ type: 'tab.lock', tabId: 1 }, ui);
    expect(s.locked.has(1)).toBe(true);
    expect(await s.handle({ type: 'recent.undo', id: 'q' }, ui)).toEqual({ ok: true, data: null });
    expect(await s.handle({ type: 'why.all' }, ui)).toEqual({ ok: true, data: [] });
    expect((await s.handle({ type: 'config.backups' }, ui)).ok).toBe(true);
  });

  it('records recently closed only after closeTab succeeds', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, A);
    s.port.failNext('closeTab', 'boom');
    const r = await s.handle({ type: 'dupes.closeAll' }, ui);
    expect(r.ok).toBe(false);
    expect(s.added).toHaveLength(0);
  });

  it('badge counts only closable extras plus pending', async () => {
    const s = setup();
    s.mk(1, A); s.mk(2, A, { pinned: true }); s.mk(3, A); s.mk(4, A);
    s.locked.add(3);
    expect(await badgeCount({ ...s.deps, isLocked: (id) => s.locked.has(id) })).toBe(1 + 1);
  });
});

describe('createOnMessage', () => {
  const mk = (isBanner: boolean) => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: 1 }));
    const l = createOnMessage({ runtimeId: 'ext', handleRequest, handleBanner: () => isBanner });
    return { handleRequest, l };
  };
  it('answers UI requests through sendResponse and returns true', async () => {
    const { l, handleRequest } = mk(false);
    const send = vi.fn();
    expect(l({ type: 'x' }, ui, send)).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ ok: true, data: 1 }));
    expect(handleRequest).toHaveBeenCalled();
  });
  it('responds with an error when the handler rejects', async () => {
    const send = vi.fn();
    const l = createOnMessage({ runtimeId: 'ext', handleRequest: async () => { throw new Error('x'); }, handleBanner: () => false });
    expect(l({}, ui, send)).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ ok: false, error: 'Error: x' }));
  });
  it('leaves banner messages to the banner handler', () => {
    const { l, handleRequest } = mk(true);
    expect(l({}, content, vi.fn())).toBeUndefined();
    expect(handleRequest).not.toHaveBeenCalled();
  });
  it('ignores other extensions', () => {
    const { l, handleRequest } = mk(false);
    expect(l({}, { id: 'other' }, vi.fn())).toBeUndefined();
    expect(handleRequest).not.toHaveBeenCalled();
  });
});

describe('createDebounce', () => {
  afterEach(() => vi.useRealTimers());
  it('fires after quiet period, and within max wait under continuous churn', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebounce(fn, 500, 2000);
    d(); vi.advanceTimersByTime(499); expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i++) { d(); vi.advanceTimersByTime(100); }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('import.*', () => {
  const agt = { groups: [
    { id: 'n1', title: 'New', color: 'blue', matchers: ['https://n.example/*'], options: { strict: true } },
    { id: 'old', title: 'Dup', color: 'red', matchers: ['https://d.example/*'] },
  ] };
  const seed = (s: ReturnType<typeof setup>) => {
    const cfg = defaultConfig();
    cfg.groupRules = [{ id: 'old', name: 'Old', enabled: true, match: { url: 'o.example/*' }, group: { title: 'Old', color: 'green' } }];
    s.deps.store.get = async () => cfg;
    return cfg;
  };

  it('preview returns rules, dedupe and warnings without writing', async () => {
    const s = setup();
    const r = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: agt }, ui)) as { ok: boolean; data: { rules: unknown[] } };
    expect(r.ok).toBe(true);
    expect(r.data.rules).toHaveLength(2);
    const t = (await s.handle({ type: 'import.preview', source: 'tab-deduper', data: { local: { dedupAllWindows: false } } }, ui)) as { data: { dedupe: unknown; rules: unknown[] } };
    expect(t.data).toMatchObject({ dedupe: { scope: 'same-window' }, rules: [] });
    expect(s.set).not.toHaveBeenCalled();
  });

  it('apply appends after existing rules, renames colliding ids, merges dedupe', async () => {
    const s = setup();
    const cfg = seed(s);
    const r = await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: agt, baseRev: configRev(cfg) }, ui);
    expect(r.ok).toBe(true);
    const saved = s.set.mock.calls[0]![0] as Config;
    expect(saved.groupRules.map((x) => x.group.title)).toEqual(['Old', 'New', 'Dup']);
    expect(saved.groupRules[1]!.id).toBe('n1');
    expect(saved.groupRules[2]!.id).not.toBe('old');
    expect(new Set(saved.groupRules.map((x) => x.id)).size).toBe(3);
    const t = await s.handle({ type: 'import.apply', source: 'tab-deduper', data: { local: { dedupAllWindows: false, urlExempts: 'a.com' } }, baseRev: configRev(cfg) }, ui);
    expect(t.ok).toBe(true);
    const saved2 = s.set.mock.calls[1]![0] as Config;
    expect(saved2.dedupe).toMatchObject({ scope: 'same-window', allowDuplicates: ['a.com*'], mode: 'always-switch' });
    expect(saved2.groupRules).toHaveLength(1);
  });

  it('apply reports conflict on stale baseRev and nothing-to-import on garbage; rejects non-UI senders', async () => {
    const s = setup();
    seed(s);
    expect(await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: agt, baseRev: 'stale' }, ui)).toEqual({ ok: false, error: 'conflict' });
    expect(await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: 'junk', baseRev: configRev(s.getCfg()) }, ui)).toMatchObject({ ok: false, error: 'nothing to import' });
    expect(await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: agt, baseRev: 'x' }, content)).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.handle({ type: 'import.preview', source: 'bogus', data: {} }, ui)).toEqual({ ok: false, error: 'unknown request' });
    expect(s.set).not.toHaveBeenCalled();
  });

  it('merges dedupe lists instead of replacing, lists changes in preview, warns on existing titles', async () => {
    const s = setup();
    const cfg = seed(s);
    cfg.dedupe = { ...cfg.dedupe, allowDuplicates: ['keep.com*'] };
    const data = { local: { dedupAllWindows: false, urlExempts: 'a.com' } };
    const p = (await s.handle({ type: 'import.preview', source: 'tab-deduper', data }, ui)) as { data: { changes: string[] } };
    expect(p.data.changes.join('\n')).toMatch(/scope: all-windows \u2192 same-window/);
    await s.handle({ type: 'import.apply', source: 'tab-deduper', data, baseRev: configRev(cfg) }, ui);
    expect((s.set.mock.calls[0]![0] as Config).dedupe.allowDuplicates).toEqual(['keep.com*', 'a.com*']);
    const w = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: { groups: [{ id: 'z', title: 'Old', color: 'red', matchers: ['https://z.example/*'] }] } }, ui)) as { data: { warnings: string[] } };
    expect(w.data.warnings).toContain('Already have a rule titled "Old"');
  });

  it('skips imported rules with empty titles or uncaptured template variables, with a warning (I1)', async () => {
    const s = setup();
    const data = { groups: [
      { id: 'e', title: '', color: 'blue', matchers: ['https://e.example/*'] },
      { id: 't', title: '{repo}', color: 'blue', matchers: ['https://t.example/*'] },
      { id: 'k', title: 'Keep', color: 'blue', matchers: ['https://k.example/*'] },
    ] };
    const p = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data }, ui)) as { data: { rules: { id: string }[]; warnings: string[] } };
    expect(p.data.rules.map((r) => r.id)).toEqual(['k']);
    expect(p.data.warnings).toEqual(expect.arrayContaining([
      'Rule "" skipped: title must not be empty.',
      'Rule "{repo}" skipped: title uses {repo}, which pattern "https://t.example/*" does not capture.',
    ]));
    const r = await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data, baseRev: configRev(s.getCfg()) }, ui);
    expect(r).toEqual({ ok: true, data: { rules: 1 } });
  });

  it('rejects import data over 5 MB', async () => {
    const s = setup();
    const r = await s.handle({ type: 'import.preview', source: 'tab-deduper', data: { local: { urlExempts: 'x'.repeat(5 * 1024 * 1024 + 1) } } }, ui);
    expect(r).toMatchObject({ ok: false, error: 'Import data too large (max 5 MB)' });
  });
});
