// Dry-run mode (M2 T12): per rule and globally. Rulings R10 (as amended) and R48 (dry-run falls through).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Reconciler } from '../../src/engine/reconciler';
import { DedupeHandler, type DedupeDeps } from '../../src/engine/dedupe-handler';
import { CloseExecutor, type CloseExecutorDeps } from '../../src/engine/close-executor';
import { SafetyService } from '../../src/engine/safety';
import { RecentlyClosed } from '../../src/core/safety/recently-closed';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';
import type { Action, GroupAction, Rule } from '../../src/core/lang/types';
import type { WhyEntry } from '../../src/core/safety/why-log';
import { programOf } from '../helpers/config';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;
const MUTATING = new Set(['group', 'ungroup', 'moveTabs', 'moveGroup', 'updateGroup', 'closeTab', 'createTab', 'focusTab']);
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});
const rule = (id: string, url: string, actions: Action[], o: Partial<Rule> = {}): Rule => ({
  id, name: id.toUpperCase(), enabled: true, match: { url }, actions, ...o,
});
const group = (title: string, o: Partial<GroupAction> = {}): Action => ({ group: { title, color: 'blue', ...o } });
const cfgOf = (rules: Rule[], o: Partial<Config> = {}): Config => ({
  ...defaultConfig(), rules, order: rules.map((r) => `user/${r.id}`), ...o,
});
const mutations = (f: FakeBrowserPort) => f.calls.filter((c) => MUTATING.has(c.method));
const groupOf = (f: FakeBrowserPort, tabId: number): string | undefined => {
  const gid = f.state.tabs.find((t) => t.id === tabId)!.groupId;
  return f.state.groups.find((g) => g.id === gid)?.title;
};

function reconciler(cfg: Config) {
  const port = new FakeBrowserPort();
  port.addWindow(1);
  const logs: WhyEntry[] = [];
  const r = new Reconciler(port, async () => programOf(cfg), { log: { add: (e) => { logs.push(e); } } });
  const would = () => logs.filter((l) => l.action.startsWith('would-'));
  return { port, r, logs, would };
}

