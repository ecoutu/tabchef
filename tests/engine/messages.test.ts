import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configRev, badgeCount, createContentHandler, createDebounce, createHandler, createOnMessage, isCloseChoiceMessage, isPageFactsMessage, isWatchHello,
  type ContentDeps, type HandlerDeps,
} from '../../src/engine/messages';
import { PageFacts } from '../../src/engine/page-facts';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config } from '../../src/core/types';
import { programOf, withGroupRules } from '../helpers/config';

type Loose = { ok: boolean; data: { sets: { key: string }[]; pending: unknown[] }; errors: string[] };
const A = 'https://a.example/x';
const ui = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
const content = { id: 'ext', tab: { id: 9 }, url: 'https://evil.example/' };

function setup(over: Partial<HandlerDeps> = {}) {
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
      update: vi.fn(async (fn: (c: Config) => Config) => { const next = fn(await deps.store.get()); await set(next); return next; }),
      status: async () => ({ syncing: true }),
    },
    port,
    // Background wires the effective (program) settings: config dedupe + recipe urlTransforms (R4).
    getSettings: async () => programOf(cfg).dedupe,
    safety: {
      pause: vi.fn(), resume: vi.fn(), isPaused: () => false, lock: (id) => { locked.add(id); }, unlock: (id) => { locked.delete(id); },
      isLocked: (id) => locked.has(id), lockedTabIds: () => [...locked], undo: vi.fn(async () => {}),
    },
    recentlyClosed: { ready: Promise.resolve(), list: () => [], add: (e) => { added.push(e); return 'id'; } },
    whyLog: { ready: Promise.resolve(), all: () => [], forTab: () => [], add: () => {} },
    ask: { listPending: async () => [{ newTabId: 5, existingTabId: 1, key: 'k', at: 1 }], resolvePending: vi.fn(async () => {}) },
    now: () => 42,
    ...over,
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

  it('never closes anchor tabs (R11)', async () => {
    const s = setup({ isAnchor: (id) => id === 2 });
    s.mk(1, A); s.mk(2, A); s.mk(3, A);
    const r = await s.handle({ type: 'dupes.closeAll' }, ui);
    expect(r).toEqual({ ok: true, data: 1 });
    expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([1, 2]);
    const sets = ((await s.handle({ type: 'dupes.list' }, ui)) as Loose).data.sets;
    expect((sets[0] as unknown as { closable: number }).closable).toBe(0);
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
    const changed = withGroupRules([{ id: 'r', name: 'r', enabled: true, match: { url: 'a.com/*' }, group: { title: 'r', color: 'blue' as const } }]);
    expect(await s.handle({ type: 'config.set', config: changed, baseRev: g.data.rev }, ui)).toEqual({ ok: true, data: null });
    expect(s.set).toHaveBeenCalledTimes(1);
    expect(await s.handle({ type: 'config.set', config: defaultConfig(), baseRev: g.data.rev }, ui)).toEqual({ ok: false, error: 'conflict' });
    expect(s.set).toHaveBeenCalledTimes(1);
    const g2 = (await s.handle({ type: 'config.get' }, ui)) as { data: { rev: string } };
    expect(g2.data.rev).not.toBe(g.data.rev);
    expect((await s.handle({ type: 'config.set', config: defaultConfig(), baseRev: g2.data.rev }, ui)).ok).toBe(true);
  });

  it('config.set checks baseRev inside the store update, against the config it replaces (T13)', async () => {
    const s = setup();
    const base = configRev(defaultConfig());
    const newer = { ...defaultConfig(), dedupe: { ...defaultConfig().dedupe, alwaysSwitchSites: ['x.com'] } };
    // Another writer lands between the handler's read and its write: the update sees the newer config.
    s.deps.store.update = vi.fn(async (fn: (c: Config) => Config) => fn(newer));
    expect(await createHandler(s.deps)({ type: 'config.set', config: defaultConfig(), baseRev: base }, ui)).toEqual({ ok: false, error: 'conflict' });
    expect(s.set).not.toHaveBeenCalled();
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

  it('recent.list and why.all wait for their stores to load (M7)', async () => {
    const s = setup();
    let loaded = false;
    let release!: () => void;
    const ready = new Promise<void>((r) => { release = () => { loaded = true; r(); }; });
    const item = { id: 'x', url: A, title: 't', windowId: 1, reason: 'duplicate', at: 1 };
    const entry = { action: 'grouped', detail: 'd', at: 1 };
    s.deps.recentlyClosed = { ready, list: () => (loaded ? [item] : []), add: () => 'id' };
    s.deps.whyLog = { ready, all: () => (loaded ? [entry] : []), forTab: () => (loaded ? [entry] : []), add: () => {} };
    const handle = createHandler(s.deps);
    const pr = handle({ type: 'recent.list' }, ui);
    const pw = handle({ type: 'why.all' }, ui);
    const pt = handle({ type: 'why.forTab', tabId: 1 }, ui);
    release();
    expect(await pr).toEqual({ ok: true, data: [item] });
    expect(await pw).toEqual({ ok: true, data: [entry] });
    expect(await pt).toEqual({ ok: true, data: [entry] });
  });

  it('config.status reports the store status (I5)', async () => {
    const s = setup();
    s.deps.store.status = async () => ({ syncing: false, warning: 'Synced settings were found and loaded.' });
    expect(await createHandler(s.deps)({ type: 'config.status' }, ui)).toEqual({ ok: true, data: { syncing: false, warning: 'Synced settings were found and loaded.' } });
  });

  it('safety.status lists locked tabs (popup lock toggle)', async () => {
    const s = setup();
    await s.handle({ type: 'tab.lock', tabId: 7 }, ui);
    expect(await s.handle({ type: 'safety.status' }, ui)).toEqual({ ok: true, data: { paused: false, locked: [7] } });
    await s.handle({ type: 'tab.unlock', tabId: 7 }, ui);
    expect(await s.handle({ type: 'safety.status' }, ui)).toEqual({ ok: true, data: { paused: false, locked: [] } });
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

describe('createOnMessage: content channel (R12)', () => {
  it('answers a content message through handleContent and never reaches handleRequest', async () => {
    const handleRequest = vi.fn(async () => ({ ok: true as const, data: 1 }));
    const handleContent = vi.fn((m: unknown) => ((m as { type?: string }).type === 'watch.hello' ? Promise.resolve({ type: 'watch.config' }) : undefined));
    const l = createOnMessage({ runtimeId: 'ext', handleRequest, handleBanner: () => false, handleContent });
    const send = vi.fn();
    expect(l({ type: 'watch.hello', formEdited: false }, content, send)).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'watch.config' }));
    expect(handleRequest).not.toHaveBeenCalled();
    expect(l({ type: 'x' }, ui, vi.fn())).toBe(true);
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});

describe('createContentHandler', () => {
  const PAGE = 'https://meet.google.com/abc';
  const tabSender = { id: 'ext', url: PAGE, tab: { id: 7, url: PAGE }, frameId: 0 };
  function mk() {
    const program = programOf({
      ...defaultConfig(),
      rules: [{ id: 'm', name: 'm', enabled: true, match: { all: [{ url: 'meet.google.com/*' }, { pageText: 'Call ended' }] }, actions: [{ close: {} }] }],
      order: ['user/m'],
    });
    const pageFacts = new PageFacts({ session: { get: async () => undefined, set: async () => {} } });
    const safety = { markFormEdited: vi.fn(), clearFormEdited: vi.fn() };
    const schedule = vi.fn();
    const onFacts = vi.fn();
    const onCloseChoice = vi.fn();
    const d: ContentDeps = {
      runtimeId: 'ext', extensionOrigin: 'chrome-extension://ext', getProgram: async () => program, pageFacts, safety, schedule, onFacts, onCloseChoice,
    };
    return { h: createContentHandler(d), pageFacts, safety, schedule, onFacts, onCloseChoice };
  }
  const facts = { type: 'page.facts', texts: ['Call ended'], extracts: { 'user/m.x': 'v' }, formEdited: true };

  it('type guards', () => {
    expect(isWatchHello({ type: 'watch.hello', formEdited: false })).toBe(true);
    expect(isWatchHello({ type: 'watch.hello' })).toBe(false);
    expect(isPageFactsMessage(facts)).toBe(true);
    expect(isPageFactsMessage({ ...facts, texts: [1] })).toBe(false);
    expect(isPageFactsMessage({ ...facts, extracts: { a: 1 } })).toBe(false);
    expect(isPageFactsMessage({ ...facts, extracts: { a: 'x'.repeat(257) } })).toBe(false);
    expect(isPageFactsMessage({ ...facts, texts: Array(201).fill('a') })).toBe(false);
  });

  it('ignores other message types (returns undefined)', () => {
    expect(mk().h({ type: 'config.get' }, tabSender)).toBeUndefined();
  });

  it('watch.hello: answers the pulled watch config for the sender tab URL and re-reports formEdited (D34)', async () => {
    const { h, safety } = mk();
    expect(await h({ type: 'watch.hello', formEdited: true }, tabSender)).toEqual({ type: 'watch.config', needles: ['Call ended'], selectors: [] });
    expect(safety.markFormEdited).toHaveBeenCalledWith(7, PAGE);
    expect(await h({ type: 'watch.hello', formEdited: false }, tabSender)).toMatchObject({ type: 'watch.config' });
    expect(safety.markFormEdited).toHaveBeenCalledTimes(1);
  });

  it('watch.hello after a same-document navigation: config for the frame URL, stale facts cleared, hold restarted', async () => {
    const { h, pageFacts } = mk();
    await h(facts, tabSender);
    expect(pageFacts.get(7)).toBeDefined();
    // pushState: the hello's frame URL is the new one even if the tab's URL has not caught up yet.
    const moved = { ...tabSender, url: 'https://meet.google.com/other', tab: { id: 7, url: 'https://elsewhere.example/' } };
    expect(await h({ type: 'watch.hello', formEdited: false }, moved)).toEqual({ type: 'watch.config', needles: ['Call ended'], selectors: [] });
    expect(pageFacts.get(7)).toBeUndefined();
    expect(pageFacts.awaiting(7)).toBe(true);
    await h(facts, moved);
    expect(pageFacts.awaiting(7)).toBe(false);
    expect(pageFacts.get(7)).toMatchObject({ texts: ['Call ended'] });
  });

  it('page.facts: stores the facts, feeds SafetyService, schedules a reconcile and calls the onFacts hook', async () => {
    const { h, pageFacts, safety, schedule, onFacts } = mk();
    await h(facts, tabSender);
    expect(pageFacts.get(7)).toEqual({ texts: ['Call ended'], extracts: { 'user/m.x': 'v' }, formEdited: true });
    expect(safety.markFormEdited).toHaveBeenCalledWith(7, PAGE);
    expect(schedule).toHaveBeenCalledWith('pageFacts');
    expect(onFacts).toHaveBeenCalledWith(7);
    await h({ ...facts, formEdited: false }, tabSender);
    expect(safety.clearFormEdited).toHaveBeenCalledWith(7);
  });

  it('accepts only a content script in a real tab, top frame (never an extension page or a sub-frame)', async () => {
    const { h, pageFacts, schedule } = mk();
    for (const s of [ui, { id: 'ext', url: 'chrome-extension://ext/options.html', tab: { id: 7 } }, { ...tabSender, frameId: 3 }, { id: 'ext', url: PAGE }]) {
      expect(await h(facts, s)).toEqual({ ok: false, error: 'forbidden' });
      expect(await h({ type: 'watch.hello', formEdited: false }, s)).toEqual({ ok: false, error: 'forbidden' });
    }
    expect(pageFacts.get(7)).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('banner.closeChoice (D22): guarded, sender-checked, passed on for the sending tab', async () => {
    expect(isCloseChoiceMessage({ type: 'banner.closeChoice', choice: 'close' })).toBe(true);
    expect(isCloseChoiceMessage({ type: 'banner.closeChoice', choice: 'keep' })).toBe(true);
    expect(isCloseChoiceMessage({ type: 'banner.closeChoice', choice: 'switch' })).toBe(false);
    expect(isCloseChoiceMessage({ type: 'banner.choice', choice: 'close' })).toBe(false);
    const { h, onCloseChoice } = mk();
    for (const s of [ui, { ...tabSender, frameId: 3 }, { id: 'ext', url: PAGE }]) {
      expect(await h({ type: 'banner.closeChoice', choice: 'close' }, s)).toEqual({ ok: false, error: 'forbidden' });
    }
    expect(onCloseChoice).not.toHaveBeenCalled();
    expect(await h({ type: 'banner.closeChoice', choice: 'keep' }, tabSender)).toEqual({ ok: true });
    expect(onCloseChoice).toHaveBeenCalledWith(7, 'keep');
  });

  it('page.facts and watch.hello never go through createHandler (extension pages only)', async () => {
    const s = setup();
    expect(await s.handle({ type: 'watch.hello', formEdited: false }, ui)).toEqual({ ok: false, error: 'unknown request' });
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
    const cfg = withGroupRules([{ id: 'old', name: 'Old', enabled: true, match: { url: 'o.example/*' }, group: { title: 'Old', color: 'green' } }]);
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

  it('apply maps imported ids to the v2 id pattern', async () => {
    const s = setup();
    const cfg = seed(s);
    const data = { groups: [{ id: 'Not A Valid/Id', title: 'X', color: 'blue', matchers: ['https://x.example/*'] }] };
    expect((await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data, baseRev: configRev(cfg) }, ui)).ok).toBe(true);
    const saved = s.set.mock.calls[0]![0] as Config;
    expect(saved.rules[1]!.id).toBe('not-a-valid-id');
    expect(saved.order).toEqual(['user/old', 'user/not-a-valid-id']);
  });

  it('apply appends after existing rules, renames colliding ids, merges dedupe', async () => {
    const s = setup();
    const cfg = seed(s);
    const r = await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: agt, baseRev: configRev(cfg) }, ui);
    expect(r.ok).toBe(true);
    const saved = s.set.mock.calls[0]![0] as Config;
    expect(saved.rules.map((x) => x.name)).toEqual(['Old', 'New', 'Dup']);
    expect(saved.rules[1]!.actions[0]).toEqual({ group: { title: 'New', color: 'blue', strict: true, merge: false } });
    expect(saved.rules[1]!.id).toBe('n1');
    expect(saved.rules[2]!.id).not.toBe('old');
    expect(new Set(saved.rules.map((x) => x.id)).size).toBe(3);
    expect(saved.order).toEqual(saved.rules.map((x) => `user/${x.id}`));
    const t = await s.handle({ type: 'import.apply', source: 'tab-deduper', data: { local: { dedupAllWindows: false, urlExempts: 'a.com' } }, baseRev: configRev(cfg) }, ui);
    expect(t.ok).toBe(true);
    const saved2 = s.set.mock.calls[1]![0] as Config;
    expect(saved2.dedupe).toMatchObject({ scope: 'same-window', allowDuplicates: ['a.com*'], mode: 'always-switch' });
    expect(saved2.rules).toHaveLength(1);
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
