import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { SafetyService, type SafetyDeps } from '../../src/engine/safety';
import { RecentlyClosed } from '../../src/core/safety/recently-closed';
import { DedupeHandler } from '../../src/engine/dedupe-handler';
import { Reconciler } from '../../src/engine/reconciler';
import { WhyLog } from '../../src/core/safety/why-log';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';
import { withGroupRules, programOf } from '../helpers/config';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;
const PR = 'https://github.com/acme/api/pull/1';
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});

function setup(over: Partial<SafetyDeps> = {}, clock = { t: 1_000_000 }) {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  port.addWindow(2);
  const recentlyClosed = new RecentlyClosed();
  const schedule = vi.fn();
  const exemptOnce = vi.fn();
  const armExemption = vi.fn(() => () => {});
  const logs: unknown[] = [];
  const api = {
    executeScript: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ ok: true })),
    createNotification: vi.fn(async () => {}),
  };
  const deps: SafetyDeps = {
    recentlyClosed, log: { add: (e) => { logs.push(e); } }, schedule, exemptOnce, armExemption, api,
    bannerFile: '/content-scripts/banner.js', now: () => clock.t, ...over,
  };
  const svc = new SafetyService(port, deps);
  return { deps, armExemption, port, svc, recentlyClosed, schedule, exemptOnce, api, logs, clock };
}
const closedEntry = { url: PR, title: 'PR', windowId: 2, reason: 'duplicate', at: 5, groupTitle: 'GH' };