describe('dry run: grouping', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('global dry run: no mutating calls after a flush with misplaced tabs; would-group / would-ungroup are logged', async () => {
    const cfg = cfgOf([rule('a', 'a.com/*', [group('A')]), rule('b', 'b.com/*', [group('B')])], { dryRun: true });
    const w = reconciler(cfg);
    w.port.addTab(tab(1, 'https://a.com/1'));
    w.port.addTab(tab(2, 'https://b.com/1'));
    w.port.addTab(tab(3, 'https://other.com/', { groupId: 10 }));
    w.port.addGroup({ id: 10, windowId: 1, title: 'A', color: 'red', collapsed: false });
    // 'A' is a group Tabchef made earlier: strict would ungroup tab 3 and recolor the group
    (await w.r.liveState()).managedTitles.add('A');
    await w.r.flush();
    expect(mutations(w.port)).toEqual([]);
    expect(w.would()).toEqual(expect.arrayContaining([
      expect.objectContaining({ tabId: 1, ruleId: 'user/a', action: 'would-group', dryRun: true }),
      expect.objectContaining({ tabId: 2, ruleId: 'user/b', action: 'would-group', dryRun: true }),
      expect.objectContaining({ tabId: 3, action: 'would-ungroup', dryRun: true }),
    ]));
    expect(w.would().every((l) => l.dryRun === true)).toBe(true);
  });

  it('a dry-run rule A next to a live rule B: only B\'s ops are applied, A\'s are logged', async () => {
    const w = reconciler(cfgOf([rule('a', 'a.com/*', [group('A')], { dryRun: true }), rule('b', 'b.com/*', [group('B')])]));
    w.port.addTab(tab(1, 'https://a.com/1'));
    w.port.addTab(tab(2, 'https://b.com/1'));
    await w.r.flush();
    expect(groupOf(w.port, 1)).toBeUndefined();
    expect(groupOf(w.port, 2)).toBe('B');
    expect(w.would()).toEqual([
      expect.objectContaining({ tabId: 1, ruleId: 'user/a', action: 'would-group', detail: 'Would move to A by rule A (dry run)', dryRun: true }),
    ]);
  });

  it('falls through (R48): a dry-run rule A outranking a live rule B — B\'s group is applied, A is logged as would-group', async () => {
    const w = reconciler(cfgOf([
      rule('a', 'example.com/*', [group('A')], { dryRun: true }),
      rule('b', 'example.com/*', [group('B')]),
    ]));
    w.port.addTab(tab(1, 'https://example.com/1'));
    await w.r.flush();
    expect(groupOf(w.port, 1)).toBe('B');
    expect(w.would()).toEqual([expect.objectContaining({ tabId: 1, ruleId: 'user/a', action: 'would-group', dryRun: true })]);
  });

  it('logs a would-* entry once per (tab, rule, target) across repeated flushes, again once it stops and resumes', async () => {
    const w = reconciler(cfgOf([rule('a', 'a.com/*', [group('A')], { dryRun: true })]));
    w.port.addTab(tab(1, 'https://a.com/1'));
    await w.r.flush();
    await w.r.flush();
    await w.r.flush();
    expect(w.would()).toHaveLength(1);
    w.port.state.tabs[0]!.url = 'https://other.com/';
    await w.r.flush();
    w.port.state.tabs[0]!.url = 'https://a.com/1';
    await w.r.flush();
    expect(w.would()).toHaveLength(2);
  });

  it('a dry-run rule does not adopt a user group with its title (§2 T6→T12)', async () => {
    const w = reconciler(cfgOf([rule('a', 'a.com/*', [group('A')], { dryRun: true })]));
    w.port.addTab(tab(1, 'https://other.com/', { groupId: 10 }));
    w.port.addGroup({ id: 10, windowId: 1, title: 'A', color: 'red', collapsed: false });
    w.port.addTab(tab(2, 'https://a.com/1'));
    await w.r.flush();
    expect(mutations(w.port)).toEqual([]);
    expect((await w.r.liveState()).managedTitles.has('A')).toBe(false);
  });

  it('a dry-run rule sharing a title template does not make a live strict group non-strict (T6 minor, ruleFor)', async () => {
    const w = reconciler(cfgOf([
      rule('a', 'a.com/*', [group('X', { strict: false })], { dryRun: true }),
      rule('b', 'b.com/*', [group('X')]),
    ]));
    w.port.addTab(tab(1, 'https://other.com/', { groupId: 10 }));
    w.port.addGroup({ id: 10, windowId: 1, title: 'X', color: 'blue', collapsed: false });
    (await w.r.liveState()).managedTitles.add('X');
    await w.r.flush();
    expect(groupOf(w.port, 1)).toBeUndefined(); // B is strict: the non-matching tab leaves X
  });

  it('R49: switching a rule to dry-run leaves its existing group alone (no ungroup, no move, no would-ungroup)', async () => {
    const live = cfgOf([rule('a', 'a.com/*', [group('api')])]);
    const port = new FakeBrowserPort();
    port.addWindow(1);
    const logs: WhyEntry[] = [];
    const cfg = { c: live };
    const r = new Reconciler(port, async () => programOf(cfg.c), { log: { add: (e) => { logs.push(e); } } });
    port.addTab(tab(1, 'https://a.com/1'));
    port.addTab(tab(2, 'https://a.com/2'));
    await r.flush();
    expect([groupOf(port, 1), groupOf(port, 2)]).toEqual(['api', 'api']);
    port.state.tabs.find((t) => t.id === 2)!.url = 'https://other.com/'; // strict would ungroup it under a live A
    cfg.c = cfgOf([rule('a', 'a.com/*', [group('api')], { dryRun: true })]);
    const before = port.calls.length;
    await r.flush();
    await r.flush();
    expect(port.calls.slice(before).filter((c) => MUTATING.has(c.method))).toEqual([]);
    expect([groupOf(port, 1), groupOf(port, 2)]).toEqual(['api', 'api']);
    expect(logs.filter((l) => l.action === 'would-ungroup')).toEqual([]);
  });

  it('R49: a NEW matching tab still falls through to a lower live rule B; A\'s would-group is logged once', async () => {
    const port = new FakeBrowserPort();
    port.addWindow(1);
    const logs: WhyEntry[] = [];
    const cfg = { c: cfgOf([rule('a', 'a.com/*', [group('api')]), rule('b', 'a.com/*', [group('B')])]) };
    const r = new Reconciler(port, async () => programOf(cfg.c), { log: { add: (e) => { logs.push(e); } } });
    port.addTab(tab(1, 'https://a.com/1'));
    await r.flush();
    expect(groupOf(port, 1)).toBe('api');
    cfg.c = cfgOf([rule('a', 'a.com/*', [group('api')], { dryRun: true }), rule('b', 'a.com/*', [group('B')])]);
    await r.flush();
    port.addTab(tab(2, 'https://a.com/2'));
    await r.flush();
    await r.flush();
    expect(groupOf(port, 1)).toBe('api'); // A's existing group is left alone
    expect(groupOf(port, 2)).toBe('B'); // the new tab falls through to B
    expect(logs.filter((l) => l.action.startsWith('would-'))).toEqual([
      expect.objectContaining({ tabId: 2, ruleId: 'user/a', action: 'would-group', detail: 'Would move to api by rule A (dry run)', dryRun: true }),
    ]);
  });

  it('a dry-run group rule with anchors outranking a live rule: the live group is made, the dry-run anchors are not opened', async () => {
    const w = reconciler(cfgOf([
      rule('a', 'a.com/*', [group('A', { anchors: ['https://a.com/home'] })], { dryRun: true }),
      rule('b', 'a.com/*', [group('B')]),
    ]));
    w.port.addTab(tab(1, 'https://a.com/1'));
    await w.r.flush();
    expect(groupOf(w.port, 1)).toBe('B');
    expect(w.port.calls.filter((c) => c.method === 'createTab')).toEqual([]);
  });

  it('R49 shared title: a tab in X whose full-program winner is dry-run A (targeting X) stays, though live B also makes X', async () => {
    const port = new FakeBrowserPort();
    port.addWindow(1);
    const cfg = { c: cfgOf([rule('a', 'a.com/*', [group('X')]), rule('b', 'b.com/*', [group('X')])]) };
    const r = new Reconciler(port, async () => programOf(cfg.c));
    port.addTab(tab(1, 'https://a.com/1'));
    port.addTab(tab(2, 'https://b.com/1'));
    await r.flush();
    expect([groupOf(port, 1), groupOf(port, 2)]).toEqual(['X', 'X']);
    cfg.c = cfgOf([rule('a', 'a.com/*', [group('X')], { dryRun: true }), rule('b', 'b.com/*', [group('X')])]);
    const before = port.calls.length;
    await r.flush();
    await r.flush();
    expect(port.calls.slice(before).filter((c) => MUTATING.has(c.method))).toEqual([]);
    expect([groupOf(port, 1), groupOf(port, 2)]).toEqual(['X', 'X']);
  });
});

