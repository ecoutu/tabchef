// Wiring tests for the service worker entrypoint: browser events and readiness gates reach the right engine calls.
// The engine classes are replaced by recording fakes and `browser` by a recording proxy, so only the wiring is tested.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Fn = (...a: never[]) => unknown;
type Fake = Record<string, ReturnType<typeof vi.fn>> & { args: unknown[] };

const h = vi.hoisted(() => {
  const instances: Record<string, Fake> = {};
  const listeners: Record<string, Fn[]> = {};
  /** `notificationsAbsent`: browser.notifications is undefined, as before the optional permission is granted. */
  const flags = { notificationsAbsent: false };
  // A class whose instances record their constructor args; any method not given in `extra` is an async vi.fn.
  const fake = (name: string, extra: () => object = () => ({})) => class {
    constructor(...args: unknown[]) {
      Object.assign(this, { args }, extra());
      const proxy = new Proxy(this as Record<string | symbol, unknown>, {
        get: (t, p) => (p in t || typeof p === 'symbol' || p === 'then' ? t[p] : (t[p] = vi.fn(async () => undefined))),
      });
      instances[name] = proxy as unknown as Fake;
      return proxy;
    }
  };
  // `browser.a.b.addListener(fn)` records fn under 'a.b'; every other call resolves (special cases in `returns`).
  const returns: Record<string, (...a: never[]) => unknown> = {
    'runtime.getURL': (p: string) => `chrome-extension://ext-id${p}`,
    'storage.session.get': () => Promise.resolve({}),
    'tabs.query': () => Promise.resolve([]),
    'tabs.get': (id: number) => Promise.resolve({ id, url: 'https://a.test/', windowId: 1 }),
    'notifications.getAll': () => Promise.resolve({}),
  };
  const calls: [string, unknown[]][] = [];
  const node = (path: string[]): unknown => new Proxy(() => {}, {
    get: (_t, p) => {
      if (p === 'then' || typeof p === 'symbol') return undefined;
      if (path.join('.') === 'runtime' && p === 'id') return 'ext-id';
      if (path.length === 0 && p === 'notifications' && flags.notificationsAbsent) return undefined;
      if (p === 'addListener') return (fn: Fn) => { (listeners[path.join('.')] ??= []).push(fn); };
      if (p === 'removeListener') return () => {};
      return node([...path, p]);
    },
    apply: (_t, _this, a: never[]) => {
      calls.push([path.join('.'), a]);
      return (returns[path.join('.')] ?? (() => Promise.resolve(undefined)))(...a);
    },
  });
  /** What ProgramCache.get resolves to (the age.tick gate reads it). */
  const state: { program: unknown } = { program: { rules: [] } };
  /** createProjectMenu's result (the project submenu). */
  const projectMenu = { sync: vi.fn<(ps: unknown) => Promise<void>>(async () => {}), install: vi.fn(async () => {}) };
  return { instances, listeners, flags, fake, returns, calls, state, projectMenu, browser: node([]) };
});

vi.mock('wxt/browser', () => ({ browser: h.browser }));
vi.mock('../../src/storage/config-store', () => ({ ConfigStore: h.fake('store') }));
vi.mock('../../src/platform/chrome-port', () => ({
  ChromePort: h.fake('port', () => ({ snapshot: vi.fn(async () => ({ tabs: [], groups: [], windows: [] })) })),
}));
vi.mock('../../src/engine/program-cache', () => ({ ProgramCache: h.fake('programs', () => ({ get: vi.fn(async () => h.state.program) })) }));
vi.mock('../../src/engine/permissions', () => ({ PermissionsManager: h.fake('permissions', () => ({ ready: Promise.resolve() })) }));
vi.mock('../../src/engine/page-facts', () => ({ PageFacts: h.fake('pageFacts', () => ({ ready: Promise.resolve() })) }));
vi.mock('../../src/engine/reconciler', () => ({ Reconciler: h.fake('reconciler') }));
vi.mock('../../src/engine/anchors', () => ({ AnchorService: h.fake('anchors', () => ({ ready: Promise.resolve() })) }));
vi.mock('../../src/engine/dedupe-handler', () => ({ DedupeHandler: h.fake('dedupe', () => ({ ready: Promise.resolve(), inStartupGrace: vi.fn(() => true) })) }));
vi.mock('../../src/engine/tab-ages', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/tab-ages')>()),
  TabAges: h.fake('tabAges', () => ({ ready: Promise.resolve(), annotate: vi.fn(async (s: unknown) => ({ annotated: s })) })),
}));
vi.mock('../../src/engine/safety', () => ({
  SafetyService: h.fake('safety', () => ({ ready: Promise.resolve(), isLocked: vi.fn(() => false) })),
}));
vi.mock('../../src/engine/close-executor', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/close-executor')>()),
  CloseExecutor: h.fake('closeExecutor', () => ({ ready: Promise.resolve() })),
  afterConfigChange: vi.fn(async () => {}),
}));
vi.mock('../../src/engine/ask', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/ask')>()),
  createAskController: vi.fn(() => ({
    ask: vi.fn(), onTabRemoved: vi.fn(async () => {}), handleChoice: vi.fn(async () => {}),
    onNotificationButton: vi.fn(async () => {}), onNotificationClosed: vi.fn(async () => {}), resolvePending: vi.fn(async () => {}),
  })),
}));
vi.mock('../../src/engine/messages', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/messages')>()),
  refreshBadge: vi.fn(async () => {}),
  createHandler: vi.fn(() => vi.fn()),
  createContentHandler: vi.fn(() => vi.fn()),
  createOnMessage: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/engine/context-menu', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/context-menu')>()),
  installMenus: vi.fn(async () => {}),
  refreshMenus: vi.fn(async () => {}),
  onMenuClick: vi.fn(async () => {}),
  createProjectMenu: vi.fn(() => h.projectMenu),
}));
vi.mock('../../src/engine/sources', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/sources')>()),
  SourceService: h.fake('sources', () => ({ ready: Promise.resolve(), factsFor: vi.fn(() => undefined) })),
}));
vi.mock('../../src/engine/projects', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/projects')>()),
  ProjectStore: h.fake('projectStore'),
  ProjectService: h.fake('projects'),
}));
vi.mock('../../src/engine/connections/manager', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/connections/manager')>()),
  ConnectionManager: h.fake('connManager', () => ({ onStatusChange: vi.fn(() => () => {}) })),
}));
vi.mock('../../src/engine/connections/secret-store', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/connections/secret-store')>()),
  SecretStore: h.fake('secrets'),
}));
vi.mock('../../src/engine/connections/rate-limiter', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/connections/rate-limiter')>()),
  RateLimiter: h.fake('limiter'),
}));
vi.mock('../../src/engine/connections/github-auth', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/connections/github-auth')>()),
  GitHubDeviceAuth: h.fake('githubAuth'),
}));
vi.mock('../../src/engine/connections/token-auth', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/connections/token-auth')>()),
  TokenAuth: h.fake('tokenAuth'),
  setGitHubToken: vi.fn(async () => ({ ok: false, error: 'x' })),
}));

