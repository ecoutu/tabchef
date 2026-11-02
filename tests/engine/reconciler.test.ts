import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { Reconciler } from '../../src/engine/reconciler';
import type { RuntimeState } from '../../src/engine/state';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, GroupColor, GroupRule, TabSnap } from '../../src/core/types';
import { withGroupRules, programOf } from '../helpers/config';
import { builtinRecipes } from '../../src/recipes/load';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;

const A = 'https://a.com/x';
const B = 'https://b.com/x';
const OTHER = 'https://other.com/';
const DRAG = 'Tabs cannot be edited right now (user may be dragging a tab).';
const MUTATING = new Set(['group', 'ungroup', 'moveTabs', 'moveGroup', 'updateGroup', 'closeTab', 'createTab', 'focusTab']);

const rule = (id: string, url: string, title: string, color: GroupColor): GroupRule => ({
  id, name: id, enabled: true, match: { url }, group: { title, color },
});
const config: Config = withGroupRules([rule('a', 'https://a.com/**', 'A', 'red'), rule('b', 'https://b.com/**', 'B', 'blue')]);
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});
const world = (windows: number[] = [1]): FakeBrowserPort => {
  const f = new FakeBrowserPort();
  for (const w of windows) f.addWindow(w);
  return f;
};
const order = (f: FakeBrowserPort, w = 1): number[] => {
  f.assertInvariants();
  return f.state.tabs.filter((t) => t.windowId === w).sort((a, b) => a.index - b.index).map((t) => t.id);
};
const groupTitles = (f: FakeBrowserPort, w = 1): string[] => {
  const ids: number[] = [];
  for (const t of f.state.tabs.filter((x) => x.windowId === w).sort((a, b) => a.index - b.index)) {
    if (t.groupId !== -1 && ids[ids.length - 1] !== t.groupId) ids.push(t.groupId);
  }
  return ids.map((id) => f.state.groups.find((g) => g.id === id)!.title);
};
const groupOf = (f: FakeBrowserPort, tabId: number): string | undefined => {
  const gid = f.state.tabs.find((t) => t.id === tabId)!.groupId;
  return f.state.groups.find((g) => g.id === gid)?.title;
};
const mutations = (f: FakeBrowserPort) => f.calls.filter((c) => MUTATING.has(c.method));
const count = (f: FakeBrowserPort, m: string) => f.calls.filter((c) => c.method === m).length;
const setUrl = (f: FakeBrowserPort, id: number, url: string) => { f.state.tabs.find((t) => t.id === id)!.url = url; };

/** Mimic Chrome: fire tabs.onUpdated(groupId) for every tab whose group changes during a port call. */
function emitGroupEvents(f: FakeBrowserPort, r: Reconciler): void {
  for (const m of ['group', 'ungroup', 'moveTabs'] as const) {
    const orig = f[m].bind(f) as (...a: unknown[]) => Promise<unknown>;
    (f as unknown as Record<string, unknown>)[m] = async (...args: unknown[]) => {
      const before = new Map(f.state.tabs.map((t) => [t.id, t.groupId]));
      const res = await orig(...args);
      for (const t of f.state.tabs) if (before.get(t.id) !== t.groupId) void r.onTabGroupChanged(t.id, t.groupId);
      return res;
    };
  }
}