describe('SafetyService', () => {
  beforeEach(() => fakeBrowser.reset());

  describe('pause', () => {
    it('15m: paused until the resume alarm fires', async () => {
      const w = setup();
      await w.svc.ready;
      w.svc.pause('15m');
      expect(w.svc.isPaused()).toBe(true);
      await w.svc.idle();
      expect(await browser.alarms.get('resume')).toBeDefined();
      w.svc.onAlarm({ name: 'resume' });
      expect(w.svc.isPaused()).toBe(false);
      await w.svc.idle();
      expect(await browser.alarms.get('resume')).toBeUndefined();
    });

    it('1h: also expires by time even if the alarm is missed', async () => {
      const w = setup();
      w.svc.pause('1h');
      w.clock.t += 59 * 60_000;
      expect(w.svc.isPaused()).toBe(true);
      w.clock.t += 2 * 60_000;
      expect(w.svc.isPaused()).toBe(false);
    });

    it('restart: stored in storage.session, mirrored on worker restart, resume clears it', async () => {
      const w = setup();
      w.svc.pause('restart');
      expect(w.svc.isPaused()).toBe(true);
      await w.svc.idle();
      expect((await browser.storage.session.get('pauseRestart')).pauseRestart).toBe(true);
      const again = setup();
      await again.svc.ready;
      expect(again.svc.isPaused()).toBe(true);
      again.svc.resume();
      expect(again.svc.isPaused()).toBe(false);
      await again.svc.idle();
      expect((await browser.storage.session.get('pauseRestart')).pauseRestart).toBeUndefined();
    });
  });

  describe('startup ordering', () => {
    it('a candidate arriving before init resolves does not close while paused (state in storage)', async () => {
      await browser.storage.session.set({ pauseRestart: true });
      const w = setup();
      w.port.addTab(tab(1, PR, { windowId: 2 }));
      w.port.addTab(tab(2, PR));
      const h = new DedupeHandler(w.port, async () => programOf(defaultConfig()), {
        recentlyClosed: w.recentlyClosed, log: new WhyLog(), ask: async () => {},
        isPaused: () => w.svc.isPaused(), isLocked: (id) => w.svc.isLocked(id),
        beforeDecide: () => w.svc.ready,
      });
      h.recordCreated(2);
      expect(w.svc.isPaused()).toBe(false); // not loaded yet
      await h.onCandidate(2, PR, 'pending');
      expect(w.port.calls.filter((c) => c.method === 'closeTab')).toEqual([]);
    });
  });

  describe('pause end', () => {
    it('schedules a reconcile when the alarm fires and when the pause expires by time', async () => {
      const w = setup();
      await w.svc.ready;
      w.svc.pause('15m');
      w.schedule.mockClear();
      w.svc.onAlarm({ name: 'resume' });
      expect(w.schedule).toHaveBeenCalledTimes(1);
      w.svc.pause('15m');
      w.schedule.mockClear();
      w.clock.t += 16 * 60_000;
      expect(w.svc.isPaused()).toBe(false);
      expect(w.schedule).toHaveBeenCalledTimes(1);
      expect(w.svc.isPaused()).toBe(false);
      expect(w.schedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('detached lock expiry', () => {
    it('stored locks re-attach only within 60 s of a browser start, then are dropped', async () => {
      await browser.storage.local.set({ locks: [{ url: PR, windowId: 1 }] });
      const w = setup();
      await w.svc.ready;
      w.clock.t += 61_000;
      w.svc.onTabSeen({ id: 9, url: PR, windowId: 1 });
      expect(w.svc.isLocked(9)).toBe(false);
      await w.svc.idle();
      expect((await browser.storage.local.get('locks')).locks).toEqual([]);
    });

    it('a mid-session worker restart restores live locks by tab id and does not re-attach detached records', async () => {
      const clock = { t: 1_000_000 };
      const w = setup({}, clock);
      w.port.addTab(tab(1, PR));
      w.svc.lock(1);
      w.port.addTab(tab(2, 'https://b.com/'));
      w.svc.lock(2);
      await w.svc.idle();
      w.svc.onTabRemoved(2, true); // window closing: kept stored but detached
      await w.svc.idle();
      clock.t += 5 * 60_000; // worker restart long after the browser start
      const w2 = setup({}, clock);
      w2.port.addTab(tab(1, PR));
      await w2.svc.ready;
      expect(w2.svc.lockedTabIds()).toEqual([1]);
      w2.svc.onTabSeen({ id: 77, url: 'https://b.com/', windowId: 1 });
      expect(w2.svc.isLocked(77)).toBe(false);
    });
  });

  describe('lock survival across worker sleep', () => {
    it('a locked tab that navigates while the worker sleeps stays locked, record updated', async () => {
      const clock = { t: 1_000_000 };
      const w = setup({}, clock);
      w.port.addTab(tab(5, PR));
      w.svc.lock(5);
      await w.svc.idle();
      clock.t += 5 * 60_000;
      const w2 = setup({}, clock);
      w2.port.addTab(tab(5, 'https://b.com/moved'));
      w2.svc.onTabSeen({ id: 5, url: 'https://b.com/moved', windowId: 1 }); // waking onUpdated, before ready
      await w2.svc.ready;
      expect(w2.svc.lockedTabIds()).toEqual([5]);
      await w2.svc.idle();
      expect((await browser.storage.local.get('locks')).locks).toEqual([{ url: 'https://b.com/moved', windowId: 1, tabId: 5 }]);
    });

    it('parked records survive mid-session restarts, then attach only in the next browser-start window', async () => {
      const clock = { t: 1_000_000 };
      const w = setup({}, clock);
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, 'https://b.com/'));
      w.svc.lock(1);
      w.svc.lock(2);
      await w.svc.idle();
      w.svc.onTabRemoved(2, true);
      await w.svc.idle();
      clock.t += 5 * 60_000;
      const w2 = setup({}, clock);
      w2.port.addTab(tab(1, PR));
      await w2.svc.ready;
      await w2.svc.idle();
      w2.svc.onTabSeen({ id: 77, url: 'https://b.com/', windowId: 1 });
      expect(w2.svc.isLocked(77)).toBe(false);
      expect(((await browser.storage.local.get('locks')).locks as { url: string }[]).map((r) => r.url).sort())
        .toEqual(['https://b.com/', PR]);
      // Browser restart: session storage is cleared.
      await browser.storage.session.remove('tabchef.locksAttachStarted');
      clock.t += 60 * 60_000;
      const w3 = setup({}, clock);
      w3.port.addTab(tab(3, 'https://b.com/'));
      await w3.svc.ready;
      expect(w3.svc.lockedTabIds()).toEqual([3]);
    });
  });

  describe('locks', () => {
    it('lock/unlock and isProtected', async () => {
      const w = setup();
      const t = w.port.addTab(tab(1, PR));
      w.svc.lock(1);
      expect(w.svc.isLocked(1)).toBe(true);
      expect(w.svc.isProtected(t)).toBe(true);
      w.svc.unlock(1);
      expect(w.svc.isProtected(t)).toBe(false);
      expect(w.svc.isProtected({ ...t, pinned: true })).toBe(true);
      expect(w.svc.isProtected({ ...t, audible: true })).toBe(true);
      expect(w.svc.isProtected({ ...t, url: 'chrome://settings' })).toBe(true);
    });

    it('persists {url, windowId} and re-attaches by URL after restart (new tab ids)', async () => {
      const w = setup();
      w.port.addTab(tab(1, PR, { windowId: 2 }));
      w.svc.lock(1);
      await w.svc.idle();
      expect((await browser.storage.local.get('locks')).locks).toEqual([{ url: PR, windowId: 2, tabId: 1 }]);

      const w2 = setup();
      // Window ids changed across the restart: only the URL identifies the tab; windowId breaks ties.
      w2.port.addTab(tab(41, 'https://other.com/', { windowId: 1 }));
      w2.port.addTab(tab(42, PR, { windowId: 1 }));
      w2.port.addTab(tab(43, PR, { windowId: 2 }));
      await w2.svc.ready;
      expect(w2.svc.lockedTabIds()).toEqual([43]);
    });

    it('re-attaches a lock to a restored tab that appears after startup; a lock follows URL changes', async () => {
      await browser.storage.local.set({ locks: [{ url: PR, windowId: 1 }] });
      const w = setup();
      await w.svc.ready;
      expect(w.svc.lockedTabIds()).toEqual([]);
      w.svc.onTabSeen({ id: 9, url: PR, windowId: 1 });
      expect(w.svc.isLocked(9)).toBe(true);
      w.svc.onTabSeen({ id: 9, url: 'https://x.com/', windowId: 1 });
      await w.svc.idle();
      expect((await browser.storage.local.get('locks')).locks).toEqual([{ url: 'https://x.com/', windowId: 1, tabId: 9 }]);
    });

    it('closing a locked tab drops its lock; closing with its window keeps it stored', async () => {
      const w = setup();
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, 'https://b.com/'));
      w.svc.lock(1);
      w.svc.lock(2);
      await w.svc.idle();
      w.svc.onTabRemoved(1);
      w.svc.onTabRemoved(2, true);
      await w.svc.idle();
      expect((await browser.storage.local.get('locks')).locks).toEqual([{ url: 'https://b.com/', windowId: 1 }]);
    });

    it('a locked tab reaches the planner as leaveAlone (not persisted in rt)', async () => {
      const w = setup();
      const cfg: Config = withGroupRules([{ id: 'a', name: 'a', enabled: true, match: { url: 'https://a.com/**' }, group: { title: 'A', color: 'red' } }]);
      w.port.addTab(tab(1, 'https://a.com/1'));
      w.port.addTab(tab(2, 'https://a.com/2'));
      w.svc.lock(1);
      await w.svc.idle();
      const r = new Reconciler(w.port, async () => programOf(cfg), { extraLeaveAlone: () => w.svc.lockedTabIds(), debounceMs: 0 });
      await r.flush();
      expect(w.port.state.tabs.find((t) => t.id === 1)!.groupId).toBe(-1);
      expect(w.port.state.tabs.find((t) => t.id === 2)!.groupId).not.toBe(-1);
      expect(((await browser.storage.session.get('rt')).rt as { leaveAlone: number[] }).leaveAlone).toEqual([]);
    });
  });

  describe('dedupe never touches a locked tab', () => {
    it('does not close a locked candidate', async () => {
      const w = setup();
      w.port.addTab(tab(1, PR, { windowId: 2 }));
      w.port.addTab(tab(2, `${PR}/files`));
      w.svc.lock(2);
      const h = new DedupeHandler(w.port, async () => programOf(defaultConfig()), {
        recentlyClosed: w.recentlyClosed, log: new WhyLog(), ask: async () => {},
        isPaused: () => w.svc.isPaused(), isLocked: (id) => w.svc.isLocked(id),
      });
      h.recordCreated(2);
      await h.onCandidate(2, `${PR}/files`, 'pending');
      expect(w.port.state.tabs.map((t) => t.id)).toEqual([1, 2]);
    });

    it('a locked existing tab is kept (only the new tab closes)', async () => {
      const w = setup();
      w.port.addTab(tab(1, PR, { windowId: 2 }));
      w.port.addTab(tab(2, `${PR}/files`));
      w.svc.lock(1);
      const h = new DedupeHandler(w.port, async () => programOf(defaultConfig()), {
        recentlyClosed: w.recentlyClosed, log: new WhyLog(), ask: async () => {},
        isPaused: () => false, isLocked: (id) => w.svc.isLocked(id),
      });
      h.recordCreated(2);
      await h.onCandidate(2, `${PR}/files`, 'pending');
      expect(w.port.state.tabs.map((t) => t.id)).toEqual([1]);
    });
  });

  describe('form edits', () => {
    it('flag is cleared when the tab URL changes', () => {
      const w = setup();
      const t = w.port.addTab(tab(1, PR));
      w.svc.markFormEdited(1, PR);
      expect(w.svc.isFormEdited(1)).toBe(true);
      expect(w.svc.isProtected(t)).toBe(true);
      w.svc.onTabSeen({ id: 1, url: PR, windowId: 1 });
      expect(w.svc.isFormEdited(1)).toBe(true);
      w.svc.onTabSeen({ id: 1, url: 'https://x.com/', windowId: 1 });
      expect(w.svc.isFormEdited(1)).toBe(false);
    });
  });

  describe('undo', () => {
    it('recreates the tab in its window, exempts it once, and schedules the reconciler', async () => {
      const w = setup();
      const id = w.recentlyClosed.add(closedEntry);
      await w.svc.undo(id);
      expect(w.port.calls.filter((c) => c.method === 'createTab')[0]!.args[0]).toMatchObject({ url: PR, windowId: 2 });
      const created = w.port.state.tabs.at(-1)!;
      expect(created.windowId).toBe(2);
      expect(w.exemptOnce).toHaveBeenCalledWith(created.id);
      expect(w.schedule).toHaveBeenCalledWith('undo');
      expect(w.recentlyClosed.list()).toEqual([]);
    });

    it('waits for recentlyClosed to load (freshly woken worker)', async () => {
      await browser.storage.local.set({ recentlyClosed: [{ ...closedEntry, id: 'stored1' }] });
      const w = setup({ recentlyClosed: new RecentlyClosed() });
      await w.svc.undo('stored1');
      expect(w.port.calls.filter((c) => c.method === 'createTab')).toHaveLength(1);
    });

    it('is idempotent: concurrent undo calls open exactly one tab', async () => {
      const w = setup();
      const id = w.recentlyClosed.add(closedEntry);
      await Promise.all([w.svc.undo(id), w.svc.undo(id)]);
      expect(w.port.calls.filter((c) => c.method === 'createTab')).toHaveLength(1);
    });

    it('keeps the entry when createTab fails, disarming the exemption', async () => {
      const disarm = vi.fn();
      const w = setup({ armExemption: vi.fn(() => disarm) });
      const id = w.recentlyClosed.add(closedEntry);
      w.port.failNext('createTab', 'boom');
      await expect(w.svc.undo(id)).rejects.toThrow('boom');
      expect(w.recentlyClosed.list().map((x) => x.id)).toEqual([id]);
      expect(disarm).toHaveBeenCalled();
      expect(w.schedule).not.toHaveBeenCalled();
    });

    describe('create-time race (onCreated fires before tabs.create resolves)', () => {
      for (const mode of ['always-switch', 'ask'] as const) {
        it(`${mode}: the restored duplicate is neither closed nor asked about`, async () => {
          const w = setup();
          const base = defaultConfig();
          const cfg: Config = { ...base, dedupe: { ...base.dedupe, mode } };
          w.port.addTab(tab(1, PR, { windowId: 1 }));
          const ask = vi.fn(async () => {});
          const handler = new DedupeHandler(w.port, async () => programOf(cfg), {
            recentlyClosed: w.recentlyClosed, log: new WhyLog(), ask, isPaused: () => false, isLocked: () => false,
          });
          const svc = new SafetyService(w.port, {
            recentlyClosed: w.recentlyClosed, log: new WhyLog(), schedule: () => {},
            exemptOnce: (id) => handler.exemptOnce(id), armExemption: (u, win) => handler.armExemption(u, win),
            api: w.api, bannerFile: 'b.js',
          });
          const inflight: Promise<void>[] = [];
          const orig = w.port.createTab.bind(w.port);
          w.port.createTab = async (p) => {
            const id = await orig(p);
            // Chrome delivers onCreated (and the navigation) before the create callback resolves.
            handler.recordCreated(id);
            const run = handler.onCandidate(id, p.url, 'pending');
            inflight.push(run);
            await run; // the whole dedupe pass lands before the create callback resolves
            return id;
          };
          const id = w.recentlyClosed.add({ ...closedEntry, windowId: 1 });
          await svc.undo(id);
          await Promise.all(inflight);
          expect(w.port.calls.filter((c) => c.method === 'closeTab')).toEqual([]);
          expect(ask).not.toHaveBeenCalled();
        });
      }
    });

    it('falls back to a normal window when the original is gone; unknown ids are a no-op', async () => {
      const w = setup();
      const id = w.recentlyClosed.add({ ...closedEntry, windowId: 99 });
      await w.svc.undo(id);
      expect(w.port.state.tabs.at(-1)!.windowId).toBe(1);
      await w.svc.undo('nope');
      expect(w.port.calls.filter((c) => c.method === 'createTab')).toHaveLength(1);
    });

    it('end-to-end: restoring a closed duplicate is not closed again, then regrouped', async () => {
      const w = setup();
      const cfg: Config = withGroupRules([{ id: 'gh', name: 'gh', enabled: true, match: { url: 'https://github.com/**' }, group: { title: 'GH', color: 'blue' } }]);
      w.port.addTab(tab(1, PR, { windowId: 1 }));
      const handler = new DedupeHandler(w.port, async () => programOf(cfg), {
        recentlyClosed: w.recentlyClosed, log: new WhyLog(), ask: async () => {},
        isPaused: () => false, isLocked: () => false,
      });
      const rec = new Reconciler(w.port, async () => programOf(cfg), { debounceMs: 0 });
      const svc = new SafetyService(w.port, {
        recentlyClosed: w.recentlyClosed, log: new WhyLog(), schedule: (r) => rec.schedule(r),
        exemptOnce: (id) => handler.exemptOnce(id), armExemption: (u, win) => handler.armExemption(u, win), api: w.api, bannerFile: 'b.js',
      });
      const id = w.recentlyClosed.add({ ...closedEntry, windowId: 1 });
      await svc.undo(id);
      const restored = w.port.state.tabs.find((t) => t.id !== 1)!;
      handler.recordCreated(restored.id);
      await handler.onCandidate(restored.id, PR, 'pending');
      await handler.onCandidate(restored.id, PR, 'committed');
      expect(w.port.state.tabs.map((t) => t.id)).toContain(restored.id);
      expect(w.port.calls.filter((c) => c.method === 'closeTab')).toHaveLength(0);
      await vi.waitFor(() => expect(w.port.state.tabs.find((t) => t.id === restored.id)!.groupId).not.toBe(-1));
      // Navigating the restored tab to another duplicate afterwards is deduped again.
      w.port.addTab(tab(500, 'https://github.com/acme/api/pull/2', { windowId: 2 }));
      w.port.state.tabs.find((t) => t.id === restored.id)!.url = 'https://github.com/acme/api/pull/2';
      await handler.onCandidate(restored.id, 'https://github.com/acme/api/pull/2', 'pending');
      expect(w.port.calls.filter((c) => c.method === 'closeTab')).toHaveLength(1);
    });
  });

  describe('undo toast', () => {
    const focused = (o: Partial<TabSnap> = {}): TabSnap => ({ ...tab(1, PR), groupId: -1, index: 0, ...o }) as TabSnap;

    it('banner when host + scripting permissions are present', async () => {
      const w = setup();
      w.port.granted = new Set();
      vi.spyOn(w.port, 'hasPermission').mockResolvedValue(true);
      await w.svc.toast('rc1', closedEntry, focused());
      expect(w.api.executeScript).toHaveBeenCalledWith(1, '/content-scripts/banner.js');
      expect(w.api.sendMessage).toHaveBeenCalledWith(1, {
        type: 'banner.show', payload: { kind: 'undo', entryId: 'rc1', text: expect.stringContaining('PR') },
      });
      expect(w.api.createNotification).not.toHaveBeenCalled();
    });

    it('never injects into discarded or frozen tabs; falls back to a notification', async () => {
      const w = setup();
      vi.spyOn(w.port, 'hasPermission').mockResolvedValue(true);
      await w.svc.toast('rc1', closedEntry, focused({ discarded: true }));
      await w.svc.toast('rc2', closedEntry, focused({ frozen: true }));
      expect(w.api.executeScript).not.toHaveBeenCalled();
      expect(w.api.createNotification).toHaveBeenCalledWith('undo:rc1', expect.objectContaining({ buttons: [{ title: 'Undo' }] }));
      expect(w.api.createNotification).toHaveBeenCalledWith('undo:rc2', expect.anything());
    });

    it('notification when the banner is not acked; nothing when no permissions', async () => {
      const w = setup();
      vi.spyOn(w.port, 'hasPermission').mockImplementation(async (p) => !p.origins && !p.permissions?.includes('scripting'));
      await w.svc.toast('rc1', closedEntry, focused());
      expect(w.api.createNotification).toHaveBeenCalledTimes(1);
      vi.spyOn(w.port, 'hasPermission').mockResolvedValue(false);
      await w.svc.toast('rc2', closedEntry, focused());
      expect(w.api.createNotification).toHaveBeenCalledTimes(1);
    });

    it('never throws', async () => {
      const w = setup();
      vi.spyOn(w.port, 'hasPermission').mockResolvedValue(true);
      w.api.executeScript.mockRejectedValue(new Error('x'));
      w.api.createNotification.mockRejectedValue(new Error('y'));
      await expect(w.svc.toast('rc1', closedEntry, focused())).resolves.toBeUndefined();
    });
  });
});