const { afterConfigChange } = await import('../../src/engine/close-executor');
const { installMenus, onMenuClick, refreshMenus } = await import('../../src/engine/context-menu');
const { createAskController } = await import('../../src/engine/ask');
const { createContentHandler, createHandler, createOnMessage, refreshBadge } = await import('../../src/engine/messages');
const { setGitHubToken } = await import('../../src/engine/connections/token-auth');
const background = (await import('../../src/entrypoints/background')).default;

/**
 * Listeners by `<event>#<position>` (each main() registers them in the same order): `registered` collects every one
 * a test saw registered, `invoked` every one a test exercised on its own. afterAll checks that each registered
 * listener was exercised. fire() runs every listener of an event but counts as coverage only when the event has
 * exactly one; a listener of an event that has several is covered only by fireAt(event, position), so a second
 * listener on an event that is already tested still needs a test of its own.
 */
const registered = new Set<string>();
const invoked = new Set<string>();
const listenersOf = (event: string) => {
  const fns = h.listeners[event] ?? [];
  expect(fns.length, `no listener on ${event}`).toBeGreaterThan(0);
  return fns as ((...x: unknown[]) => unknown)[];
};
const fire = async (event: string, ...a: unknown[]) => {
  const fns = listenersOf(event);
  if (fns.length === 1) invoked.add(`${event}#0`);
  for (const fn of fns) fn(...a);
  await vi.advanceTimersByTimeAsync(0);
};
/** Runs only the listener at `position` of `event` (registration order in background.ts). */
const fireAt = async (event: string, position: number, ...a: unknown[]) => {
  const fn = listenersOf(event)[position];
  expect(fn, `no listener #${position} on ${event}`).toBeDefined();
  invoked.add(`${event}#${position}`);
  fn!(...a);
  await vi.advanceTimersByTimeAsync(0);
};
/** tabs.onCreated / onRemoved / onUpdated / onReplaced / onAttached: the event's own handler, then the badge recount. */
const TAB = 0;
const BADGE = 1;
/** permissions.onAdded: notifications wiring (an optional permission), then the needs / paused-set sync. */
const WIRE_NOTIFICATIONS = 0;
const SYNC_PERMISSIONS = 1;
/** Tests of this file that ran: when fewer than declared (`-t`, `.only`), the afterAll guard does not apply. */
let ran = 0;
const I = (name: string) => h.instances[name] as Fake;
const ask = () => vi.mocked(createAskController).mock.results[0]!.value as Record<string, ReturnType<typeof vi.fn>>;
const deps = (name: string, i: number) => I(name).args[i] as Record<string, () => Promise<void>>;
/** Whether `p` settles within one macrotask. */
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  return done;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

/** A compiled-Program stand-in: only `rules[].rule.match` is read by the age.tick gate. */
const programWith = (...matches: unknown[]) => ({ rules: matches.map((match, i) => ({ key: `user/r${i}`, rule: { id: `r${i}`, match, actions: [] } })) });
/** A Program with one rule that has a `source` (the only thing that makes sources.refresh requests). */
const withSource = () => ({ rules: [{ key: 'rec/pr', rule: { id: 'pr', match: { url: 'github.com/*' }, actions: [], source: { connection: 'github', query: 'github.pull_request', args: {}, fields: {} } } }] });
const alarmCalls = () => h.calls.filter(([p]) => p.startsWith('alarms.'));
/** Alarm calls about one alarm name. */
const alarmCallsOf = (name: string) => alarmCalls().filter(([, a]) => (a as unknown[])[0] === name);

beforeEach(() => {
  vi.useFakeTimers();
  h.flags.notificationsAbsent = false;
  for (const k of Object.keys(h.listeners)) delete h.listeners[k];
  h.calls.length = 0;
  delete h.returns['alarms.get'];
  h.state.program = programWith();
  vi.clearAllMocks();
  background.main();
});
afterEach(() => {
  for (const [event, fns] of Object.entries(h.listeners)) fns.forEach((_, i) => registered.add(`${event}#${i}`));
  ran++;
  vi.useRealTimers();
});
interface TaskTree { type: string; mode: string; tasks?: readonly TaskTree[] }
/** The tests declared under a suite (vitest's task tree) and not it.todo, whether or not they ran. */
const testsIn = (t: TaskTree): number =>
  (t.tasks ? t.tasks.reduce((n, x) => n + testsIn(x), 0) : t.type === 'suite' || t.mode === 'todo' ? 0 : 1);