function dedupe(cfg: Config) {
  const port = new FakeBrowserPort();
  port.addWindow(1);
  port.addWindow(2);
  const logs: WhyEntry[] = [];
  const closed: { ruleId?: string }[] = [];
  const ask = vi.fn(async () => {});
  const deps: DedupeDeps = {
    recentlyClosed: { add: (e) => { closed.push(e); return 'rc'; } }, log: { add: (e) => { logs.push(e); } }, ask,
    isPaused: () => false, isLocked: () => false, now: () => 1_000_000,
  };
  const h = new DedupeHandler(port, async () => programOf(cfg), deps);
  return { port, h, logs, closed, ask };
}

describe('dry run: dedupe', () => {
  const U = 'https://example.com/page';
  const off = { ...defaultConfig().dedupe, mode: 'off' as const };

  it('a dry-run rule\'s dedupe: no close, a would-close entry', async () => {
    const w = dedupe(cfgOf([rule('d', 'example.com/*', [{ dedupe: { mode: 'always-switch' } }], { dryRun: true })], { dedupe: off }));
    w.port.addTab(tab(1, U, { windowId: 2 }));
    w.port.addTab(tab(2, U));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, U, 'pending');
    expect(mutations(w.port)).toEqual([]);
    expect(w.logs).toEqual([expect.objectContaining({ tabId: 2, ruleId: 'user/d', action: 'would-close', dryRun: true })]);
    expect(w.logs[0]!.detail).toContain('duplicate');
    await w.h.onCandidate(2, U, 'committed'); // the same tab and key is not logged twice
    expect(w.logs).toHaveLength(1);
  });

  it('falls through (R48): a dry-run "off" rule outranking a live always-switch rule — the live rule closes', async () => {
    const w = dedupe(cfgOf([
      rule('d', 'example.com/*', [{ dedupe: { mode: 'off' } }], { dryRun: true }),
      rule('e', 'example.com/*', [{ dedupe: { mode: 'always-switch' } }]),
    ], { dedupe: off }));
    w.port.addTab(tab(1, U, { windowId: 2 }));
    w.port.addTab(tab(2, U));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, U, 'pending');
    expect(w.port.calls.filter((c) => c.method === 'closeTab').map((c) => c.args)).toEqual([[2]]);
    expect(w.closed[0]?.ruleId).toBe('user/e');
  });

  it('the close cause never falls back to a dry-run group winner (T6 minor)', async () => {
    const w = dedupe(cfgOf([rule('g', 'example.com/*', [group('G')], { dryRun: true })]));
    w.port.addTab(tab(1, U, { windowId: 2 }));
    w.port.addTab(tab(2, U));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, U, 'pending');
    expect(w.port.calls.filter((c) => c.method === 'closeTab').map((c) => c.args)).toEqual([[2]]);
    expect(w.closed[0]?.ruleId).toBeUndefined();
  });

  it('global dry run: no close, no focus, no ask; a would-close entry', async () => {
    const w = dedupe(cfgOf([], { dryRun: true }));
    w.port.addTab(tab(1, U, { windowId: 2 }));
    w.port.addTab(tab(2, U));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, U, 'pending');
    expect(mutations(w.port)).toEqual([]);
    expect(w.ask).not.toHaveBeenCalled();
    expect(w.logs).toEqual([expect.objectContaining({ tabId: 2, action: 'would-close', dryRun: true })]);
  });
});