describe('Reconciler', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('awaits beforeRun before checking pause (pause state loaded late)', async () => {
    const f = world();
    f.addTab(tab(1, A));
    let paused = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = () => { paused = true; r(); }; });
    const r = new Reconciler(f, async () => programOf(config), { isPaused: () => paused, beforeRun: () => gate });
    const p = r.flush();
    release();
    await p;
    expect(count(f, 'snapshot')).toBe(0);
  });

  it('debounces: 5 schedule calls within 100 ms → a single snapshot', async () => {
    const f = world();
    f.addTab(tab(1, OTHER));
    const r = new Reconciler(f, async () => programOf(config));
    for (let i = 0; i < 5; i++) {
      r.schedule('test');
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(count(f, 'snapshot')).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(count(f, 'snapshot')).toBe(1);
  });

  it('flush orders groups per config and sets title/color; second flush is idempotent', async () => {
    const f = world();
    f.addTab(tab(1, B));
    f.addTab(tab(2, OTHER));
    f.addTab(tab(3, A));
    f.addTab(tab(4, B));
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    expect(groupTitles(f)).toEqual(['A', 'B']);
    expect(f.state.groups.find((g) => g.title === 'A')!.color).toBe('red');
    expect(f.state.groups.find((g) => g.title === 'B')!.color).toBe('blue');
    expect(order(f).at(-1)).toBe(2);
    f.calls = [];
    await r.flush();
    expect(mutations(f)).toEqual([]);
  });

  it('end-to-end: reverse-order tabs across 2 windows → config order in both; second flush zero mutations', async () => {
    const f = world([1, 2]);
    f.addTab(tab(1, B));
    f.addTab(tab(2, A));
    f.addTab(tab(3, B));
    f.addTab(tab(4, A));
    f.addTab(tab(10, OTHER, { windowId: 2 }));
    f.addTab(tab(11, B, { windowId: 2 }));
    f.addTab(tab(12, A, { windowId: 2 }));
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    expect(groupTitles(f, 1)).toEqual(['A', 'B']);
    expect(groupTitles(f, 2)).toEqual(['A', 'B']);
    expect(order(f, 2)).toEqual([12, 11, 10]);
    f.assertInvariants();
    f.calls = [];
    await r.flush();
    expect(mutations(f)).toEqual([]);
  });

  it('user ungroup is left alone until the URL changes', async () => {
    const f = world();
    f.addTab(tab(1, A));
    f.addTab(tab(2, A));
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    expect(groupOf(f, 1)).toBe('A');
    // User drags tab 1 out of the group (not through the reconciler).
    f.state.tabs.find((t) => t.id === 1)!.groupId = -1;
    await r.onTabGroupChanged(1, -1);
    await r.flush();
    await r.flush();
    expect(groupOf(f, 1)).toBeUndefined();
    await r.onTabUrlChanged(1);
    await r.flush();
    expect(groupOf(f, 1)).toBe('A');
  });

  it('ungrouping done by Tabchef itself is not treated as a user drag', async () => {
    const f = world();
    f.addTab(tab(1, A));
    f.addTab(tab(2, A));
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    setUrl(f, 1, OTHER); // strict rule → Tabchef ungroups it (no onTabUrlChanged, to isolate the expectation path)
    await r.flush();
    expect(count(f, 'ungroup')).toBe(1);
    expect(groupOf(f, 1)).toBeUndefined();
    setUrl(f, 1, A);
    await r.flush();
    expect(groupOf(f, 1)).toBe('A');
  });

  it('drag retry exhaustion → re-schedules on the next onMoved/onAttached, then order is correct', async () => {
    const f = world();
    f.addTab(tab(1, B, { groupId: 50 }));
    f.addTab(tab(2, A, { groupId: 60 }));
    f.addGroup({ id: 50, windowId: 1, title: 'B', color: 'blue', collapsed: false });
    f.addGroup({ id: 60, windowId: 1, title: 'A', color: 'red', collapsed: false });
    f.failNext('moveGroup', DRAG, 99);
    const log = { add: vi.fn() };
    const r = new Reconciler(f, async () => programOf(config), { log });
    r.schedule('test');
    await vi.advanceTimersByTimeAsync(150 + 250 + 500 + 1000 + 2000 + 10);
    expect(count(f, 'moveGroup')).toBe(5);
    expect(log.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'drag-retry-exhausted' }));
    expect(groupTitles(f)).toEqual(['B', 'A']);
    f.clearFailures();
    r.onTabMovedOrAttached();
    await vi.advanceTimersByTimeAsync(200);
    expect(groupTitles(f)).toEqual(['A', 'B']);
    f.calls = [];
    await vi.advanceTimersByTimeAsync(10_000); // fallback timer was cancelled
    expect(count(f, 'snapshot')).toBe(0);
  });

  it('drag retry exhaustion → 5 s fallback timer schedules once when no event arrives', async () => {
    const f = world();
    f.addTab(tab(1, B, { groupId: 50 }));
    f.addTab(tab(2, A, { groupId: 60 }));
    f.addGroup({ id: 50, windowId: 1, title: 'B', color: 'blue', collapsed: false });
    f.addGroup({ id: 60, windowId: 1, title: 'A', color: 'red', collapsed: false });
    f.failNext('moveGroup', DRAG, 5);
    const r = new Reconciler(f, async () => programOf(config));
    const p = r.flush();
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000 + 10);
    await expect(p).resolves.toBeUndefined(); // flush never rejects on drag exhaustion
    expect(groupTitles(f)).toEqual(['B', 'A']);
    expect(count(f, 'moveGroup')).toBe(5);
    f.calls = [];
    // no failures left: the fallback (5 s + debounce) fixes it
    await vi.advanceTimersByTimeAsync(5000 + 150 + 10);
    expect(groupTitles(f)).toEqual(['A', 'B']);
    const snaps = count(f, 'snapshot');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count(f, 'snapshot')).toBe(snaps);
  });

  it('paused → zero mutating calls', async () => {
    const f = world();
    f.addTab(tab(1, B));
    f.addTab(tab(2, A));
    const r = new Reconciler(f, async () => programOf(config), { isPaused: () => true });
    await r.flush();
    r.schedule('x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mutations(f)).toEqual([]);
  });

  it('never runs flush concurrently; schedule during a flush queues exactly one more', async () => {
    const f = world();
    f.addTab(tab(1, A));
    let inFlight = 0;
    let maxInFlight = 0;
    const getConfig = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 1000));
      inFlight--;
      return programOf(config);
    });
    const r = new Reconciler(f, getConfig);
    const p = r.flush();
    await vi.advanceTimersByTimeAsync(10);
    r.schedule('a');
    r.schedule('b');
    await vi.advanceTimersByTimeAsync(200); // debounce fires mid-flush
    void r.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(maxInFlight).toBe(1);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('persists runtime state to storage.session "rt" and reloads it after a restart', async () => {
    const f = world();
    f.addTab(tab(1, A));
    f.addTab(tab(2, B));
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    f.state.tabs.find((t) => t.id === 1)!.groupId = -1;
    f.state.groups = f.state.groups.filter((g) => g.title !== 'A');
    await r.onTabGroupChanged(1, -1);
    const { rt } = (await browser.storage.session.get('rt')) as { rt: RuntimeState };
    expect(rt).toMatchObject({ leaveAlone: [1], expectedGroupChanges: [] });
    expect([...rt.managedTitles].sort()).toEqual(['A', 'B']);
    expect(rt.creationOrder).toEqual([['1|A', 1], ['1|B', 2]]);
    // service worker restart: new instance, same storage
    const r2 = new Reconciler(f, async () => programOf(config));
    f.calls = [];
    await r2.flush();
    expect(f.calls.filter((c) => c.method === 'group')).toEqual([]); // only a moveGroup (B left of the loose tab)
    expect(groupOf(f, 1)).toBeUndefined();
  });

  it('detects a drag-out after a service-worker restart (managed-tab membership is persisted)', async () => {
    const f = world();
    f.addTab(tab(1, A));
    f.addTab(tab(2, A));
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    expect(groupOf(f, 1)).toBe('A');
    // Worker idles out; the drag event wakes a fresh instance before any flush.
    const r2 = new Reconciler(f, async () => programOf(config));
    f.state.tabs.find((t) => t.id === 1)!.groupId = -1;
    await r2.onTabGroupChanged(1, -1);
    const { rt } = (await browser.storage.session.get('rt')) as { rt: RuntimeState };
    expect(rt.leaveAlone).toEqual([1]);
    await r2.flush();
    expect(groupOf(f, 1)).toBeUndefined();
    expect(f.calls.filter((c) => c.method === 'group' && (c.args[0] as number[]).includes(1))).toHaveLength(1);
  });

  describe('expectations expire after 2 s', () => {
    const merged = (): { f: FakeBrowserPort; r: Reconciler } => {
      const f = world([1, 2]);
      const merge: Config = withGroupRules([{ ...rule('a', 'https://a.com/**', 'A', 'red'), merge: true }]);
      f.addTab(tab(1, A, { groupId: 70 }));
      f.addGroup({ id: 70, windowId: 1, title: 'A', color: 'red', collapsed: false });
      f.addTab(tab(2, A, { windowId: 2 }));
      return { f, r: new Reconciler(f, async () => programOf(merge)) };
    };
    const leaveAlone = async () => ((await browser.storage.session.get('rt')) as { rt: RuntimeState }).rt.leaveAlone;

    it('a late groupId=-1 event for a Tabchef move within 2 s is ignored', async () => {
      const { f, r } = merged();
      await r.flush(); // moveTabs + regroup of tab 2; events not delivered yet
      expect(groupOf(f, 2)).toBe('A');
      await vi.advanceTimersByTimeAsync(1500);
      await r.onTabGroupChanged(2, -1);
      expect(await leaveAlone()).toEqual([]);
    });

    it('the same event after 2 s is treated as a user drag', async () => {
      const { r } = merged();
      await r.flush();
      await vi.advanceTimersByTimeAsync(2001);
      await r.onTabGroupChanged(2, -1);
      expect(await leaveAlone()).toEqual([2]);
    });
  });

  it('logs reconcile-not-converged when ops remain after 3 passes', async () => {
    const f = world();
    f.addTab(tab(1, B, { groupId: 50 }));
    f.addTab(tab(2, A, { groupId: 60 }));
    f.addGroup({ id: 50, windowId: 1, title: 'B', color: 'blue', collapsed: false });
    f.addGroup({ id: 60, windowId: 1, title: 'A', color: 'red', collapsed: false });
    f.moveGroup = async () => {}; // the browser ignores the move: the planner can never converge
    const log = { add: vi.fn() };
    const r = new Reconciler(f, async () => programOf(config), { log });
    await r.flush();
    expect(log.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'reconcile-not-converged', detail: expect.stringContaining('1 op') }));
  });

  it('applies merge moveTabs by moving then regrouping into the home group', async () => {
    const f = world([1, 2]);
    const merge: Config = withGroupRules([{ ...rule('a', 'https://a.com/**', 'A', 'red'), merge: true }]);
    f.addTab(tab(1, A, { groupId: 70 }));
    f.addGroup({ id: 70, windowId: 1, title: 'A', color: 'red', collapsed: false });
    f.addTab(tab(2, A, { windowId: 2 }));
    const r = new Reconciler(f, async () => programOf(merge));
    emitGroupEvents(f, r);
    await r.flush();
    expect(order(f, 1)).toEqual([1, 2]);
    expect(groupOf(f, 2)).toBe('A');
    f.calls = [];
    await r.flush();
    expect(mutations(f)).toEqual([]);
  });

  it('logs and swallows non-drag errors', async () => {
    const f = world();
    f.addTab(tab(1, A));
    f.failNext('group', 'No tab with id: 1');
    const log = { add: vi.fn() };
    const r = new Reconciler(f, async () => programOf(config), { log });
    await expect(r.flush()).resolves.toBeUndefined();
    expect(log.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'reconcile-error' }));
    await r.flush();
    expect(groupOf(f, 1)).toBe('A');
  });
  describe('restored groups without Tabchef state (I2, I3)', () => {
    const repoCfg: Config = withGroupRules([{ ...rule('gh', 'github.com/:org/:repo/*', '{repo}', 'blue'), name: 'Repos' }]);
    const GH = (r: string) => `https://github.com/acme/${r}/pulls`;

    it('detects a drag-out of a restored, already-correct group (no managedTitles)', async () => {
      const f = world();
      f.addTab(tab(1, A, { groupId: 50 }));
      f.addTab(tab(2, A, { groupId: 50 }));
      f.addGroup({ id: 50, windowId: 1, title: 'A', color: 'red', collapsed: false });
      const r = new Reconciler(f, async () => programOf(config));
      await r.flush();
      expect(mutations(f)).toEqual([]);
      f.state.tabs.find((t) => t.id === 1)!.groupId = -1;
      await r.onTabGroupChanged(1, -1);
      const { rt } = (await browser.storage.session.get('rt')) as { rt: RuntimeState };
      expect(rt.leaveAlone).toEqual([1]);
      await r.flush();
      expect(groupOf(f, 1)).toBeUndefined();
    });

    it('a new templated group appends after restored groups; existing groups do not shift', async () => {
      const f = world();
      f.addTab(tab(1, GH('zeta'), { groupId: 20 }));
      f.addTab(tab(2, GH('alpha'), { groupId: 10 }));
      f.addGroup({ id: 20, windowId: 1, title: 'zeta', color: 'blue', collapsed: false });
      f.addGroup({ id: 10, windowId: 1, title: 'alpha', color: 'blue', collapsed: false });
      f.addTab(tab(3, GH('beta')));
      const r = new Reconciler(f, async () => programOf(repoCfg));
      emitGroupEvents(f, r);
      await r.flush();
      expect(groupTitles(f)).toEqual(['zeta', 'alpha', 'beta']);
      expect(count(f, 'moveGroup')).toBe(0);
      const { rt } = (await browser.storage.session.get('rt')) as { rt: RuntimeState };
      expect(rt.creationOrder).toEqual([['1|zeta', 1], ['1|alpha', 2], ['1|beta', 3]]);
      // A group that disappears loses its number.
      f.state.tabs = f.state.tabs.filter((t) => t.id !== 2);
      f.state.groups = f.state.groups.filter((g) => g.id !== 10);
      await r.flush();
      // Absent for one flush: kept (it may be briefly empty); absent for a second: dropped (CR#6).
      let after = ((await browser.storage.session.get('rt')) as { rt: RuntimeState }).rt;
      expect(after.creationOrder).toEqual([['1|zeta', 1], ['1|alpha', 2], ['1|beta', 3]]);
      await r.flush();
      after = ((await browser.storage.session.get('rt')) as { rt: RuntimeState }).rt;
      expect(after.creationOrder).toEqual([['1|zeta', 1], ['1|beta', 3]]);
    });
  });

  it('why-log: one entry per tab per real membership change, with the rule (I7)', async () => {
    const f = world();
    const named: Config = withGroupRules([{ ...rule('a', 'https://a.com/**', 'A', 'red'), name: 'Alpha rule' }]);
    f.addTab(tab(1, A));
    f.addTab(tab(2, A));
    const entries: { tabId?: number; ruleId?: string; action: string; detail: string }[] = [];
    const r = new Reconciler(f, async () => programOf(named), { log: { add: (e) => { entries.push(e); } } });
    emitGroupEvents(f, r);
    await r.flush();
    expect(entries.filter((e) => e.action === 'grouped')).toEqual([
      expect.objectContaining({ tabId: 1, ruleId: 'user/a', detail: 'Moved to A by rule Alpha rule' }),
      expect.objectContaining({ tabId: 2, ruleId: 'user/a', detail: 'Moved to A by rule Alpha rule' }),
    ]);
    await r.flush();
    expect(entries.filter((e) => e.action === 'grouped')).toHaveLength(2);
    setUrl(f, 1, OTHER);
    await r.flush();
    expect(entries.filter((e) => e.action === 'ungrouped')).toEqual([
      expect.objectContaining({ tabId: 1, ruleId: 'user/a', detail: 'Removed from A (no longer matches Alpha rule)' }),
    ]);
  });

  it('re-titles a group it created but could not title, on the next flush (M1)', async () => {
    const f = world();
    f.addTab(tab(1, A));
    f.failNext('updateGroup', 'Group busy');
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    expect(f.state.groups.map((g) => g.title)).toEqual(['']);
    await r.flush();
    expect(f.state.groups.map((g) => g.title)).toEqual(['A']);
    expect(f.state.groups.find((g) => g.title === 'A')!.color).toBe('red');
    expect(groupOf(f, 1)).toBe('A');
    expect(count(f, 'group')).toBe(1);
  });

  it('the expectation window starts again when the mutating call resolves (M2)', async () => {
    const f = world([1, 2]);
    const merge: Config = withGroupRules([{ ...rule('a', 'https://a.com/**', 'A', 'red'), merge: true }]);
    f.addTab(tab(1, A, { groupId: 70 }));
    f.addGroup({ id: 70, windowId: 1, title: 'A', color: 'red', collapsed: false });
    f.addTab(tab(2, A, { windowId: 2 }));
    f.failNext('moveTabs', DRAG, 3); // 250 + 500 + 1000 ms of drag retries before the move succeeds
    const r = new Reconciler(f, async () => programOf(merge));
    const p = r.flush();
    await vi.advanceTimersByTimeAsync(1800);
    await p;
    expect(groupOf(f, 2)).toBe('A');
    await vi.advanceTimersByTimeAsync(1500); // 3.3 s after the move was issued, 1.5 s after it resolved
    await r.onTabGroupChanged(2, -1); // Chrome's late echo of the move (tabs leave their group when moved)
    const { rt } = (await browser.storage.session.get('rt')) as { rt: RuntimeState };
    expect(rt.leaveAlone).toEqual([]);
  });

  it('a fragment-only URL change keeps leave-alone; a real navigation clears it (M3)', async () => {
    const f = world();
    f.addTab(tab(1, A));
    f.addTab(tab(2, A));
    const r = new Reconciler(f, async () => programOf(config));
    emitGroupEvents(f, r);
    await r.flush();
    f.state.tabs.find((t) => t.id === 1)!.groupId = -1;
    await r.onTabGroupChanged(1, -1, A);
    setUrl(f, 1, `${A}#section`);
    await r.onTabUrlChanged(1, `${A}#section`);
    await r.flush();
    expect(groupOf(f, 1)).toBeUndefined();
    setUrl(f, 1, 'https://a.com/y');
    await r.onTabUrlChanged(1, 'https://a.com/y');
    await r.flush();
    expect(groupOf(f, 1)).toBe('A');
  });

  describe('code-review fixes', () => {
    const rt = async () => ((await browser.storage.session.get('rt')) as { rt: RuntimeState }).rt;

    it('a retitle that keeps failing never blocks planning; the entry is dropped after 3 failures (CR#5)', async () => {
      const f = world();
      f.addTab(tab(1, A));
      const failing = new Set<number>();
      const orig = f.updateGroup.bind(f);
      let created = true;
      f.updateGroup = async (gid, p) => {
        if (created) { created = false; failing.add(gid); }
        if (failing.has(gid)) throw new Error('No group with id: ' + gid);
        return orig(gid, p);
      };
      const log = { add: vi.fn() };
      const r = new Reconciler(f, async () => programOf(config), { log });
      emitGroupEvents(f, r);
      await r.flush(); // group created, title call fails: pending
      expect((await rt()).pendingTitles).toHaveLength(1);
      log.add.mockClear();
      f.addTab(tab(2, B));
      await r.flush();
      expect(groupOf(f, 2)).toBe('B'); // planning still ran
      expect(log.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'retitle-failed' }));
      expect(log.add).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'reconcile-error' }));
      expect((await rt()).pendingTitles).toHaveLength(1);
      await r.flush();
      expect((await rt()).pendingTitles).toHaveLength(1);
      await r.flush(); // third consecutive failure
      expect((await rt()).pendingTitles).toEqual([]);
      expect(log.add.mock.calls.filter(([e]) => (e as { action: string }).action === 'retitle-failed')).toHaveLength(3);
    });

    it('a drag lock during retitle still waits for the drag (CR#5)', async () => {
      const f = world();
      f.addTab(tab(1, A));
      f.failNext('updateGroup', 'Group busy');
      const log = { add: vi.fn() };
      const r = new Reconciler(f, async () => programOf(config), { log });
      await r.flush();
      f.failNext('updateGroup', DRAG, 5); // 1 try + 4 retries (3.75 s): exhausted
      const p = r.flush();
      await vi.advanceTimersByTimeAsync(4000);
      await p;
      expect(log.add).toHaveBeenCalledWith(expect.objectContaining({ action: 'drag-retry-exhausted' }));
      expect((await rt()).pendingTitles).toHaveLength(1);
    });

    it('a group whose title is still pending keeps its creation number (CR#6)', async () => {
      const f = world();
      f.addTab(tab(1, A));
      f.failNext('updateGroup', 'Group busy');
      const r = new Reconciler(f, async () => programOf(config));
      emitGroupEvents(f, r);
      await r.flush();
      expect(f.state.groups.map((g) => g.title)).toEqual(['']);
      expect((await rt()).creationOrder).toEqual([['1|A', 1]]);
      await r.flush();
      expect(f.state.groups.map((g) => g.title)).toEqual(['A']);
      expect((await rt()).creationOrder).toEqual([['1|A', 1]]);
    });

    it('merge rule in window 1 and a non-merge rule with the same title in window 2 converge to one group (CR#9)', async () => {
      const f = world([1, 2]);
      const mixed: Config = withGroupRules([
        { ...rule('m', 'https://a.com/m*', 'api', 'blue'), merge: true }, rule('n', 'https://a.com/n*', 'api', 'blue')]);
      f.addTab(tab(1, 'https://a.com/m'));
      f.addTab(tab(2, 'https://a.com/n', { windowId: 2 }));
      const log = { add: vi.fn() };
      const r = new Reconciler(f, async () => programOf(mixed), { log });
      emitGroupEvents(f, r);
      await r.flush();
      expect(f.state.groups.filter((g) => g.title === 'api')).toHaveLength(1);
      expect(log.add).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'reconcile-not-converged' }));
      f.calls = [];
      await r.flush();
      expect(mutations(f)).toEqual([]);
    });
  });
});

