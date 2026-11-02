import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adoptReport, configRev, badgeCount, createContentHandler, createDebounce, createHandler, createOnMessage, isCloseChoiceMessage, isPageFactsMessage, isRequest, isWatchHello,
  type ContentDeps, type HandlerDeps,
} from '../../src/engine/messages';
import { PageFacts } from '../../src/engine/page-facts';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config } from '../../src/core/types';
import { programOf, withGroupRules } from '../helpers/config';
import { builtinRecipes } from '../../src/recipes/load';
import { builtinConnectionDefs } from '../../src/core/connections/builtin';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';

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

  it('M3: dupes.closeAll / closeExtras issued before locks and anchors load wait for them: a locked tab and an anchor stay', async () => {
    for (const req of [{ type: 'dupes.closeAll' }, { type: 'dupes.closeExtras' }] as const) {
      let load!: () => void;
      const loaded = new Promise<void>((r) => { load = r; });
      const anchors = new Set<number>();
      const s = setup({ isAnchor: (id) => anchors.has(id), beforeClose: () => loaded });
      s.mk(1, A); s.mk(2, A); s.mk(3, A); s.mk(4, A);
      const key = ((await s.handle({ type: 'dupes.list' }, ui)) as Loose).data.sets[0]!.key;
      const r = s.handle(req.type === 'dupes.closeAll' ? req : { ...req, key }, ui);
      await new Promise((x) => setTimeout(x, 0));
      expect((await s.port.snapshot()).tabs).toHaveLength(4); // nothing decided yet
      s.locked.add(3); anchors.add(2); // the stored locks and anchors arrive
      load();
      expect(await r).toEqual({ ok: true, data: 1 });
      expect((await s.port.snapshot()).tabs.map((t) => t.id)).toEqual([1, 2, 3]);
    }
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
    // eslint-disable-next-line prefer-const
    let d: ContentDeps;
    const pageFacts = new PageFacts({ session: { get: async () => undefined, set: async () => {} }, onAdopt: (id, r) => adoptReport(d, id, r) });
    const safety = { markFormEdited: vi.fn(), clearFormEdited: vi.fn() };
    const schedule = vi.fn();
    const onFacts = vi.fn();
    const onCloseChoice = vi.fn();
    d = {
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

  it('the TS rule cap on pageText needles equals the guard bound (I2)', async () => {
    const { MAX_PAGE_TEXT } = await import('../../src/core/config/schema');
    const { MAX_FACT_TEXT } = await import('../../src/engine/messages');
    expect(MAX_PAGE_TEXT).toBe(MAX_FACT_TEXT);
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

  it('page.facts from a document that is no longer the tab\'s current one are dropped (sender.documentId)', async () => {
    const { h, pageFacts, safety, onFacts } = mk();
    await h({ type: 'watch.hello', formEdited: false }, { ...tabSender, documentId: 'doc-a' });
    pageFacts.onCommitted(7, PAGE, 'doc-b'); // the tab navigated; the old document's report is still in flight
    expect(await h(facts, { ...tabSender, documentId: 'doc-a' })).toEqual({ ok: false, error: 'stale document' });
    expect(pageFacts.get(7)).toBeUndefined();
    expect(onFacts).not.toHaveBeenCalled();
    expect(safety.markFormEdited).not.toHaveBeenCalled();
    await h(facts, { ...tabSender, documentId: 'doc-b' });
    expect(pageFacts.get(7)).toMatchObject({ texts: ['Call ended'] });
  });

  // Only webNavigation commits retire documents; a hello never retires one, never changes the current one, and is
  // always answered with the watch config.
  const CONFIG = { type: 'watch.config', needles: ['Call ended'], selectors: [] };

  it('a bfcache-restored page whose hello beats its own commit still gets its config; its facts count after the commit', async () => {
    const { h, pageFacts } = mk();
    pageFacts.onCommitted(7, PAGE, 'doc-a');
    pageFacts.onCommitted(7, PAGE, 'doc-b'); // A is retired
    expect(await h({ type: 'watch.hello', formEdited: false }, { ...tabSender, documentId: 'doc-a' })).toEqual(CONFIG);
    pageFacts.onCommitted(7, PAGE, 'doc-a'); // the restore's commit lands after the pageshow hello
    expect(await h(facts, { ...tabSender, documentId: 'doc-a' })).toEqual({ ok: true });
    expect(pageFacts.get(7)).toMatchObject({ texts: ['Call ended'] });
  });

  it('a late hello from a retired document gets the config but leaves the current document\'s facts alone', async () => {
    const { h, pageFacts, safety } = mk();
    pageFacts.onCommitted(7, PAGE, 'doc-a');
    pageFacts.onCommitted(7, PAGE, 'doc-b');
    expect(await h(facts, { ...tabSender, documentId: 'doc-b' })).toEqual({ ok: true });
    safety.markFormEdited.mockClear();
    expect(await h({ type: 'watch.hello', formEdited: true }, { ...tabSender, documentId: 'doc-a' })).toEqual(CONFIG);
    expect(pageFacts.get(7)).toMatchObject({ texts: ['Call ended'] });
    expect(pageFacts.awaiting(7)).toBe(false);
    expect(safety.markFormEdited).not.toHaveBeenCalled();
    expect(await h(facts, { ...tabSender, documentId: 'doc-a' })).toEqual({ ok: false, error: 'stale document' });
  });

  it('a hello from a document the worker never saw (it restarted) does not retire or replace the current one', async () => {
    const { h, pageFacts } = mk();
    pageFacts.onCommitted(7, PAGE, 'doc-b'); // the only commit this worker saw
    expect(await h(facts, { ...tabSender, documentId: 'doc-b' })).toEqual({ ok: true });
    expect(await h({ type: 'watch.hello', formEdited: false }, { ...tabSender, documentId: 'doc-x' })).toEqual(CONFIG);
    expect(pageFacts.isRetiredDocument(7, 'doc-b')).toBe(false);
    expect(pageFacts.isCurrentDocument(7, 'doc-b')).toBe(true);
    expect(pageFacts.get(7)).toMatchObject({ texts: ['Call ended'] });
    expect(await h(facts, { ...tabSender, documentId: 'doc-b' })).toEqual({ ok: true });
  });

  it('a new document\'s watch.hello that arrives before its own commit gets the config; its facts count after the commit', async () => {
    const { h, pageFacts } = mk();
    pageFacts.onCommitted(7, PAGE, 'doc-a');
    expect(await h({ type: 'watch.hello', formEdited: false }, { ...tabSender, documentId: 'doc-b' })).toEqual(CONFIG);
    pageFacts.onCommitted(7, PAGE, 'doc-b'); // webNavigation.onCommitted for B lands after B's hello
    expect(await h(facts, { ...tabSender, documentId: 'doc-b' })).toEqual({ ok: true });
    expect(await h(facts, { ...tabSender, documentId: 'doc-a' })).toEqual({ ok: false, error: 'stale document' });
  });

  it('Back to an edited page (bfcache): its hello and report beat its commit, and are adopted when it commits', async () => {
    const { h, pageFacts, safety, onFacts } = mk();
    pageFacts.onCommitted(7, PAGE, 'doc-a');
    pageFacts.onCommitted(7, 'https://meet.google.com/b', 'doc-b');
    const a = { ...tabSender, documentId: 'doc-a' };
    expect(await h({ type: 'watch.hello', formEdited: true }, a)).toEqual(CONFIG);
    expect(await h(facts, a)).toEqual({ ok: false, error: 'stale document' });
    expect(safety.markFormEdited).not.toHaveBeenCalled(); // not B's edits
    pageFacts.onCommitted(7, PAGE, 'doc-a'); // A's commit lands
    expect(safety.markFormEdited).toHaveBeenCalledWith(7, PAGE);
    expect(pageFacts.get(7)).toEqual({ texts: ['Call ended'], extracts: { 'user/m.x': 'v' }, formEdited: true });
    expect(pageFacts.awaiting(7)).toBe(false);
    expect(onFacts).toHaveBeenCalledWith(7);
  });

  it('a late report from a document whose commit never comes is never applied to another document', async () => {
    const { h, pageFacts, safety, onFacts } = mk();
    pageFacts.onCommitted(7, PAGE, 'doc-a');
    pageFacts.onCommitted(7, PAGE, 'doc-b');
    const bFacts = { type: 'page.facts', texts: [], extracts: {}, formEdited: false };
    expect(await h(bFacts, { ...tabSender, documentId: 'doc-b' })).toEqual({ ok: true });
    safety.markFormEdited.mockClear();
    onFacts.mockClear();
    expect(await h(facts, { ...tabSender, documentId: 'doc-a' })).toEqual({ ok: false, error: 'stale document' });
    expect(pageFacts.get(7)).toEqual({ texts: [], extracts: {}, formEdited: false });
    pageFacts.onCommitted(7, PAGE, 'doc-c'); // the tab moves on; A never commits again
    expect(pageFacts.get(7)).toBeUndefined();
    expect(safety.markFormEdited).not.toHaveBeenCalled();
    expect(onFacts).not.toHaveBeenCalled();
  });

  it('form edits are recorded for the frame URL the report came from, as the watch config is', async () => {
    const { h, safety } = mk();
    const moved = { ...tabSender, url: 'https://meet.google.com/other', tab: { id: 7, url: PAGE } }; // pushState race
    await h(facts, moved);
    expect(safety.markFormEdited).toHaveBeenCalledWith(7, 'https://meet.google.com/other');
    await h({ type: 'watch.hello', formEdited: true }, moved);
    expect(safety.markFormEdited).toHaveBeenLastCalledWith(7, 'https://meet.google.com/other');
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

  it('page.facts with an oversized field: that field is dropped, formEdited is kept (I2)', async () => {
    const { h, pageFacts, safety, schedule } = mk();
    expect(await h({ ...facts, texts: ['ok', 'x'.repeat(501)] }, tabSender)).toEqual({ ok: true });
    expect(pageFacts.get(7)).toEqual({ texts: [], extracts: { 'user/m.x': 'v' }, formEdited: true });
    expect(safety.markFormEdited).toHaveBeenCalledWith(7, PAGE);
    await h({ ...facts, texts: Array(201).fill('a'), extracts: { ['k'.repeat(501)]: 'v' } }, tabSender);
    expect(pageFacts.get(7)).toEqual({ texts: [], extracts: {}, formEdited: true });
    await h({ ...facts, texts: 'nope', extracts: { a: 'x'.repeat(257) } }, tabSender);
    expect(pageFacts.get(7)).toEqual({ texts: [], extracts: {}, formEdited: true });
    expect(safety.markFormEdited).toHaveBeenCalledTimes(3);
    expect(schedule).toHaveBeenCalledTimes(3);
    // Still not ours without a boolean formEdited.
    expect(h({ type: 'page.facts', texts: [], extracts: {} }, tabSender)).toBeUndefined();
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

  describe('collapse suggestions (M2 T19)', () => {
    const repos = { groups: [
      ...['web', 'api', 'cli'].map((x, i) => ({ id: x, title: x, color: i === 2 ? 'red' : 'blue', matchers: [`https://h.example/acme/${x}*`], options: { strict: true } })),
      { id: 'rest', title: 'Rest', color: 'grey', matchers: ['https://h.example/*'] },
    ] };
    type Prev = { ok: boolean; data: { collapse: { replaces: string[]; rule: { id: string }; table: { name: string }; notes: string[] }[] } };

    it('preview lists suggestions on the migrated rules (ids as apply would assign them)', async () => {
      const s = setup();
      seed(s);
      const p = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: repos }, ui)) as Prev;
      expect(p.ok).toBe(true);
      expect(p.data.collapse).toHaveLength(1);
      expect(p.data.collapse[0]).toMatchObject({ replaces: ['web', 'api', 'cli'], rule: { id: 'collapsed-acme' }, table: { name: 'acmeColors' } });
      const none = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: agt }, ui)) as Prev;
      expect(none.data.collapse).toEqual([]);
      const td = (await s.handle({ type: 'import.preview', source: 'tab-deduper', data: { local: {} } }, ui)) as Prev;
      expect(td.data.collapse).toEqual([]);
      expect(s.set).not.toHaveBeenCalled();
    });

    it('apply without collapse keeps every rule; with collapse [0] replaces the run in place and adds the table', async () => {
      const s = setup();
      const cfg = seed(s);
      expect((await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: repos, baseRev: configRev(cfg) }, ui)).ok).toBe(true);
      expect((s.set.mock.calls[0]![0] as Config).rules.map((x) => x.id)).toEqual(['old', 'web', 'api', 'cli', 'rest']);
      const r = await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: repos, baseRev: configRev(cfg), collapse: [0] }, ui);
      expect(r).toEqual({ ok: true, data: { rules: 2 } });
      const saved = s.set.mock.calls[1]![0] as Config;
      expect(saved.rules.map((x) => x.id)).toEqual(['old', 'collapsed-acme', 'rest']);
      expect(saved.order).toEqual(['user/old', 'user/collapsed-acme', 'user/rest']);
      expect(saved.tables).toEqual({ acmeColors: { web: 'blue', api: 'blue', cli: 'red' } });
      expect(saved.rules[1]!.actions[0]).toEqual({ group: { title: '{acme|lower}', color: '{acme|lower|map:acmeColors|default:blue}', strict: true, merge: false } });
    });

    it('M1/R68: import.preview returns the config import.apply would store (for the chosen collapse), so the UI can preview it', async () => {
      const s = setup();
      const cfg = seed(s);
      type WithConfig = { ok: boolean; data: { config: Config } };
      const plain = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: repos }, ui)) as WithConfig;
      const collapsed = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: repos, collapse: [0] }, ui)) as WithConfig;
      expect(s.set).not.toHaveBeenCalled();
      await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: repos, baseRev: configRev(cfg) }, ui);
      expect(plain.data.config).toEqual(s.set.mock.calls[0]![0]);
      await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: repos, baseRev: configRev(cfg), collapse: [0] }, ui);
      expect(collapsed.data.config).toEqual(s.set.mock.calls[1]![0]);
      expect(await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: repos, collapse: [1] }, ui)).toMatchObject({ ok: false, error: 'unknown collapse suggestion' });
      expect(await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: repos, collapse: ['x'] }, ui)).toEqual({ ok: false, error: 'unknown request' });
    });

    it('re-derives suggestions server-side: unknown indices fail, a client-sent rule is never used', async () => {
      const s = setup();
      const cfg = seed(s);
      expect(await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: repos, baseRev: configRev(cfg), collapse: [1] }, ui))
        .toMatchObject({ ok: false, error: 'unknown collapse suggestion' });
      const forged = { type: 'import.apply', source: 'auto-group-tabs', data: repos, baseRev: configRev(cfg), collapse: [0], rule: { id: 'evil' } };
      expect((await s.handle(forged, ui)).ok).toBe(true);
      expect((s.set.mock.calls[0]![0] as Config).rules.map((x) => x.id)).not.toContain('evil');
    });

    it('avoids existing table names', async () => {
      const s = setup();
      const cfg = { ...seed(s), tables: { acmeColors: { x: 'red' } } };
      s.deps.store.get = async () => cfg;
      const p = (await s.handle({ type: 'import.preview', source: 'auto-group-tabs', data: repos }, ui)) as Prev;
      expect(p.data.collapse[0]!.table.name).toBe('acmeColors2');
      expect((await s.handle({ type: 'import.apply', source: 'auto-group-tabs', data: repos, baseRev: configRev(cfg), collapse: [0] }, ui)).ok).toBe(true);
      expect((s.set.mock.calls[0]![0] as Config).tables).toEqual({ acmeColors: { x: 'red' }, acmeColors2: { web: 'blue', api: 'blue', cli: 'red' } });
    });

    it('the guard accepts only a list of non-negative integer indices', () => {
      const base = { type: 'import.apply', source: 'auto-group-tabs', data: {}, baseRev: 'r' };
      expect(isRequest({ ...base, collapse: [0, 2] })).toBe(true);
      expect(isRequest(base)).toBe(true);
      for (const bad of ['0', [-1], [1.5], [null], { 0: 0 }]) expect(isRequest({ ...base, collapse: bad })).toBe(false);
    });
  });

  it('rejects import data over 5 MB', async () => {
    const s = setup();
    const r = await s.handle({ type: 'import.preview', source: 'tab-deduper', data: { local: { urlExempts: 'x'.repeat(5 * 1024 * 1024 + 1) } } }, ui);
    expect(r).toMatchObject({ ok: false, error: 'Import data too large (max 5 MB)' });
  });
});

