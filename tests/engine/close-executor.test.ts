import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  afterConfigChange, CLOSE_ALARM_PREFIX, CLOSE_SUGGESTIONS_KEY, CloseExecutor, PENDING_CLOSES_KEY, type CloseExecutorDeps,
} from '../../src/engine/close-executor';
import { SafetyService } from '../../src/engine/safety';
import { RecentlyClosed } from '../../src/core/safety/recently-closed';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';
import type { Rule } from '../../src/core/lang/types';
import type { WhyEntry } from '../../src/core/safety/why-log';
import { programOf } from '../helpers/config';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;
const CB = 'https://example.com/cb?code=1';
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});
const closeRule = (close: { after?: string; mode?: 'auto' | 'suggest' } = { after: '3s' }, o: Partial<Rule> = {}): Rule => ({
  id: 'cb', name: 'Callback', enabled: true, match: { url: 'example.com/cb*' }, actions: [{ close }], ...o,
});
const cfgOf = (rules: Rule[]): Config => ({ ...defaultConfig(), rules, order: rules.map((r) => `user/${r.id}`) });

/** One worker: a CloseExecutor over a real SafetyService, sharing `store` (storage.session) and `port` across restarts. */
function worker(env: { port: FakeBrowserPort; store: Map<string, unknown>; cfg: { c: Config } }, over: Partial<CloseExecutorDeps> = {}) {
  const { port, store, cfg } = env;
  const logs: WhyEntry[] = [];
  const recentlyClosed = new RecentlyClosed();
  const safety = new SafetyService(port, {
    recentlyClosed, log: { add: () => {} }, schedule: () => {}, exemptOnce: () => {}, armExemption: () => () => {},
    api: { executeScript: async () => {}, sendMessage: async () => ({ ok: true }), createNotification: async () => {} },
    bannerFile: 'banner.js',
  });
  const toast = vi.spyOn(safety, 'toast').mockResolvedValue();
  const banner = vi.fn(async () => true);
  const alarms = new Map<string, number>();
  const alarmApi = { create: vi.fn((n: string, when: number) => { alarms.set(n, when); }), clear: vi.fn((n: string) => { alarms.delete(n); }) };
  const facts = new Map<number, { texts: string[]; extracts: Record<string, string>; formEdited: boolean }>();
  const deps: CloseExecutorDeps = {
    safety, recentlyClosed, log: { add: (e) => { logs.push(e); } }, facts: { get: (id) => facts.get(id) }, banner,
    alarms: alarmApi,
    session: { get: async (k) => structuredClone(store.get(k)), set: async (k, v) => { store.set(k, structuredClone(v)); } },
    ...over,
  };
  const ex = new CloseExecutor(port, async () => programOf(cfg.c), deps);
  const closes = () => port.calls.filter((c) => c.method === 'closeTab').map((c) => c.args[0]);
  return { ex, safety, toast, banner, alarms, alarmApi, logs, recentlyClosed, facts, closes };
}

function env(rules: Rule[] = [closeRule()]) {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  port.addWindow(2);
  return { port, store: new Map<string, unknown>(), cfg: { c: cfgOf(rules) } };
}