describe('Reconciler: compiled program (M2 T6)', () => {
  it('a color that renders outside Chrome colors groups grey and warns once per rule key, not per tab', async () => {
    const f = world();
    f.addTab(tab(1, 'https://a.com/1'));
    f.addTab(tab(2, 'https://a.com/2'));
    const c: Config = {
      ...withGroupRules([]),
      rules: [{ id: 'c', name: 'c', enabled: true, match: { url: 'a.com/:x' }, actions: [{ group: { title: 'A', color: '{x}' } }] }],
    };
    const warn = vi.fn();
    const r = new Reconciler(f, async () => programOf(c), { warn });
    await r.flush();
    f.addTab(tab(3, 'https://a.com/3'));
    await r.flush();
    expect(f.state.groups.map((g) => [g.title, g.color])).toEqual([['A', 'grey']]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('user/c');
  });

  it('names recipe rules in the why-log by their program rule name', async () => {
    const f = world();
    f.addTab(tab(1, 'https://github.com/acme/widgets'));
    const body = structuredClone(builtinRecipes()['github-prs']!);
    body.rules[0]!.enabled = true;
    const entries: { ruleId?: string; detail: string }[] = [];
    const r = new Reconciler(f, async () => programOf(withGroupRules([]), { ...builtinRecipes(), 'github-prs': body }), { log: { add: (e) => { entries.push(e); } } });
    await r.flush();
    expect(entries).toContainEqual(expect.objectContaining({ ruleId: 'github-prs/group-by-repo', detail: 'Moved to widgets by rule Group GitHub tabs by repository' }));
  });
});

describe('Reconciler.planContext (M2 T13 preview)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('returns copies of the planner state plus locked tabs and anchors at their URL; changing them changes nothing', async () => {
    const f = world();
    f.addTab(tab(1, A)); f.addTab(tab(2, B)); f.addTab(tab(3, 'https://anchor.example/'));
    const r = new Reconciler(f, async () => programOf(config), { extraLeaveAlone: () => [2] });
    const st = await r.liveState();
    st.leaveAlone.add(1); st.managedTitles.add('A'); st.creationOrder.set('1|A', 1); st.anchorsDismissed.add('1|B');
    st.anchors.push({ tabId: 3, url: 'https://anchor.example/', windowId: 1, title: 'A' });
    const snap = await f.snapshot();
    const c = await r.planContext(snap, programOf(config));
    expect([...c.leaveAlone].sort()).toEqual([1, 2, 3]);
    expect([...c.managedTitles]).toEqual(['A']);
    expect([...c.creationOrder]).toEqual([['1|A', 1]]);
    expect([...c.anchorsDismissed!]).toEqual(['1|B']);
    c.leaveAlone.add(9); c.managedTitles.add('Z'); c.creationOrder.set('1|Z', 2); c.anchorsDismissed!.add('x');
    expect(st.leaveAlone.has(9) || st.managedTitles.has('Z') || st.creationOrder.has('1|Z') || st.anchorsDismissed.has('x')).toBe(false);
    expect(mutations(f)).toEqual([]);
  });
});