describe('preview.change (M2 T13)', () => {
  const MUTATING = new Set(['group', 'ungroup', 'moveTabs', 'moveGroup', 'updateGroup', 'closeTab', 'createTab', 'focusTab']);
  const exRule = { id: 'ex', name: 'EX', enabled: true, match: { url: 'example.com/*' }, actions: [{ group: { title: 'ex', color: 'blue' } }] };
  const otherRule = { id: 'ot', name: 'OT', enabled: true, match: { url: 'other.org/*' }, actions: [{ group: { title: 'ot', color: 'red' } }] };
  const withRules = (rules: unknown[], o: Partial<Config> = {}): Config => ({
    ...defaultConfig(), rules: rules as Config['rules'], order: (rules as { id: string }[]).map((r) => `user/${r.id}`), ...o,
  });
  type Prev = { ok: boolean; error?: string; data: { moves: { tabId: number; to?: string; dryRun?: true }[]; closes: { tabId: number }[] } };

  function previewSetup(o: { leaveAlone?: number[]; check?: (n: { origins: string[] }) => boolean; facts?: Record<number, string[]> } = {}) {
    const planContext = vi.fn(async () => ({
      leaveAlone: new Set(o.leaveAlone ?? []), managedTitles: new Set<string>(), creationOrder: new Map<string, number>(), anchorsDismissed: new Set<string>(),
    }));
    const s = setup({
      preview: {
        builtins: builtinRecipes(),
        getProgram: async () => programOf(s.getCfg()),
        planContext,
        facts: (id) => (o.facts?.[id] ? { page: { texts: o.facts[id]!, extracts: {}, formEdited: false } } : {}),
        permissions: { check: async (n) => ({ ok: (o.check ?? (() => true))(n), missing: { origins: [], permissions: [] } }) },
      },
    });
    return { ...s, planContext };
  }

  it('lists the tabs a draft config would move, from one snapshot and with no browser mutation', async () => {
    const s = previewSetup();
    s.mk(1, 'https://example.com/a'); s.mk(2, 'https://other.org/'); s.mk(3, 'https://example.com/b');
    s.port.calls.length = 0;
    const r = (await s.handle({ type: 'preview.change', config: withRules([exRule]) }, ui)) as Prev;
    expect(r.ok).toBe(true);
    expect(r.data.moves.map((m) => [m.tabId, m.to])).toEqual([[1, 'ex'], [3, 'ex']]);
    expect(s.port.calls.filter((c) => MUTATING.has(c.method))).toEqual([]);
    expect(s.port.calls.filter((c) => c.method === 'snapshot')).toHaveLength(1);
    expect(s.planContext).toHaveBeenCalledOnce();
    expect(s.set).not.toHaveBeenCalled();
  });

  it('uses the engine plan context (leave-alone tabs stay put)', async () => {
    const s = previewSetup({ leaveAlone: [3] });
    s.mk(1, 'https://example.com/a'); s.mk(3, 'https://example.com/b');
    const r = (await s.handle({ type: 'preview.change', config: withRules([exRule]) }, ui)) as Prev;
    expect(r.data.moves.map((m) => m.tabId)).toEqual([1]);
  });

  it('`only`: tests one rule alone against the open tabs (disabled and dry-run rules too)', async () => {
    const s = previewSetup();
    s.mk(1, 'https://example.com/a'); s.mk(2, 'https://other.org/');
    const cfg = withRules([{ ...exRule, enabled: false, dryRun: true }, otherRule]);
    const r = (await s.handle({ type: 'preview.change', config: cfg, only: 'user/ex' }, ui)) as Prev;
    expect(r.data.moves).toEqual([expect.objectContaining({ tabId: 1, to: 'ex' })]);
    expect(r.data.moves[0]!.dryRun).toBeUndefined();
    expect(await s.handle({ type: 'preview.change', config: cfg, only: 'user/nope' }, ui)).toMatchObject({ ok: false, error: 'unknown rule' });
  });

  it('enabling a recipe: rules whose needs are not granted are paused in the preview, as in the engine', async () => {
    const s = previewSetup({ check: (n) => n.origins.length === 0, facts: { 2: ['You left the meeting'] } });
    s.mk(1, 'http://localhost:8080/cb/callback'); s.mk(2, 'https://meet.google.com/abc');
    const on = { ...defaultConfig(), recipes: defaultConfig().recipes.map((x) => (x.id === 'finished' ? { ...x, enabled: true } : x)) };
    const r = (await s.handle({ type: 'preview.change', config: on }, ui)) as Prev;
    expect(r.data.closes.map((c) => c.tabId)).toEqual([1]);
  });

  it('invalid config, missing deps, malformed requests and foreign senders', async () => {
    const s = previewSetup();
    expect(await s.handle({ type: 'preview.change', config: { version: 2 } }, ui)).toMatchObject({ ok: false, error: 'invalid config' });
    for (const bad of [{ type: 'preview.change' }, { type: 'preview.change', config: null }, { type: 'preview.change', config: defaultConfig(), only: 3 }]) {
      expect(await s.handle(bad, ui)).toEqual({ ok: false, error: 'unknown request' });
    }
    expect(await s.handle({ type: 'preview.change', config: defaultConfig() }, content)).toEqual({ ok: false, error: 'forbidden' });
    expect(await setup().handle({ type: 'preview.change', config: defaultConfig() }, ui)).toEqual({ ok: false, error: 'preview unavailable' });
  });
});