describe('CloseExecutor', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('auto close after 3 s: closeTab once at 3,000 ms, recorded, logged, undo toast in the window\'s active tab', async () => {
    const e = env();
    e.port.addTab(tab(1, 'https://other.test/', { active: true }));
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    expect(e.store.get(PENDING_CLOSES_KEY)).toEqual([expect.objectContaining({ tabId: 2, url: CB, ruleKey: 'user/cb', fireAt: 1_003_000 })]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(w.closes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.closes()).toEqual([2]);
    expect(w.recentlyClosed.list()).toEqual([expect.objectContaining({ url: CB, reason: 'Callback', ruleId: 'user/cb', windowId: 1 })]);
    expect(w.logs).toContainEqual(expect.objectContaining({ tabId: 2, ruleId: 'user/cb', action: 'auto-close' }));
    expect(w.toast).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ url: CB }), expect.objectContaining({ id: 1 }));
    expect(e.store.get(PENDING_CLOSES_KEY)).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.closes()).toEqual([2]);
  });

  it('form edited at 2 s: no close, banner called', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(2_000);
    w.safety.markFormEdited(2, CB);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.closes()).toEqual([]);
    expect(w.banner).toHaveBeenCalledWith(2, 'protected-close', 'user/cb');
    expect(w.ex.suggestions()).toEqual([]);
  });

  it('the tab became active in the focused window: banner, not close', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    e.port.state.tabs.find((t) => t.id === 2)!.active = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(w.banner).toHaveBeenCalledTimes(1);
  });

  it('the URL changed before the fire time: nothing happens', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    e.port.state.tabs.find((t) => t.id === 2)!.url = 'https://example.com/cb?code=2';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(w.banner).not.toHaveBeenCalled();
    expect(e.store.get(PENDING_CLOSES_KEY)).toEqual([]);
  });

  it('Review Focus #4: a worker restart and rearm() close exactly once; a second rearm() does not close again', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w1 = worker(e);
    await w1.ex.onCommitted(2);
    await w1.ex.evaluate(2);
    vi.clearAllTimers(); // the worker dies with its timers (this also resets the fake clock)
    vi.setSystemTime(1_005_000);
    const w2 = worker(e);
    await w2.ex.rearm();
    await vi.advanceTimersByTimeAsync(0);
    expect(w2.closes()).toEqual([2]);
    await w2.ex.rearm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w2.closes()).toEqual([2]);
  });

  it('rearm() before the fire time re-arms the remaining delay', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w0 = worker(e);
    await w0.ex.onCommitted(2);
    await w0.ex.evaluate(2);
    vi.clearAllTimers(); // the worker dies with its timers (this also resets the fake clock)
    vi.setSystemTime(1_001_000);
    const w2 = worker(e);
    await w2.ex.rearm();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(w2.closes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(w2.closes()).toEqual([2]);
  });

  it('suggest mode: suggestions() lists it (persisted for a restarted worker), nothing closes', async () => {
    const e = env([closeRule({ mode: 'suggest' })]);
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.closes()).toEqual([]);
    expect(w.ex.suggestions()).toEqual([{ tabId: 2, url: CB, ruleKey: 'user/cb', reason: 'Callback' }]);
    expect(e.store.get(CLOSE_SUGGESTIONS_KEY)).toEqual([expect.objectContaining({ tabId: 2, ruleKey: 'user/cb' })]);
    const w2 = worker(e);
    await w2.ex.ready;
    expect(w2.ex.suggestions()).toEqual([{ tabId: 2, url: CB, ruleKey: 'user/cb', reason: 'Callback' }]);
  });

  it('a suggestion goes away when its tab navigates away or closes', async () => {
    const e = env([closeRule({ mode: 'suggest' })]);
    e.port.addTab(tab(2, CB));
    e.port.addTab(tab(3, `${CB}3`));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.onCommitted(3);
    await w.ex.evaluate(3);
    expect(w.ex.suggestions().map((s) => s.tabId)).toEqual([2, 3]);
    e.port.state.tabs.find((t) => t.id === 2)!.url = 'https://other.test/';
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.onTabRemoved(3);
    expect(w.ex.suggestions()).toEqual([]);
    expect(e.store.get(CLOSE_SUGGESTIONS_KEY)).toEqual([]);
  });

  it('dry run: no closeTab, the why-log has a dry-run entry', async () => {
    const e = env([closeRule({ after: '3s' }, { dryRun: true })]);
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(w.logs).toContainEqual(expect.objectContaining({ tabId: 2, ruleId: 'user/cb', action: 'would-close', detail: 'Would close (dry run)' }));
    await w.ex.onFacts(2); // re-evaluation of the same page does not log it again
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.logs.filter((l) => l.action === 'would-close')).toHaveLength(1);
  });

  it('banner unavailable: goes to suggestions', async () => {
    const e = env();
    e.port.addTab(tab(2, CB, { pinned: true }));
    const w = worker(e);
    w.banner.mockResolvedValue(false);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(w.ex.suggestions()).toEqual([{ tabId: 2, url: CB, ruleKey: 'user/cb', reason: 'Callback' }]);
    await w.ex.onFacts(2); // a protected tab is not re-armed by later facts
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.closes()).toEqual([]);
  });

  it('delays over 25 s use chrome.alarms (close:<tabId>); onAlarm fires it', async () => {
    const e = env([closeRule({ after: '2m' })]);
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    expect(w.alarms.get(`${CLOSE_ALARM_PREFIX}2`)).toBe(1_000_000 + 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(w.closes()).toEqual([]); // no setTimeout
    await w.ex.onAlarm(`${CLOSE_ALARM_PREFIX}2`);
    expect(w.closes()).toEqual([2]);
  });

  it('a 25 s delay uses setTimeout', async () => {
    const e = env([closeRule({ after: '25s' })]);
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    expect(w.alarmApi.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(w.closes()).toEqual([2]);
  });

  it('pause-all or a paused rule keeps the entry pending; rearm() after resume closes it', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const paused = new Set<string>();
    const w = worker(e, { isRulePaused: (k) => paused.has(k) });
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    w.safety.pause('15m');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(e.store.get(PENDING_CLOSES_KEY)).toHaveLength(1);
    w.safety.resume();
    paused.add('user/cb');
    await w.ex.rearm();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.closes()).toEqual([]);
    expect(e.store.get(PENDING_CLOSES_KEY)).toHaveLength(1);
    paused.clear();
    await w.ex.rearm();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.closes()).toEqual([2]);
  });

  it('a paused recipe rule keeps its entry through re-evaluation (the Program leaves paused rules out)', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const paused = new Set<string>();
    const w = worker(e, { isRulePaused: (k) => paused.has(k) });
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    paused.add('user/cb');
    e.cfg.c = cfgOf([]); // as compiled without the paused rule
    await w.ex.onFacts(2);
    expect(e.store.get(PENDING_CLOSES_KEY)).toHaveLength(1);
  });

  it('the rule no longer wins at fire time: dropped', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    e.cfg.c = cfgOf([closeRule({ after: '3s' }, { id: 'other' }), closeRule()]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(e.store.get(PENDING_CLOSES_KEY)).toEqual([]);
  });

  it('anchors are never auto-closed', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const anchor = { on: false };
    const w = worker(e, { isAnchor: () => anchor.on });
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    anchor.on = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(w.banner).not.toHaveBeenCalled();
  });

  it('an undone close is exempt until its URL changes (R24)', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.exempt(2, CB);
    await vi.advanceTimersByTimeAsync(3_000);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    e.port.state.tabs.find((t) => t.id === 2)!.url = 'https://example.com/cb?code=9';
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([2]);
  });

  it('form state unobservable: a tab active since commit is not closed', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e, { observesForm: () => false });
    w.banner.mockResolvedValue(false);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.onActivated(2); // the user looked at it, then switched away
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(w.ex.suggestions().map((s) => s.tabId)).toEqual([2]);
  });

  it('form state unobservable: a recommit of the same page restarts the activity baseline', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e, { observesForm: () => false });
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.onActivated(2);
    await w.ex.onCommitted(2); // reloaded in the background
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([2]);
  });

  it('form state observable: activity since commit alone does not block the close', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e, { observesForm: () => true });
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.onActivated(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([2]);
  });

  it('protected-close banner: Close closes the tab (same URL), Keep keeps it', async () => {
    const e = env();
    e.port.addTab(tab(2, CB, { audible: true }));
    e.port.addTab(tab(3, `${CB}3`, { audible: true }));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.onCommitted(3);
    await w.ex.evaluate(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.banner).toHaveBeenCalledTimes(2);
    await w.ex.onCloseChoice(3, 'keep');
    await w.ex.onCloseChoice(3, 'close'); // answered already
    await w.ex.onCloseChoice(2, 'close');
    expect(w.closes()).toEqual([2]);
    expect(w.logs).toContainEqual(expect.objectContaining({ tabId: 2, action: 'close-confirmed' }));
    expect(w.recentlyClosed.list()).toEqual([expect.objectContaining({ url: CB, ruleId: 'user/cb' })]);
  });

  it('a banner choice for a tab that navigated since is ignored', async () => {
    const e = env();
    e.port.addTab(tab(2, CB, { audible: true }));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    e.port.state.tabs.find((t) => t.id === 2)!.url = 'https://other.test/';
    await w.ex.onCloseChoice(2, 'close');
    expect(w.closes()).toEqual([]);
  });

  it('re-evaluating a scheduled tab does not push its fire time back', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await w.ex.onFacts(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.closes()).toEqual([2]);
  });

  it('a removed tab cancels its pending close and alarm', async () => {
    const e = env([closeRule({ after: '1m' })]);
    e.port.addTab(tab(2, CB));
    const w = worker(e);
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await w.ex.onTabRemoved(2);
    expect(w.alarms.size).toBe(0);
    expect(e.store.get(PENDING_CLOSES_KEY)).toEqual([]);
  });

  it('waits for beforeRun (locks / page facts loaded) before deciding', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = worker(e, { beforeRun: () => gate });
    const done = w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(e.store.get(PENDING_CLOSES_KEY)).toBeUndefined();
    release();
    await done;
    expect(e.store.get(PENDING_CLOSES_KEY)).toHaveLength(1);
  });

  it('restart before the permissions sync: a rule paused meanwhile stays pending (beforeRun awaits PermissionsManager.ready)', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w0 = worker(e);
    await w0.ex.onCommitted(2);
    await w0.ex.evaluate(2);
    vi.clearAllTimers();
    vi.setSystemTime(1_005_000); // overdue
    // The new worker's paused set is empty until its first sync, which finds the rule's permission revoked.
    let paused = new Set<string>();
    let synced!: () => void;
    const ready = new Promise<void>((r) => { synced = () => { paused = new Set(['user/cb']); r(); }; });
    const w2 = worker(e, { isRulePaused: (k) => paused.has(k), beforeRun: () => ready });
    const rearmed = w2.ex.rearm();
    await vi.advanceTimersByTimeAsync(0);
    synced();
    await rearmed;
    await vi.advanceTimersByTimeAsync(0);
    expect(w2.closes()).toEqual([]);
    expect(e.store.get(PENDING_CLOSES_KEY)).toHaveLength(1);
  });

  it('restart without a recorded commit: a re-evaluated background tab counts as used since load (unobservable form state)', async () => {
    const e = env([closeRule({ after: '3s' }, { match: { url: 'example.com/cb*' } })]);
    e.port.addTab(tab(2, CB));
    const w = worker(e, { observesForm: () => false });
    w.banner.mockResolvedValue(false);
    await w.ex.evaluate(2); // e.g. a tabs.onUpdated hash change seen by a restarted worker: no onCommitted recorded
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([]);
    expect(w.ex.suggestions().map((x) => x.tabId)).toEqual([2]);
  });

  it('an observed commit of a never-active background tab still closes (unobservable form state)', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    const w = worker(e, { observesForm: () => false });
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([2]);
  });

  it('evaluateAll (browser startup) schedules every matching tab', async () => {
    const e = env();
    e.port.addTab(tab(2, CB));
    e.port.addTab(tab(3, 'https://other.test/'));
    const w = worker(e, { observesForm: () => true }); // no commit seen yet: closes only where form state is known (R46)
    await w.ex.evaluateAll();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([2]);
  });
});