/**
 * `it.skip` / `test.skip` declarations in this file. vitest gives a test that a -t / .only filter left out the same
 * 'skip' mode as an explicit skip, so explicit ones are counted in the source: each is one declared test that never
 * runs, and must not switch the guard off. (`it.skip.each` would declare several: not used here.)
 */
const explicitSkips = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/^\s*(?:it|test)\.skip\(/gm)?.length ?? 0;

describe('background wiring', () => {
  it('a config change schedules the reconciler and runs afterConfigChange (needs → close re-evaluation → badge)', async () => {
    const onChange = I('store').onChange!.mock.calls[0]![0] as (c: unknown) => void;
    onChange({ version: 2, rules: [] });
    expect(I('reconciler').schedule).toHaveBeenCalledWith('config');
    expect(afterConfigChange).toHaveBeenCalledTimes(1);
    const [needs, executor] = vi.mocked(afterConfigChange).mock.calls[0]!;
    expect(executor).toBe(I('closeExecutor'));
    I('permissions').onChanged!.mockClear(); // main() synced the permissions at startup
    await (needs as () => Promise<void>)();
    expect(I('permissions').onChanged).toHaveBeenCalledTimes(1);
  });

  it('registers exactly these listeners (per event: a second one needs a test too)', () => {
    expect(Object.fromEntries(Object.entries(h.listeners).map(([e, fns]) => [e, fns.length]))).toEqual({
      'alarms.onAlarm': 1, 'contextMenus.onClicked': 1, 'notifications.onButtonClicked': 1, 'notifications.onClosed': 1,
      'permissions.onAdded': 2, 'permissions.onRemoved': 1, 'runtime.onInstalled': 1, 'runtime.onMessage': 1,
      'runtime.onStartup': 1, 'runtime.onSuspend': 1, 'storage.onChanged': 1, 'tabGroups.onRemoved': 1,
      'tabGroups.onUpdated': 1, 'tabs.onActivated': 1, 'tabs.onAttached': 2, 'tabs.onCreated': 2, 'tabs.onMoved': 1,
      'tabs.onRemoved': 2, 'tabs.onReplaced': 2, 'tabs.onUpdated': 2, 'webNavigation.onCommitted': 1,
      'windows.onCreated': 1, 'windows.onFocusChanged': 1,
    });
  });

  it.each([
    ['tabs.onCreated', [{ id: 3, url: 'https://b.test/', windowId: 1, discarded: false, status: 'loading' }]],
    ['tabs.onRemoved', [5, { isWindowClosing: false, windowId: 1 }]],
    ['tabs.onUpdated', [4, { title: 'C' }, { id: 4, windowId: 1, url: 'https://c.test/', active: false }]],
    ['tabs.onReplaced', [10, 9]],
    ['tabs.onAttached', [1, {}]],
  ] as const)('%s recounts the badge (after the debounce)', async (event, args) => {
    await vi.advanceTimersByTimeAsync(3000); // the startup badge refresh
    vi.mocked(refreshBadge).mockClear();
    await fireAt(event, BADGE, ...args);
    expect(refreshBadge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshBadge).toHaveBeenCalledTimes(1);
  });

  it('notifications granted later: wired once on permissions.onAdded, never twice', async () => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    vi.clearAllMocks();
    h.flags.notificationsAbsent = true;
    background.main();
    expect(h.listeners['notifications.onButtonClicked']).toBeUndefined();
    expect(h.listeners['notifications.onClosed']).toBeUndefined();
    h.flags.notificationsAbsent = false; // the user granted the optional permission
    await fireAt('permissions.onAdded', WIRE_NOTIFICATIONS, { permissions: ['notifications'] });
    expect(h.listeners['notifications.onButtonClicked']).toHaveLength(1);
    expect(h.listeners['notifications.onClosed']).toHaveLength(1);
    await fireAt('permissions.onAdded', WIRE_NOTIFICATIONS, { permissions: ['scripting'] });
    expect(h.listeners['notifications.onButtonClicked']).toHaveLength(1);
    expect(h.listeners['notifications.onClosed']).toHaveLength(1);
    await fire('notifications.onClosed', 'dedupe:5');
    expect(ask().onNotificationClosed).toHaveBeenCalledWith('dedupe:5');
  });

  it.each([['Reconciler', 'reconciler', 2], ['CloseExecutor', 'closeExecutor', 2]])(
    '%s beforeRun waits for permissions.ready (the paused set)', async (_label, name, depsIndex) => {
      const gate = deferred();
      Object.assign(I('permissions'), { ready: gate.promise });
      const run = deps(name, depsIndex).beforeRun!();
      expect(await settled(run)).toBe(false);
      gate.resolve();
      expect(await settled(run)).toBe(true);
    });

  it('DedupeHandler beforeDecide waits for permissions.ready', async () => {
    const gate = deferred();
    Object.assign(I('permissions'), { ready: gate.promise });
    const run = deps('dedupe', 2).beforeDecide!();
    expect(await settled(run)).toBe(false);
    gate.resolve();
    expect(await settled(run)).toBe(true);
  });

  it('a removed tab is cleaned up everywhere, anchors told whether its window is closing', async () => {
    await fireAt('tabs.onRemoved', TAB, 5, { isWindowClosing: true, windowId: 1 });
    expect(I('anchors').onTabRemoved).toHaveBeenCalledWith(5, true);
    expect(I('safety').onTabRemoved).toHaveBeenCalledWith(5, true);
    expect(I('pageFacts').clear).toHaveBeenCalledWith(5);
    expect(I('closeExecutor').onTabRemoved).toHaveBeenCalledWith(5);
    expect(I('dedupe').onRemoved).toHaveBeenCalledWith(5);
    expect(I('tabAges').onRemoved).toHaveBeenCalledWith(5);
    expect(I('reconciler').schedule).toHaveBeenCalledWith('tab-removed');
  });

  it('activating a tab tells the close executor and refreshes the context menu for that tab', async () => {
    await fire('tabs.onActivated', { tabId: 7, windowId: 1 });
    expect(I('closeExecutor').onActivated).toHaveBeenCalledWith(7);
    expect(refreshMenus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 7 }), expect.any(Function));
  });

  it('only top-frame commits reach page facts, dedupe and the close executor', async () => {
    await fire('webNavigation.onCommitted', { frameId: 3, tabId: 2, url: 'https://a.test/frame' });
    expect(I('pageFacts').onCommitted).not.toHaveBeenCalled();
    await fire('webNavigation.onCommitted', { frameId: 0, tabId: 2, url: 'https://a.test/', documentId: 'doc-1' });
    expect(I('pageFacts').onCommitted).toHaveBeenCalledWith(2, 'https://a.test/', 'doc-1');
    expect(I('closeExecutor').evaluate).toHaveBeenCalledWith(2);
  });

  it('a report adopted by its document\'s commit (PageFacts onAdopt) marks form edits and re-plans like an accepted one', () => {
    const onAdopt = (I('pageFacts').args[0] as { onAdopt: (id: number, r: unknown) => void }).onAdopt;
    onAdopt(7, { facts: { texts: [], extracts: {}, formEdited: true }, formEdited: true, url: 'https://a.test/' });
    expect(I('safety').markFormEdited).toHaveBeenCalledWith(7, 'https://a.test/');
    expect(I('reconciler').schedule).toHaveBeenCalledWith('pageFacts');
    expect(I('closeExecutor').onFacts).toHaveBeenCalledWith(7);
  });

  it('ChromePort snapshots go through TabAges.annotate; TabAges reads the dedupe startup grace once it is known', async () => {
    const annotate = I('port').args[2] as (s: unknown) => Promise<unknown>;
    expect(await annotate({ tabs: [] })).toEqual({ annotated: { tabs: [] } });
    expect(I('tabAges').annotate).toHaveBeenCalledWith({ tabs: [] });
    const d = I('tabAges').args[0] as { session: unknown; inStartupGrace: (at: number) => boolean; graceReady: unknown };
    expect(d.inStartupGrace(42)).toBe(true);
    expect(I('dedupe').inStartupGrace).toHaveBeenCalledWith(42);
    expect(d.graceReady).toBe(I('dedupe').ready);
    expect(d.session).toEqual({ get: expect.any(Function), set: expect.any(Function) });
  });

  it('the age.tick alarm re-plans and re-evaluates closes; it does not reach safety', async () => {
    await fire('alarms.onAlarm', { name: 'age.tick' });
    expect(I('reconciler').schedule).toHaveBeenCalledWith('age');
    expect(I('closeExecutor').evaluateAll).toHaveBeenCalled();
    expect(I('safety').onAlarm).not.toHaveBeenCalled();
  });

  it('worker start without age rules clears the age.tick alarm', async () => {
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCalls()).toContainEqual(['alarms.clear', ['age.tick']]);
    expect(alarmCalls().some(([p]) => p === 'alarms.create')).toBe(false);
  });

  it('a config change to a Program with an age rule (nested, under opener) creates age.tick once; without one clears it', async () => {
    await vi.advanceTimersByTimeAsync(0);
    const onChange = I('store').onChange!.mock.calls[0]![0] as (c: unknown) => void;
    h.calls.length = 0;
    h.state.program = programWith({ url: 'a.com/*' }, { all: [{ url: 'b.com/*' }, { opener: { not: { age: { lt: '1h' } } } }] });
    onChange({ version: 2, rules: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('age.tick')).toEqual([['alarms.get', ['age.tick']], ['alarms.create', ['age.tick', { periodInMinutes: 1 }]]]);
    // Already running: left alone, so frequent config changes never postpone its next tick.
    h.calls.length = 0;
    h.returns['alarms.get'] = () => Promise.resolve({ name: 'age.tick', periodInMinutes: 1 });
    onChange({ version: 2, rules: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('age.tick')).toEqual([['alarms.get', ['age.tick']]]);
    h.calls.length = 0;
    h.state.program = programWith({ url: 'a.com/*' });
    onChange({ version: 2, rules: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('age.tick')).toEqual([['alarms.clear', ['age.tick']]]);
  });

  it('a field comparison against {ago} (auto-close-merged mergedAt) also creates age.tick (M3-R92)', async () => {
    await vi.advanceTimersByTimeAsync(0);
    const onChange = I('store').onChange!.mock.calls[0]![0] as (c: unknown) => void;
    h.calls.length = 0;
    h.state.program = programWith({ all: [{ url: 'github.com/*' }, { field: { field: 'source.mergedAt', op: '<', value: { ago: '24h' } } }] });
    onChange({ version: 2, rules: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('age.tick')).toEqual([['alarms.get', ['age.tick']], ['alarms.create', ['age.tick', { periodInMinutes: 1 }]]]);
  });

  it('a paused-set change (the Program changed) re-checks the age.tick alarm', async () => {
    await vi.advanceTimersByTimeAsync(0);
    h.calls.length = 0;
    h.state.program = programWith({ age: { gt: '1d' } });
    const { onPausedChanged } = I('permissions').args[3] as { onPausedChanged: () => void };
    onPausedChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCalls()).toContainEqual(['alarms.create', ['age.tick', { periodInMinutes: 1 }]]);
  });

  it('the sources.refresh alarm refreshes source data in the background; it does not reach safety', async () => {
    await fire('alarms.onAlarm', { name: 'sources.refresh' });
    expect(I('sources').refresh).toHaveBeenCalledWith('alarm');
    expect(I('safety').onAlarm).not.toHaveBeenCalled();
  });

  it('M3-R75: a config change sets the sources.refresh period to the smallest refreshEvery, only when it differs', async () => {
    await vi.advanceTimersByTimeAsync(0);
    const onChange = I('store').onChange!.mock.calls[0]![0] as (c: unknown) => void;
    h.calls.length = 0;
    h.state.program = { ...withSource(), refreshEvery: { a: '10m', b: '2m' } };
    h.returns['alarms.get'] = (name: unknown) => Promise.resolve(name === 'sources.refresh' ? { name, periodInMinutes: 5 } : undefined);
    onChange({ version: 2, rules: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('sources.refresh')).toEqual([['alarms.get', ['sources.refresh']], ['alarms.create', ['sources.refresh', { periodInMinutes: 2 }]]]);
    h.calls.length = 0;
    h.returns['alarms.get'] = (name: unknown) => Promise.resolve(name === 'sources.refresh' ? { name, periodInMinutes: 2 } : undefined);
    onChange({ version: 2, rules: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('sources.refresh')).toEqual([['alarms.get', ['sources.refresh']]]); // unchanged: left alone
  });

  it('install and browser startup create the 5-minute sources.refresh alarm when a rule has a source', async () => {
    h.state.program = withSource();
    for (const ev of ['runtime.onInstalled', 'runtime.onStartup']) {
      h.calls.length = 0;
      await fire(ev, { reason: 'install' });
      expect(alarmCalls()).toContainEqual(['alarms.create', ['sources.refresh', { periodInMinutes: 5 }]]);
    }
  });

  it('M3-R95c: with no source rule, install, startup and config changes clear sources.refresh instead of creating it', async () => {
    const onChange = I('store').onChange!.mock.calls[0]![0] as (c: unknown) => void;
    for (const run of [() => fire('runtime.onInstalled', { reason: 'install' }), () => fire('runtime.onStartup'), async () => { onChange({ version: 2, rules: [] }); await vi.advanceTimersByTimeAsync(0); }]) {
      h.calls.length = 0;
      await run();
      expect(alarmCallsOf('sources.refresh')).toEqual([['alarms.clear', ['sources.refresh']]]);
    }
  });

  it('M3-R95c: a paused-set change re-checks the sources.refresh alarm', async () => {
    await vi.advanceTimersByTimeAsync(0);
    h.calls.length = 0;
    h.state.program = withSource();
    const { onPausedChanged } = I('permissions').args[3] as { onPausedChanged: () => void };
    onPausedChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('sources.refresh')).toContainEqual(['alarms.create', ['sources.refresh', { periodInMinutes: 5 }]]);
    h.calls.length = 0;
    h.state.program = programWith({ url: 'a.com/*' });
    onPausedChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(alarmCallsOf('sources.refresh')).toEqual([['alarms.clear', ['sources.refresh']]]);
  });

  it('changed source data re-plans, re-evaluates closes of the changed tabs and recounts the badge', async () => {
    await vi.advanceTimersByTimeAsync(3000);
    vi.mocked(refreshBadge).mockClear();
    const d = I('sources').args[0] as { onUpdated: (ids: number[]) => void; conn: unknown; limiter: unknown; facts: unknown };
    expect(d.conn).toBe(I('connManager'));
    expect(d.limiter).toBe(I('limiter'));
    expect(d.facts).toBe(I('pageFacts'));
    d.onUpdated([3, 4]);
    expect(I('reconciler').schedule).toHaveBeenCalledWith('sourceUpdated');
    expect(I('closeExecutor').evaluate).toHaveBeenCalledWith(3);
    expect(I('closeExecutor').evaluate).toHaveBeenCalledWith(4);
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshBadge).toHaveBeenCalledTimes(1);
  });

  it('M3 T12: sources take their rules\' levels from the PermissionsManager; it reads connection labels and states', async () => {
    const d = I('sources').args[0] as { levelFor: (k: string) => Promise<unknown> };
    I('permissions').levelFor!.mockResolvedValue('page');
    await expect(d.levelFor('rec/pr')).resolves.toBe('page');
    expect(I('permissions').levelFor).toHaveBeenCalledWith('rec/pr');
    const { connections } = I('permissions').args[3] as { connections: () => Promise<unknown> };
    I('connManager').defs!.mockResolvedValue([{ id: 'github', label: 'GitHub' }]);
    I('connManager').status!.mockResolvedValue([{ id: 'github', state: 'needs-reauth' }, { id: 'jira', state: 'ok' }]);
    await expect(connections()).resolves.toEqual([{ id: 'github', label: 'GitHub', state: 'needs-reauth' }, { id: 'jira', label: 'jira', state: 'ok' }]);
  });

  it('the planner, close rules and read-only views read source facts from the SourceService; runs wait for it', async () => {
    const src = { 'rec/pr': { data: { state: 'open' } } };
    I('sources').factsFor!.mockReturnValue(src);
    I('pageFacts').get!.mockReturnValue(undefined);
    const r = I('reconciler').args[2] as { sources: { factsFor: (id: number, url?: string) => unknown }; beforeRun: () => Promise<void> };
    expect(r.sources.factsFor(3, 'https://x.test/')).toBe(src);
    expect(I('sources').factsFor).toHaveBeenCalledWith(3, 'https://x.test/');
    const c = I('closeExecutor').args[2] as { sources: { factsFor: (id: number, url?: string) => unknown } };
    expect(c.sources.factsFor(4, 'https://y.test/')).toBe(src);
    expect(await settled(r.beforeRun())).toBe(true);
    const views = (vi.mocked(createHandler).mock.calls[0]![0] as unknown as { views: { facts: (id: number, url?: string) => unknown } }).views;
    expect(views.facts(5, 'https://z.test/')).toEqual({ source: src });
    // M3-R95b: the snapshot tab's URL reaches the URL guard (a just-navigated tab gets no previous-page data).
    expect(I('sources').factsFor).toHaveBeenLastCalledWith(5, 'https://z.test/');
  });

  it('a created tab, a URL change and new page facts look up sources (debounced, one refresh)', async () => {
    await fireAt('tabs.onCreated', TAB, { id: 3, url: 'https://b.test/', windowId: 1, discarded: false, status: 'loading' });
    await fireAt('tabs.onUpdated', TAB, 3, { url: 'https://c.test/' }, { id: 3, windowId: 1, url: 'https://c.test/', active: false });
    const onFacts = (vi.mocked(createContentHandler).mock.calls[0]![0] as { onFacts: (id: number) => void }).onFacts;
    onFacts(3);
    expect(I('sources').refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(I('sources').refresh).toHaveBeenCalledTimes(1);
    expect(I('sources').refresh).toHaveBeenCalledWith('tabs');
  });

  it('close alarms go to the close executor, others to safety', async () => {
    await fire('alarms.onAlarm', { name: 'close:4' });
    await fire('alarms.onAlarm', { name: 'resume' });
    expect(I('closeExecutor').onAlarm).toHaveBeenCalledWith('close:4');
    expect(I('safety').onAlarm).toHaveBeenCalledWith({ name: 'resume' });
  });

  it('a created tab is seen by safety and dedupe (its pending URL is a candidate) and re-planned (badge: see below)', async () => {
    await fireAt('tabs.onCreated', TAB, { id: 3, url: '', pendingUrl: 'https://b.test/', windowId: 1, discarded: false, status: 'loading' });
    expect(I('safety').onTabSeen).toHaveBeenCalledWith({ id: 3, url: 'https://b.test/', windowId: 1 });
    expect(I('dedupe').recordCreated).toHaveBeenCalledWith(3, { discarded: false, status: 'loading' });
    expect(I('tabAges').onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 3, discarded: false, status: 'loading' }));
    expect(I('dedupe').onCandidate).toHaveBeenCalledWith(3, 'https://b.test/', 'pending');
    expect(I('reconciler').schedule).toHaveBeenCalledWith('tab-created');
  });

  it('tab updates: a URL change reaches dedupe, safety, the reconciler and the close executor; title and group changes too', async () => {
    const t = { id: 4, windowId: 1, url: 'https://c.test/', active: false };
    await fireAt('tabs.onUpdated', TAB, 4, { url: 'https://c.test/' }, t);
    expect(I('dedupe').onCandidate).toHaveBeenCalledWith(4, 'https://c.test/', 'pending');
    expect(I('safety').onTabSeen).toHaveBeenCalledWith({ id: 4, url: 'https://c.test/', windowId: 1 });
    expect(I('reconciler').onTabUrlChanged).toHaveBeenCalledWith(4, 'https://c.test/');
    expect(I('closeExecutor').evaluate).toHaveBeenCalledWith(4);
    expect(I('reconciler').schedule).toHaveBeenCalledWith('tab-updated');
    await fireAt('tabs.onUpdated', TAB, 4, { title: 'C' }, t);
    expect(I('dedupe').onTitleChanged).toHaveBeenCalledWith(4, 'https://c.test/');
    await fireAt('tabs.onUpdated', TAB, 4, { groupId: 9 }, t);
    expect(I('reconciler').onTabGroupChanged).toHaveBeenCalledWith(4, 9, 'https://c.test/');
  });

  it.each([['tabs.onMoved', 'tab-moved'], ['tabs.onAttached', 'tab-attached']])('%s re-plans the tab order (%s)', async (event, reason) => {
    await fireAt(event, TAB, 1, {});
    expect(I('reconciler').onTabMovedOrAttached).toHaveBeenCalled();
    expect(I('reconciler').schedule).toHaveBeenCalledWith(reason);
  });

  it('a replaced tab hands its state to the new tab id', async () => {
    await fireAt('tabs.onReplaced', TAB, 10, 9);
    expect(I('pageFacts').clear).toHaveBeenCalledWith(9);
    expect(I('closeExecutor').onTabRemoved).toHaveBeenCalledWith(9);
    expect(I('dedupe').onReplaced).toHaveBeenCalledWith(10, 9);
    expect(I('tabAges').onReplaced).toHaveBeenCalledWith(10, 9);
    expect(I('anchors').onTabReplaced).toHaveBeenCalledWith(10, 9);
    expect(I('projects').onReplaced).toHaveBeenCalledWith(10, 9);
  });

  it('M3 T15: the ProjectService feeds the planner, handles projects.* and the project menu items', async () => {
    const d = I('projects').args[0] as Record<string, unknown> & { state: () => unknown; schedule: (r: string) => void; onProjectsChanged: (ps: unknown) => void };
    expect(d.store).toBe(I('projectStore'));
    expect(I('projectStore').args[0]).toBeDefined(); // storage.local
    expect(d.sources).toBe(I('sources'));
    expect(d.facts).toBe(I('pageFacts'));
    expect(d.safety).toBe(I('safety'));
    d.state();
    expect(I('reconciler').liveState).toHaveBeenCalled();
    d.schedule('project');
    expect(I('reconciler').schedule).toHaveBeenCalledWith('project');
    d.onProjectsChanged([{ id: 'r:ABC-1', title: 'ABC-1' }]);
    expect(h.projectMenu.sync).toHaveBeenCalledWith([{ id: 'r:ABC-1', title: 'ABC-1' }]);
    const r = I('reconciler').args[2] as { projects: { targets: (s: unknown) => Promise<unknown>; previewTargets: (s: unknown, p: unknown) => Promise<unknown> } };
    const snap = { tabs: [], groups: [], windows: [] };
    await r.projects.targets(snap);
    expect(I('projects').targets).toHaveBeenCalledWith(snap);
    await r.projects.previewTargets(snap, h.state.program);
    expect(I('projects').previewTargets).toHaveBeenCalledWith(snap, h.state.program);
    const hd = vi.mocked(createHandler).mock.calls[0]![0] as unknown as { projects: unknown; preview: { projectOverrides: (s: unknown, p: unknown) => Promise<unknown> } };
    expect(hd.projects).toBe(I('projects'));
    expect((vi.mocked(createHandler).mock.calls[0]![0] as unknown as { sources: unknown }).sources).toBe(I('sources')); // sources.refresh (T17)
    await hd.preview.projectOverrides(snap, h.state.program); // previews plan each side with its own overrides (N1)
    expect(I('reconciler').previewOverrides).toHaveBeenCalledWith(snap, h.state.program);
    expect(d.session).toEqual({ get: expect.any(Function), set: expect.any(Function) }); // the closed-time clock (N2)
    // M3-R84: Close group offers M1's group undo; an undo revives the closed project before recreating the tab.
    (d as unknown as { toast: (ids: string[], text: string, f: unknown) => void }).toast(['rc1', 'rc2'], 'Closed 2 tabs', undefined);
    expect(I('safety').toastGroup).toHaveBeenCalledWith(['rc1', 'rc2'], 'Closed 2 tabs', undefined);
    await (I('safety').args[1] as { beforeUndo: (id: string) => Promise<void> }).beforeUndo('rc1');
    expect(I('projects').onUndo).toHaveBeenCalledWith('rc1');
    await fire('contextMenus.onClicked', { menuItemId: 'tc-project:r:ABC-1' }, { id: 8 });
    expect(onMenuClick).toHaveBeenCalledWith({ menuItemId: 'tc-project:r:ABC-1' }, { id: 8 }, expect.objectContaining({ projects: I('projects') }));
  });

  it('group and window events re-plan; a removed group drops its anchors', async () => {
    await fire('tabGroups.onUpdated', { id: 2, windowId: 1, title: 'API' });
    expect(I('anchors').onGroupUpdated).toHaveBeenCalledWith({ id: 2, windowId: 1, title: 'API' });
    expect(I('reconciler').schedule).toHaveBeenCalledWith('group-updated');
    await fire('tabGroups.onRemoved', { id: 2 });
    expect(I('anchors').onGroupRemoved).toHaveBeenCalledWith({ id: 2 });
    expect(I('reconciler').schedule).toHaveBeenCalledWith('group-removed');
    await fire('windows.onCreated', { id: 3 });
    expect(I('reconciler').schedule).toHaveBeenCalledWith('window-created');
  });

  it('a window focus change refreshes the menu for the active tab', async () => {
    await fire('windows.onFocusChanged', 1);
    expect(refreshMenus).toHaveBeenCalledWith(expect.anything(), undefined, expect.any(Function)); // tabs.query found none
  });

  it('browser startup opens the dedupe grace, re-plans and re-evaluates every tab for closes', async () => {
    await fire('runtime.onStartup');
    expect(I('dedupe').noteStartup).toHaveBeenCalled();
    expect(I('reconciler').schedule).toHaveBeenCalledWith('startup');
    expect(I('closeExecutor').evaluateAll).toHaveBeenCalled();
  });

  it('suspend flushes the pending config write', async () => {
    await fire('runtime.onSuspend');
    expect(I('store').flush).toHaveBeenCalled();
  });

  it('install re-plans and installs the context menu (through the project menu queue, M3-R71)', async () => {
    await fire('runtime.onInstalled', { reason: 'install' });
    expect(I('reconciler').schedule).toHaveBeenCalledWith('installed');
    expect(h.projectMenu.install).toHaveBeenCalled();
    expect(installMenus).not.toHaveBeenCalled(); // never outside the queue
  });

  it('a stored change to close suggestions recounts the badge; other areas do not', async () => {
    await vi.advanceTimersByTimeAsync(3000);
    vi.mocked(refreshBadge).mockClear();
    await fire('storage.onChanged', { other: {} }, 'session');
    await fire('storage.onChanged', { closeSuggestions: {} }, 'local');
    await vi.advanceTimersByTimeAsync(3000);
    expect(refreshBadge).not.toHaveBeenCalled();
    await fire('storage.onChanged', { closeSuggestions: {} }, 'session');
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshBadge).toHaveBeenCalledTimes(1);
  });

  it('runtime messages go to createOnMessage; banner choices reach the ask controller and undo reaches safety', async () => {
    const listener = vi.mocked(createOnMessage).mock.results[0]!.value;
    expect(h.listeners['runtime.onMessage']).toContain(listener);
    await fire('runtime.onMessage', { type: 'x' }, {});
    const { handleBanner } = vi.mocked(createOnMessage).mock.calls[0]![0];
    const sender = { tab: { id: 6 } };
    expect(handleBanner({ type: 'banner.choice', choice: 'switch', tabId: 6, existingTabId: 2 }, sender)).toBe(true);
    expect(ask().handleChoice).toHaveBeenCalledWith(6, 2, 'switch');
    expect(handleBanner({ type: 'banner.choice', choice: 'undo', entryId: 'e1' }, sender)).toBe(true);
    expect(I('safety').undo).toHaveBeenCalledWith('e1');
    expect(handleBanner({ type: 'other' }, sender)).toBe(false);
  });

  it('notification buttons: undo toasts go to safety, dedupe asks to the ask controller; closes too', async () => {
    await fire('notifications.onButtonClicked', 'undo:e2', 0);
    expect(I('safety').undo).toHaveBeenCalledWith('e2');
    await fire('notifications.onButtonClicked', 'dedupe:5', 1);
    expect(ask().onNotificationButton).toHaveBeenCalledWith('dedupe:5', 1);
    await fire('notifications.onClosed', 'dedupe:5');
    expect(ask().onNotificationClosed).toHaveBeenCalledWith('dedupe:5');
  });

  it('permission grants and revocations re-sync the needs, paused set and watch registration', async () => {
    I('permissions').onChanged!.mockClear();
    await fireAt('permissions.onAdded', SYNC_PERMISSIONS, { permissions: ['scripting'] });
    await fire('permissions.onRemoved', { origins: ['https://a.test/*'] });
    expect(I('permissions').onChanged).toHaveBeenCalledTimes(2);
  });

  it('host grants and revocations re-emit every connection status (revoked api host → not-configured)', async () => {
    I('connManager').permissionsChanged!.mockClear();
    await fireAt('permissions.onAdded', SYNC_PERMISSIONS, { origins: ['https://api.github.com/*'] });
    await fire('permissions.onRemoved', { origins: ['https://api.github.com/*'] });
    expect(I('connManager').permissionsChanged).toHaveBeenCalledTimes(2);
  });

  it('a context menu click waits for safety, then runs onMenuClick for the tab', async () => {
    await fire('contextMenus.onClicked', { menuItemId: 'tc-lock' }, { id: 8 });
    expect(onMenuClick).toHaveBeenCalledWith({ menuItemId: 'tc-lock' }, { id: 8 }, expect.objectContaining({ openPage: expect.any(Function) }));
  });

  describe('connections (M3 T7)', () => {
    const mgrDeps = () => I('connManager').args[0] as Record<string, unknown>;
    const handlerConnections = () => (vi.mocked(createHandler).mock.calls[0]![0] as unknown as { connections: Record<string, (...a: unknown[]) => unknown> }).connections;

    it('one ConnectionManager over the shared secret store, limiter, port and fetch; auth map device-code → GitHubDeviceAuth, token → TokenAuth', () => {
      const d = mgrDeps();
      expect(d.secrets).toBe(I('secrets'));
      expect(d.limiter).toBe(I('limiter'));
      expect(d.port).toBe(I('port'));
      expect(typeof d.fetch).toBe('function');
      expect(d.log).toBeDefined();
      const auth = d.auth as Record<string, unknown>;
      expect(auth['device-code']).toBe(I('githubAuth'));
      expect(auth.token).toBe(I('tokenAuth'));
      // The device-flow provider gets the same secret store, port and fetch, and the manager through its lazy getter.
      const g = I('githubAuth').args[0] as Record<string, unknown>;
      expect(g.secrets).toBe(I('secrets'));
      expect(g.port).toBe(I('port'));
      expect(g.fetch).toBe(d.fetch);
      expect((g.manager as () => unknown)()).toBe(I('connManager'));
    });

    it('M3-R95d: worker start restricts storage.local to trusted contexts (SecretStore.init) once, before any write', () => {
      expect(I('secrets').init).toHaveBeenCalledTimes(1);
      expect(I('secrets').setSecret).not.toHaveBeenCalled();
    });

    it('M3-R35: a production build (no WXT_E2E_LOCALHOST) has allowLocalhost false', () => {
      expect(mgrDeps().allowLocalhost).toBe(false);
    });

    it('M3-R35: the e2e build flag WXT_E2E_LOCALHOST=1 turns allowLocalhost on', () => {
      vi.stubEnv('WXT_E2E_LOCALHOST', '1');
      try {
        for (const k of Object.keys(h.listeners)) delete h.listeners[k];
        background.main();
        expect(mgrDeps().allowLocalhost).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('createHandler gets the connections deps; setToken uses setGitHubToken with the shared instances', async () => {
      const c = handlerConnections();
      expect(c.manager).toBe(I('connManager'));
      expect(c.github).toBe(I('githubAuth'));
      await c.setGitHubToken!('tok');
      expect(setGitHubToken).toHaveBeenCalledWith({ manager: I('connManager'), secrets: I('secrets'), port: I('port'), fetch: mgrDeps().fetch, allowLocalhost: false }, 'tok');
      await c.knownSecrets!();
      expect(I('secrets').knownSecrets).toHaveBeenCalled();
    });

    it('a status change broadcasts connections.changed (id only) to extension pages; "no receiver" is expected', async () => {
      const cb = I('connManager').onStatusChange!.mock.calls[0]![0] as (s: unknown) => void;
      h.returns['runtime.sendMessage'] = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      try {
        cb({ id: 'github', state: 'ok', lastError: 'x', ssoRequired: [], scopes: [] });
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        delete h.returns['runtime.sendMessage'];
      }
      expect(h.calls.filter(([p]) => p === 'runtime.sendMessage').map(([, a]) => a[0])).toEqual([{ type: 'connections.changed', id: 'github' }]);
    });

    it('M3 T12: a status change re-syncs the permissions (capability levels; a pause change recompiles)', async () => {
      const cb = I('connManager').onStatusChange!.mock.calls[0]![0] as (s: unknown) => void;
      I('permissions').onChanged!.mockClear();
      cb({ id: 'github', state: 'needs-reauth', ssoRequired: [], scopes: [] });
      expect(I('permissions').onChanged).toHaveBeenCalledTimes(1);
    });
  });

  afterAll(({}, suite) => {
    // A listener added to background.ts without a test here fails this suite; not when a filter (-t, .only) left
    // tests out. it.todo and it.skip declarations are not left-out tests.
    if (ran < testsIn(suite) - explicitSkips) return;
    expect([...registered].filter((k) => !invoked.has(k)).sort()).toEqual([]);
  });
});