describe('dry run: close', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });
  const CB = 'https://example.com/cb?code=1';

  function closer(cfg: Config) {
    const port = new FakeBrowserPort();
    port.addWindow(1, { focused: true });
    const logs: WhyEntry[] = [];
    const recentlyClosed = new RecentlyClosed();
    const safety = new SafetyService(port, {
      recentlyClosed, log: { add: () => {} }, schedule: () => {}, exemptOnce: () => {}, armExemption: () => () => {},
      api: { executeScript: async () => {}, sendMessage: async () => ({ ok: true }), createNotification: async () => {} },
      bannerFile: 'banner.js',
    });
    vi.spyOn(safety, 'toast').mockResolvedValue();
    const store = new Map<string, unknown>();
    const deps: CloseExecutorDeps = {
      safety, recentlyClosed, log: { add: (e) => { logs.push(e); } }, facts: { get: () => undefined }, banner: async () => true,
      alarms: { create: () => {}, clear: () => {} },
      session: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } },
    };
    const ex = new CloseExecutor(port, async () => programOf(cfg), deps);
    return { port, ex, logs };
  }

  it('falls through (R48): a dry-run close rule outranking a live one — the live rule closes, the dry-run one is logged', async () => {
    const w = closer(cfgOf([
      rule('a', 'example.com/cb*', [{ close: { after: '3s' } }], { dryRun: true }),
      rule('b', 'example.com/cb*', [{ close: { after: '3s' } }]),
    ]));
    w.port.addTab(tab(1, 'https://other.test/', { active: true }));
    w.port.addTab(tab(2, CB));
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.port.calls.filter((c) => c.method === 'closeTab').map((c) => c.args)).toEqual([[2]]);
    expect(w.logs).toContainEqual(expect.objectContaining({ tabId: 2, ruleId: 'user/a', action: 'would-close', dryRun: true }));
    expect(w.logs).toContainEqual(expect.objectContaining({ tabId: 2, ruleId: 'user/b', action: 'auto-close' }));
  });

  it('global dry run: no close; the would-close entry is flagged dryRun', async () => {
    const w = closer(cfgOf([rule('a', 'example.com/cb*', [{ close: { after: '3s' } }])], { dryRun: true }));
    w.port.addTab(tab(2, CB));
    await w.ex.onCommitted(2);
    await w.ex.evaluate(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mutations(w.port)).toEqual([]);
    expect(w.logs).toEqual([expect.objectContaining({ tabId: 2, ruleId: 'user/a', action: 'would-close', dryRun: true })]);
  });
});