describe('config change re-evaluates open tabs (ruling R51)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  const CALLBACK = 'http://localhost:8080/auth/callback?code=x';
  const finished = (on: boolean, params: Record<string, unknown> = {}): Config => ({
    ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: on, params } : r)),
  });
  const pending = (e: ReturnType<typeof env>) => e.store.get(PENDING_CLOSES_KEY) as { tabId: number; ruleKey: string; fireAt: number }[] | undefined;

  it('enabling `finished` with a localhost callback tab already open schedules its close', async () => {
    const e = env();
    e.cfg.c = finished(false);
    e.port.addTab(tab(1, CALLBACK));
    const w = worker(e, { observesForm: () => true });
    await w.ex.evaluateAll();
    expect(pending(e) ?? []).toEqual([]);
    e.cfg.c = finished(true);
    await afterConfigChange(async () => {}, w.ex);
    expect(pending(e)).toEqual([expect.objectContaining({ tabId: 1, ruleKey: 'finished/oauth-callback', fireAt: 1_003_000 })]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.closes()).toEqual([1]);
  });

  it('a second config change does not reset fireAt or schedule twice', async () => {
    const e = env();
    e.cfg.c = finished(true);
    e.port.addTab(tab(1, CALLBACK));
    const w = worker(e, { observesForm: () => true });
    await afterConfigChange(async () => {}, w.ex);
    await vi.advanceTimersByTimeAsync(2_000);
    e.cfg.c = { ...finished(true), dryRun: false, tables: { x: { a: 'b' } } }; // an unrelated change
    await afterConfigChange(async () => {}, w.ex);
    expect(pending(e)).toEqual([expect.objectContaining({ tabId: 1, fireAt: 1_003_000 })]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.closes()).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.closes()).toEqual([1]);
  });

  it('disabling the rule cancels the pending close', async () => {
    const e = env();
    e.cfg.c = finished(true);
    e.port.addTab(tab(1, CALLBACK));
    const w = worker(e, { observesForm: () => true });
    await afterConfigChange(async () => {}, w.ex);
    e.cfg.c = finished(false);
    await afterConfigChange(async () => {}, w.ex);
    expect(pending(e) ?? []).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.closes()).toEqual([]);
  });

  it('re-evaluates only after the permission sync (the paused set is current)', async () => {
    const order: string[] = [];
    await afterConfigChange(async () => { await Promise.resolve(); order.push('sync'); }, { evaluateAll: async () => { order.push('evaluate'); } });
    expect(order).toEqual(['sync', 'evaluate']);
  });

  it('then refreshes the badge (R60: it depends on config), also when the sync or re-evaluation fails (T17 fix 1)', async () => {
    const order: string[] = [];
    await afterConfigChange(async () => { order.push('sync'); }, { evaluateAll: async () => { order.push('evaluate'); } }, () => order.push('badge'));
    expect(order).toEqual(['sync', 'evaluate', 'badge']);
    const badge = vi.fn();
    await expect(afterConfigChange(async () => { throw new Error('x'); }, { evaluateAll: async () => {} }, badge)).rejects.toThrow('x');
    expect(badge).toHaveBeenCalledTimes(1);
  });
});
