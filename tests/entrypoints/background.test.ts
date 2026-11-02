// Wiring tests for the service worker entrypoint: browser events and readiness gates reach the right engine calls.
// The engine classes are replaced by recording fakes and `browser` by a recording proxy, so only the wiring is tested.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Fn = (...a: never[]) => unknown;
type Fake = Record<string, ReturnType<typeof vi.fn>> & { args: unknown[] };

const h = vi.hoisted(() => {
  const instances: Record<string, Fake> = {};
  const listeners: Record<string, Fn[]> = {};
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
  const node = (path: string[]): unknown => new Proxy(() => {}, {
    get: (_t, p) => {
      if (p === 'then' || typeof p === 'symbol') return undefined;
      if (path.join('.') === 'runtime' && p === 'id') return 'ext-id';
      if (p === 'addListener') return (fn: Fn) => { (listeners[path.join('.')] ??= []).push(fn); };
      if (p === 'removeListener') return () => {};
      return node([...path, p]);
    },
    apply: (_t, _this, a: never[]) => (returns[path.join('.')] ?? (() => Promise.resolve(undefined)))(...a),
  });
  return { instances, listeners, fake, browser: node([]) };
});

vi.mock('wxt/browser', () => ({ browser: h.browser }));
vi.mock('../../src/storage/config-store', () => ({ ConfigStore: h.fake('store') }));
vi.mock('../../src/platform/chrome-port', () => ({
  ChromePort: h.fake('port', () => ({ snapshot: vi.fn(async () => ({ tabs: [], groups: [], windows: [] })) })),
}));
vi.mock('../../src/engine/program-cache', () => ({ ProgramCache: h.fake('programs') }));
vi.mock('../../src/engine/permissions', () => ({ PermissionsManager: h.fake('permissions', () => ({ ready: Promise.resolve() })) }));
vi.mock('../../src/engine/page-facts', () => ({ PageFacts: h.fake('pageFacts', () => ({ ready: Promise.resolve() })) }));
vi.mock('../../src/engine/reconciler', () => ({ Reconciler: h.fake('reconciler') }));
vi.mock('../../src/engine/anchors', () => ({ AnchorService: h.fake('anchors', () => ({ ready: Promise.resolve() })) }));
vi.mock('../../src/engine/dedupe-handler', () => ({ DedupeHandler: h.fake('dedupe') }));
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
  createAskController: vi.fn(() => ({ ask: vi.fn(), onTabRemoved: vi.fn(async () => {}) })),
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
}));

const { afterConfigChange } = await import('../../src/engine/close-executor');
const { refreshMenus } = await import('../../src/engine/context-menu');
const background = (await import('../../src/entrypoints/background')).default;

const fire = async (event: string, ...a: unknown[]) => {
  const fns = h.listeners[event] ?? [];
  expect(fns.length, `no listener on ${event}`).toBeGreaterThan(0);
  for (const fn of fns) (fn as (...x: unknown[]) => unknown)(...a);
  await vi.advanceTimersByTimeAsync(0);
};
const I = (name: string) => h.instances[name] as Fake;
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

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(h.listeners)) delete h.listeners[k];
  vi.clearAllMocks();
  background.main();
});
afterEach(() => { vi.useRealTimers(); });

describe('background wiring', () => {
  it('a config change schedules the reconciler and runs afterConfigChange (needs → close re-evaluation → badge)', async () => {
    const onChange = I('store').onChange!.mock.calls[0]![0] as (c: unknown) => void;
    onChange({ version: 2, rules: [] });
    expect(I('reconciler').schedule).toHaveBeenCalledWith('config');
    expect(afterConfigChange).toHaveBeenCalledTimes(1);
    const [needs, executor] = vi.mocked(afterConfigChange).mock.calls[0]!;
    expect(executor).toBe(I('closeExecutor'));
    await (needs as () => Promise<void>)();
    expect(I('permissions').onChanged).toHaveBeenCalled();
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
    await fire('tabs.onRemoved', 5, { isWindowClosing: true, windowId: 1 });
    expect(I('anchors').onTabRemoved).toHaveBeenCalledWith(5, true);
    expect(I('safety').onTabRemoved).toHaveBeenCalledWith(5, true);
    expect(I('pageFacts').clear).toHaveBeenCalledWith(5);
    expect(I('closeExecutor').onTabRemoved).toHaveBeenCalledWith(5);
    expect(I('dedupe').onRemoved).toHaveBeenCalledWith(5);
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

  it('close alarms go to the close executor, others to safety', async () => {
    await fire('alarms.onAlarm', { name: 'close:4' });
    await fire('alarms.onAlarm', { name: 'resume' });
    expect(I('closeExecutor').onAlarm).toHaveBeenCalledWith('close:4');
    expect(I('safety').onAlarm).toHaveBeenCalledWith({ name: 'resume' });
  });
});