describe('explain.tab / rules.shadowed (M2 T14)', () => {
  const MUTATING = new Set(['group', 'ungroup', 'moveTabs', 'moveGroup', 'updateGroup', 'closeTab', 'createTab', 'focusTab', 'setBadge']);
  const r = (id: string, url: string, title: string, o = {}) => ({ id, name: `Rule ${id}`, enabled: true, match: { url }, actions: [{ group: { title, color: 'blue' } }], ...o });
  const withRules = (rules: unknown[], o: Partial<Config> = {}): Config => ({
    ...defaultConfig(), rules: rules as Config['rules'], order: (rules as { id: string }[]).map((x) => `user/${x.id}`), ...o,
  });
  type Ex = { ok: boolean; error?: string; data: { tab: { id: number; url: string; groupTitle?: string }; hasPageFacts: boolean; rules: { key: string; name: string; won: string[]; lostTo: Record<string, string>; paused?: string; dryRun?: true }[] } };

  function explainSetup(o: { check?: (n: { origins: string[] }) => boolean; facts?: Record<number, string[]> } = {}) {
    const whyAdd = vi.fn();
    const s = setup({
      whyLog: { ready: Promise.resolve(), all: () => [], forTab: () => [], add: whyAdd },
      explain: {
        builtins: builtinRecipes(),
        facts: (id) => (o.facts?.[id] ? { page: { texts: o.facts[id]!, extracts: {}, formEdited: false } } : {}),
        permissions: { check: async (n) => (o.check ?? (() => true))(n)
          ? { ok: true, missing: { origins: [], permissions: [] } }
          : { ok: false, missing: { origins: n.origins, permissions: [] }, reason: `Paused: needs access to ${n.origins[0]}` } },
      },
    });
    return { ...s, whyAdd };
  }

  it('explain.tab: why the tab is here (won / lostTo / dry run), read-only', async () => {
    const s = explainSetup();
    await s.deps.store.set(withRules([r('d', 'x.com/*', 'D', { dryRun: true }), r('a', 'x.com/*', 'A'), r('b', 'x.com/*', 'B'), r('y', 'y.com/*', 'Y')]));
    s.set.mockClear();
    s.port.addGroup({ id: 7, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    s.mk(1, 'https://x.com/1', { groupId: 7 });
    s.port.calls.length = 0;
    const res = (await s.handle({ type: 'explain.tab', tabId: 1 }, ui)) as Ex;
    expect(res.ok).toBe(true);
    expect(res.data.tab).toMatchObject({ id: 1, url: 'https://x.com/1', groupTitle: 'A' });
    expect(res.data.hasPageFacts).toBe(false);
    expect(res.data.rules.map((e) => [e.key, e.name, e.won, e.lostTo, e.dryRun])).toEqual([
      ['user/d', 'Rule d', ['group'], {}, true],
      ['user/a', 'Rule a', ['group'], {}, undefined],
      ['user/b', 'Rule b', [], { group: 'user/a' }, undefined],
    ]);
    expect(s.port.calls.filter((c) => MUTATING.has(c.method))).toEqual([]);
    expect(s.set).not.toHaveBeenCalled();
    expect(s.deps.store.update).not.toHaveBeenCalled();
    expect(s.whyAdd).not.toHaveBeenCalled();
  });

  it('explain.tab: paused recipe rules carry their reason (R45); page facts are used', async () => {
    const s = explainSetup({ check: (n) => n.origins.length === 0, facts: { 2: ['You left the meeting'] } });
    await s.deps.store.set({ ...defaultConfig(), recipes: defaultConfig().recipes.map((x) => (x.id === 'finished' ? { ...x, enabled: true } : x)) });
    s.mk(2, 'https://meet.google.com/abc');
    const res = (await s.handle({ type: 'explain.tab', tabId: 2 }, ui)) as Ex;
    expect(res.data.hasPageFacts).toBe(true);
    const paused = res.data.rules.filter((e) => e.paused);
    expect(paused.length).toBeGreaterThan(0);
    for (const e of paused) expect(e.paused).toMatch(/^Paused: needs access to /);
    expect(paused.every((e) => e.won.length === 0)).toBe(true);
  });

  it('explain.tab: unknown tab, malformed requests, foreign senders, missing deps', async () => {
    const s = explainSetup();
    expect(await s.handle({ type: 'explain.tab', tabId: 99 }, ui)).toEqual({ ok: false, error: 'tab not found' });
    for (const bad of [{ type: 'explain.tab' }, { type: 'explain.tab', tabId: '1' }]) expect(await s.handle(bad, ui)).toEqual({ ok: false, error: 'unknown request' });
    expect(await s.handle({ type: 'explain.tab', tabId: 1 }, content)).toEqual({ ok: false, error: 'forbidden' });
    expect(await setup().handle({ type: 'explain.tab', tabId: 1 }, ui)).toEqual({ ok: false, error: 'explain unavailable' });
  });

  it('rules.shadowed: the stored config, or a draft; with the shadowing rule\'s name', async () => {
    const s = explainSetup();
    await s.deps.store.set(withRules([r('all', 'x.com/*', 'All'), r('sub', 'x.com/sub/*', 'Sub')]));
    s.set.mockClear();
    expect(await s.handle({ type: 'rules.shadowed' }, ui)).toEqual({ ok: true, data: [{ key: 'user/sub', shadowedBy: 'user/all', name: 'Rule all' }] });
    const draft = withRules([r('sub', 'x.com/sub/*', 'Sub'), r('all', 'x.com/*', 'All')]);
    expect(await s.handle({ type: 'rules.shadowed', config: draft }, ui)).toEqual({ ok: true, data: [] });
    expect(await s.handle({ type: 'rules.shadowed', config: { version: 2 } }, ui)).toMatchObject({ ok: false, error: 'invalid config' });
    expect(s.set).not.toHaveBeenCalled();
    expect(await s.handle({ type: 'rules.shadowed', config: 3 }, ui)).toEqual({ ok: false, error: 'unknown request' });
    expect(await s.handle({ type: 'rules.shadowed' }, content)).toEqual({ ok: false, error: 'forbidden' });
    expect(await setup().handle({ type: 'rules.shadowed' }, ui)).toEqual({ ok: false, error: 'explain unavailable' });
  });
});

describe('connections.* (M3 T7)', () => {
  const PAT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const DEVICE_CODE = 'dc_3584d83530557fdd1f46af8289938c8ef79f9dc5';
  const ACCESS = 'ghu_16C7e42F292c6912E7710c838347Ae178B4a';
  const SECRET_KEYS = /^(token|device_code|deviceCode|access_token|refresh_token|refreshToken)$/;
  type FetchFn = typeof fetch;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const urlOf = (u: Parameters<FetchFn>[0]) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url);

  /** Fails when `v` holds a secret value or a key that names one, at any depth. */
  function deepScan(v: unknown, secrets: string[], path = '$'): void {
    if (typeof v === 'string') {
      for (const s of secrets) expect(v.includes(s), `${path} contains a secret`).toBe(false);
    } else if (Array.isArray(v)) v.forEach((x, i) => deepScan(x, secrets, `${path}[${i}]`));
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        expect(SECRET_KEYS.test(k), `${path}.${k} is a secret field`).toBe(false);
        deepScan(x, secrets, `${path}.${k}`);
      }
    }
  }

  async function connRig(opts: { token?: () => Response; user?: () => Response } = {}) {
    fakeBrowser.reset();
    const { SecretStore } = await import('../../src/engine/connections/secret-store');
    const { RateLimiter } = await import('../../src/engine/connections/rate-limiter');
    const { ConnectionManager } = await import('../../src/engine/connections/manager');
    const { GitHubDeviceAuth, GITHUB_DEVICE_CODE_URL, GITHUB_TOKEN_URL } = await import('../../src/engine/connections/github-auth');
    const { TokenAuth, setGitHubToken } = await import('../../src/engine/connections/token-auth');
    const secrets = new SecretStore({ local: browser.storage.local, session: browser.storage.session });
    const f = vi.fn<FetchFn>(async (u) => {
      const url = urlOf(u);
      if (url === GITHUB_DEVICE_CODE_URL) {
        return json(200, { device_code: DEVICE_CODE, user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      if (url === GITHUB_TOKEN_URL) return (opts.token ?? (() => json(200, { error: 'authorization_pending' })))();
      if (url === 'https://api.github.com/user') return (opts.user ?? (() => json(200, { login: 'octo' })))();
      return json(404, {});
    });
    const port = { hasPermission: vi.fn(async () => true) };
    const holder: { manager?: InstanceType<typeof ConnectionManager> } = {};
    const device = new GitHubDeviceAuth({ fetch: f, secrets, session: browser.storage.session, port, manager: () => holder.manager! });
    const token = new TokenAuth();
    const manager = new ConnectionManager({
      local: browser.storage.local, session: browser.storage.session, secrets, limiter: new RateLimiter(browser.storage.session),
      port, fetch: f, auth: { 'device-code': device, token, session: token, 'oauth-pkce': token, 'oauth-proxy': token },
    });
    holder.manager = manager;
    const connections: NonNullable<HandlerDeps['connections']> = {
      manager, github: device, knownSecrets: () => secrets.knownSecrets(),
      setGitHubToken: (t) => setGitHubToken({ manager, secrets, port, fetch: f }, t),
    };
    return { ...setup({ connections }), manager, secrets, device, fetch: f, connections };
  }
  const all = async () => [PAT, DEVICE_CODE, ACCESS];

  it('connections.list: the GitHub def (built in until saved) and its status, never a token (deep scan)', async () => {
    const s = await connRig();
    const empty = await s.handle({ type: 'connections.list' }, ui);
    expect(empty).toMatchObject({ ok: true, data: { defs: [{ id: 'github', label: 'GitHub' }], status: [{ id: 'github', state: 'not-configured' }] } });
    // A token stored, a stray `token` field in the stored def, and a raw token in the stored last error.
    await s.secrets.setSecret('github', { token: PAT });
    await browser.storage.local.set({ connections: [{ ...builtinConnectionDefs().github, auth: 'token', login: 'octo', token: PAT, extra: { refresh_token: PAT } }] });
    await browser.storage.session.set({ 'conn.status': { github: { lastError: `boom ${PAT}`, lastKind: 'server' } } });
    const r = await s.handle({ type: 'connections.list' }, ui);
    expect(r).toMatchObject({ ok: true, data: { defs: [{ id: 'github', auth: 'token', login: 'octo' }], status: [{ id: 'github', state: 'error' }] } });
    deepScan(r, await all());
  });

  it('every connections.* request from a content script (or another extension) is forbidden; nothing runs', async () => {
    const s = await connRig();
    const spies = [vi.spyOn(s.connections, 'setGitHubToken'), vi.spyOn(s.manager, 'disconnect'), vi.spyOn(s.device, 'start'), vi.spyOn(s.device, 'poll')];
    const reqs = [
      { type: 'connections.list' }, { type: 'connections.github.start' }, { type: 'connections.github.poll' },
      { type: 'connections.setToken', id: 'github', token: PAT }, { type: 'connections.test', id: 'github' },
      { type: 'connections.disconnect', id: 'github' },
    ];
    for (const sender of [content, { id: 'other' }]) {
      for (const req of reqs) expect(await s.handle(req, sender)).toEqual({ ok: false, error: 'forbidden' });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('isRequest: argument shapes', () => {
    expect(isRequest({ type: 'connections.list' })).toBe(true);
    expect(isRequest({ type: 'connections.github.start' })).toBe(true);
    expect(isRequest({ type: 'connections.github.poll' })).toBe(true);
    expect(isRequest({ type: 'connections.setToken', id: 'github', token: 'x' })).toBe(true);
    expect(isRequest({ type: 'connections.setToken', id: 'other', token: 'x' })).toBe(false);
    expect(isRequest({ type: 'connections.setToken', id: 'github' })).toBe(false);
    expect(isRequest({ type: 'connections.setToken', id: 'github', token: 1 })).toBe(false);
    expect(isRequest({ type: 'connections.test', id: 'github' })).toBe(true);
    expect(isRequest({ type: 'connections.test' })).toBe(false);
    expect(isRequest({ type: 'connections.disconnect', id: 'github' })).toBe(true);
    expect(isRequest({ type: 'connections.disconnect', id: 3 })).toBe(false);
    // T7 fix (M3-R55): only the known connection ids.
    expect(isRequest({ type: 'connections.disconnect', id: 'jira' })).toBe(true);
    expect(isRequest({ type: 'connections.test', id: 'jira' })).toBe(true);
    for (const id of ['nope', '', 'GitHub', '../github', '__proto__']) {
      expect(isRequest({ type: 'connections.test', id }), id).toBe(false);
      expect(isRequest({ type: 'connections.disconnect', id }), id).toBe(false);
    }
  });

  it('connections.* without the connections deps fail', async () => {
    const s = setup();
    expect(await s.handle({ type: 'connections.list' }, ui)).toEqual({ ok: false, error: 'connections unavailable' });
  });

  it('connections.github.start: the user code, verification URI, expiry and interval; never the device_code', async () => {
    const s = await connRig();
    const r = await s.handle({ type: 'connections.github.start' }, ui);
    expect(r).toEqual({ ok: true, data: { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: expect.any(Number), interval: 5 } });
    deepScan(r, await all());
  });

  it('connections.github.start: a failed start is an error response', async () => {
    const s = await connRig();
    vi.spyOn(s.device, 'start').mockResolvedValue({ ok: false, error: 'Tabchef needs access to github.com to sign in with GitHub' });
    expect(await s.handle({ type: 'connections.github.start' }, ui)).toEqual({ ok: false, error: 'Tabchef needs access to github.com to sign in with GitHub' });
  });

  it('connections.github.poll: pending, then done stores the connection; no token or device_code in any response', async () => {
    let answer = () => json(200, { error: 'authorization_pending' });
    const s = await connRig({ token: () => answer() });
    await s.handle({ type: 'connections.github.start' }, ui);
    const pending = await s.handle({ type: 'connections.github.poll' }, ui);
    expect(pending).toEqual({ ok: true, data: { state: 'pending', interval: 5 } });
    answer = () => json(200, { access_token: ACCESS, token_type: 'bearer', scope: '' });
    const done = await s.handle({ type: 'connections.github.poll' }, ui);
    expect(done).toEqual({ ok: true, data: { state: 'done' } });
    const list = await s.handle({ type: 'connections.list' }, ui);
    expect(list).toMatchObject({ ok: true, data: { defs: [{ id: 'github', auth: 'device-code', login: 'octo' }], status: [{ state: 'ok' }] } });
    for (const r of [pending, done, list]) deepScan(r, await all());
  });

  it('connections.setToken github: validated and stored via setGitHubToken; the status comes back without the token', async () => {
    const s = await connRig();
    const spy = vi.spyOn(s.connections, 'setGitHubToken');
    const r = await s.handle({ type: 'connections.setToken', id: 'github', token: PAT }, ui);
    expect(spy).toHaveBeenCalledWith(PAT);
    expect(r).toMatchObject({ ok: true, data: { id: 'github', state: 'ok' } });
    expect(await s.secrets.getSecret('github')).toEqual({ token: PAT });
    deepScan(r, await all());
  });

  it('T7 fix (M3-R55): disconnect during a pending device flow cancels it; the next poll stores nothing', async () => {
    const s = await connRig({ token: () => json(200, { access_token: ACCESS, token_type: 'bearer', scope: '' }) });
    expect((await s.handle({ type: 'connections.github.start' }, ui)).ok).toBe(true);
    const out = await s.handle({ type: 'connections.disconnect', id: 'github' }, ui);
    expect(out).toEqual({ ok: true, data: null });
    deepScan(out, await all());
    expect((await browser.storage.session.get('conn.device.github'))['conn.device.github']).toBeUndefined();
    expect(await s.handle({ type: 'connections.github.poll' }, ui)).toEqual({ ok: true, data: { state: 'error', message: 'No GitHub sign-in in progress; start again' } });
    expect(await s.secrets.getSecret('github')).toBeUndefined();
    expect(await s.secrets.getAccess('github')).toBeUndefined();
    expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain(ACCESS);
  });

  it('T7 fix (M3-R55): a short setToken candidate is not a redaction needle (the error text stays readable)', async () => {
    const s = await connRig();
    vi.spyOn(s.connections, 'setGitHubToken').mockResolvedValue({ ok: false, error: 'GitHub rejected this token (401)' });
    expect(await s.handle({ type: 'connections.setToken', id: 'github', token: 'e' }, ui)).toEqual({ ok: false, error: 'GitHub rejected this token (401)' });
    const long = 'abcdefgh';
    vi.spyOn(s.connections, 'setGitHubToken').mockResolvedValue({ ok: false, error: `bad ${long}` });
    expect(await s.handle({ type: 'connections.setToken', id: 'github', token: long }, ui)).toEqual({ ok: false, error: 'bad «redacted»' });
  });

  it('connections.setToken: a rejected token is an error response without the token; jira is not available yet', async () => {
    const s = await connRig({ user: () => json(401, { message: `bad credentials ${PAT}` }) });
    const r = await s.handle({ type: 'connections.setToken', id: 'github', token: PAT }, ui);
    expect(r).toEqual({ ok: false, error: 'GitHub rejected this token (401)' });
    expect(await s.handle({ type: 'connections.setToken', id: 'jira', token: PAT }, ui)).toEqual({ ok: false, error: 'Jira connections are not available yet' });
    expect(await s.secrets.getSecret('jira')).toBeUndefined();
  });

  it('connections.test: GET /user through the manager → the login; a failure is an error response', async () => {
    const s = await connRig();
    await s.handle({ type: 'connections.setToken', id: 'github', token: PAT }, ui);
    const fetchSpy = vi.spyOn(s.manager, 'fetch');
    const tested = await s.handle({ type: 'connections.test', id: 'github' }, ui);
    expect(tested).toEqual({ ok: true, data: { login: 'octo' } });
    deepScan(tested, await all());
    expect(fetchSpy).toHaveBeenCalledWith('github', { method: 'GET', path: '/user' });
    fetchSpy.mockResolvedValueOnce({ ok: false, kind: 'server', status: 502, message: 'GitHub server error (502)' });
    expect(await s.handle({ type: 'connections.test', id: 'github' }, ui)).toEqual({ ok: false, error: 'GitHub server error (502)' });
    // Even a message echoing the stored token comes back redacted.
    fetchSpy.mockResolvedValueOnce({ ok: false, kind: 'server', status: 502, message: `echo ${PAT}` });
    const failed = await s.handle({ type: 'connections.test', id: 'github' }, ui);
    expect(failed.ok).toBe(false);
    deepScan(failed, await all());
    expect(await s.handle({ type: 'connections.test', id: 'jira' }, ui)).toEqual({ ok: false, error: 'Testing jira is not supported' });
    expect(await s.handle({ type: 'connections.test', id: 'nope' }, ui)).toEqual({ ok: false, error: 'unknown request' });
  });

  it('connections.disconnect clears the secrets (SecretStore.clear) and keeps the def as not-configured', async () => {
    const s = await connRig();
    await s.handle({ type: 'connections.setToken', id: 'github', token: PAT }, ui);
    const clear = vi.spyOn(s.secrets, 'clear');
    const out = await s.handle({ type: 'connections.disconnect', id: 'github' }, ui);
    expect(out).toEqual({ ok: true, data: null });
    deepScan(out, await all());
    expect(clear).toHaveBeenCalledWith('github');
    expect(await s.secrets.getSecret('github')).toBeUndefined();
    expect(await s.handle({ type: 'connections.list' }, ui)).toMatchObject({
      ok: true, data: { defs: [{ id: 'github' }], status: [{ id: 'github', state: 'not-configured' }] },
    });
  });
});
