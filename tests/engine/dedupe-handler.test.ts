import { describe, expect, it, vi } from 'vitest';
import { DedupeHandler, SESSION_MARKER, type DedupeDeps } from '../../src/engine/dedupe-handler';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';
import type { Rule } from '../../src/core/lang/types';
import { withGroupRules, programOf } from '../helpers/config';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;
const PR = 'https://github.com/acme/api/pull/1';
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});

function setup(cfg: Config = defaultConfig(), over: Partial<DedupeDeps> = {}) {
  const port = new FakeBrowserPort();
  port.addWindow(1);
  port.addWindow(2);
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const closed: Parameters<DedupeDeps['recentlyClosed']['add']>[0][] = [];
  const logs: Parameters<DedupeDeps['log']['add']>[0][] = [];
  const ask = vi.fn(async () => {});
  const deps: DedupeDeps = {
    recentlyClosed: { add: (e) => { closed.push(e); return `rc${closed.length}`; } },
    log: { add: (e) => { logs.push(e); } },
    ask,
    isPaused: () => false,
    isLocked: () => false,
    now: clock.now,
    ...over,
  };
  const h = new DedupeHandler(port, async () => programOf(cfg), deps);
  const calls = (m: string) => port.calls.filter((c) => c.method === m).map((c) => c.args);
  return { port, h, clock, closed, logs, ask, calls };
}

describe('DedupeHandler', () => {
  it('always-switch closes the NEW tab and focuses the existing one', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR, { windowId: 2 }));
    w.port.addTab(tab(2, `${PR}/files`, { active: true }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}/files`, 'pending');
    expect(w.calls('closeTab')).toEqual([[2]]);
    expect(w.calls('focusTab')).toEqual([[1, 2, undefined]]);
    expect(w.port.state.tabs.map((x) => x.id)).toEqual([1]);
    expect(w.closed).toEqual([expect.objectContaining({ url: `${PR}/files`, title: 't2', windowId: 1, reason: 'duplicate' })]);
    expect(w.logs[0]!.detail).toBe('Closed duplicate of tab 1 (t1)');
    expect(w.logs[0]!.tabId).toBe(2);
  });

  it('records the new tab group title and rule id', async () => {
    const cfg: Config = withGroupRules([{ id: 'gh', name: 'gh', enabled: true, match: { url: 'github.com/**' }, group: { title: 'GH', color: 'blue' } }]);
    const w = setup(cfg);
    w.port.addTab(tab(1, PR));
    w.port.addGroup({ id: 50, windowId: 1, title: 'GH', color: 'blue', collapsed: false });
    w.port.addTab(tab(2, PR, { groupId: 50 }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.closed[0]).toMatchObject({ groupTitle: 'GH', ruleId: 'user/gh' });
  });

  it('followFragment navigates the existing tab to the new fragment', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, `${PR}#discussion_r1`));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}#discussion_r1`, 'pending');
    expect(w.calls('focusTab')).toEqual([[1, 1, `${PR}#discussion_r1`]]);
  });

  it('followFragment does nothing when the existing tab already has that fragment', async () => {
    const w = setup();
    w.port.addTab(tab(1, `${PR}#x`));
    w.port.addTab(tab(2, `${PR}#x`));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}#x`, 'pending');
    expect(w.calls('focusTab')).toEqual([[1, 1, undefined]]);
  });

  it('followFragment off -> no navigation', async () => {
    const cfg = defaultConfig();
    cfg.dedupe.followFragment = false;
    const w = setup(cfg);
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, `${PR}#y`));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}#y`, 'pending');
    expect(w.calls('focusTab')).toEqual([[1, 1, undefined]]);
  });

  // Review Focus #3
  it('redirect: pending slack.com/redirect (no match), then committed github URL closes the new tab', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    const redirect = 'https://slack.com/redirect?url=https%3A%2F%2Fgithub.com%2Facme%2Fapi%2Fpull%2F1';
    w.port.addTab(tab(2, '', { pendingUrl: redirect }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, redirect, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
    const t2 = w.port.state.tabs.find((x) => x.id === 2)!;
    t2.url = PR;
    delete t2.pendingUrl;
    w.clock.advance(600);
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([[2]]);
    expect(w.calls('focusTab')).toEqual([[1, 1, undefined]]);
  });

  it('same tab firing pending and committed for the same key is handled once', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await Promise.all([w.h.onCandidate(2, PR, 'pending'), w.h.onCandidate(2, PR, 'committed')]);
    expect(w.calls('closeTab')).toEqual([[2]]);
    expect(w.closed).toHaveLength(1);
  });

  it('ask mode is handled once per tab+key', async () => {
    const cfg = defaultConfig();
    cfg.dedupe.mode = 'ask';
    const w = setup(cfg);
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.ask).toHaveBeenCalledTimes(1);
    expect(w.ask.mock.calls[0]).toEqual([expect.objectContaining({ id: 2 }), expect.objectContaining({ id: 1 })]);
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('off mode does nothing', async () => {
    const cfg = defaultConfig();
    cfg.dedupe.mode = 'off';
    const w = setup(cfg);
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
    expect(w.ask).not.toHaveBeenCalled();
  });

  it('rule dedupe override (off) wins over global always-switch', async () => {
    const cfg: Config = withGroupRules([{ id: 'gh', name: 'gh', enabled: true, match: { url: 'github.com/**' }, group: { title: 'GH', color: 'blue' }, dedupe: 'off' }]);
    const w = setup(cfg);
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('a reload of an old tab -> no action', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    await w.h.onCandidate(2, PR, 'pending');
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('an old tab with unknown creation time is not new for pending events', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('old established tab clicking a link to a URL open elsewhere -> no action', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, 'https://a.com/'));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, 'https://a.com/', 'committed');
    w.clock.advance(60_000);
    w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
    await w.h.onCandidate(2, PR, 'pending');
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('old tab of unknown age (pre-worker) navigating -> no action', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('old NTP tab (60 s, never had a real URL) typing a duplicate URL -> closed, existing focused', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR, { windowId: 2 }));
    w.port.addTab(tab(2, 'chrome://newtab/'));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, 'chrome://newtab/', 'committed');
    w.clock.advance(60_000);
    w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([[2]]);
    expect(w.calls('focusTab')).toEqual([[1, 2, undefined]]);
  });

  it('NTP tab seeded at worker start (pre-existing) typing a duplicate URL -> closed', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, 'chrome://newtab/'));
    w.h.seed(w.port.state.tabs);
    w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([[2]]);
  });

  it('seed ignores tabs on real URLs', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.seed(w.port.state.tabs);
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('old tab client-redirecting to a duplicate -> no action', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, ''));
    w.h.recordCreated(2);
    w.clock.advance(60_000);
    const redirect = 'https://slack.com/redirect?u=1';
    w.port.state.tabs.find((x) => x.id === 2)!.url = redirect;
    await w.h.onCandidate(2, redirect, 'committed');
    w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
    await w.h.onCandidate(2, PR, 'pending');
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('back/forward in an old established tab -> no action', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, 'https://a.com/'));
    await w.h.onCandidate(2, 'https://a.com/', 'committed');
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('concurrency: two young same-URL tabs -> exactly one close, of the newer; older survives', async () => {
    const w = setup();
    w.port.addTab(tab(5, PR));
    w.port.addTab(tab(6, PR));
    w.h.recordCreated(5);
    w.h.recordCreated(6);
    await Promise.all([w.h.onCandidate(5, PR, 'pending'), w.h.onCandidate(6, PR, 'pending')]);
    expect(w.calls('closeTab')).toEqual([[6]]);
    expect(w.calls('focusTab')).toEqual([[5, 1, undefined]]);
    expect(w.port.state.tabs.map((x) => x.id)).toEqual([5]);
  });

  it('concurrency: reversed event order gives the same result', async () => {
    const w = setup();
    w.port.addTab(tab(5, PR));
    w.port.addTab(tab(6, PR));
    w.h.recordCreated(5);
    w.h.recordCreated(6);
    await Promise.all([
      w.h.onCandidate(6, PR, 'pending'), w.h.onCandidate(5, PR, 'pending'),
      w.h.onCandidate(6, PR, 'committed'), w.h.onCandidate(5, PR, 'committed'),
    ]);
    expect(w.calls('closeTab')).toEqual([[6]]);
    expect(w.port.state.tabs.map((x) => x.id)).toEqual([5]);
  });

  it('session restore: pending candidates within 10 s of startup are ignored', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.noteStartup();
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('after the startup grace period new tabs are deduped again', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.noteStartup();
    w.clock.advance(10_000);
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([[2]]);
  });

  describe('order-independent startup grace (session marker)', () => {
    const store = (initial: Record<string, unknown> = {}) => {
      const data = { ...initial };
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      return {
        data, release,
        session: {
          get: async (k: string) => { await gate; return data[k]; },
          set: async (k: string, v: unknown) => { data[k] = v; },
        },
      };
    };

    it('(a) no marker: recordCreated + candidates before noteStartup (and before the read resolves) -> nothing closed', async () => {
      const st = store();
      const w = setup(defaultConfig(), { session: st.session });
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, PR));
      w.h.recordCreated(2);
      const p = Promise.all([w.h.onCandidate(2, PR, 'pending'), w.h.onCandidate(2, PR, 'committed')]);
      st.release();
      await p;
      w.h.noteStartup();
      expect(w.calls('closeTab')).toEqual([]);
      expect(st.data[SESSION_MARKER]).toBeDefined();
    });

    it('(a) a restored tab created in the grace stays non-new after the grace ends', async () => {
      const st = store();
      const w = setup(defaultConfig(), { session: st.session });
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, 'chrome://newtab/'));
      w.h.recordCreated(2);
      st.release();
      await w.h.ready;
      w.clock.advance(11_000);
      w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
      await w.h.onCandidate(2, PR, 'pending');
      expect(w.calls('closeTab')).toEqual([]);
    });

    it('(b) marker present (worker restart mid-session) -> no grace, normal dedupe after the read resolves', async () => {
      const st = store({ [SESSION_MARKER]: 1 });
      const w = setup(defaultConfig(), { session: st.session });
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, PR));
      w.h.recordCreated(2);
      const p = w.h.onCandidate(2, PR, 'pending');
      await new Promise((r) => setTimeout(r, 0));
      expect(w.calls('snapshot')).toEqual([]); // queued, not decided, until the read resolves
      st.release();
      await p;
      expect(w.calls('closeTab')).toEqual([[2]]);
    });

    it('(c) committed candidate during the grace -> ignored', async () => {
      const st = store();
      st.release();
      const w = setup(defaultConfig(), { session: st.session });
      await w.h.ready;
      w.clock.advance(5_000);
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, 'chrome://newtab/'));
      w.h.seed(w.port.state.tabs); // fresh NTP: would be deduped outside the grace
      w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
      await w.h.onCandidate(2, PR, 'committed');
      expect(w.calls('closeTab')).toEqual([]);
    });

    it('a failing session read is treated as a fresh start (grace)', async () => {
      const w = setup(defaultConfig(), {
        session: { get: async () => { throw new Error('no session'); }, set: async () => {} },
      });
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, PR));
      w.h.recordCreated(2);
      await w.h.onCandidate(2, PR, 'pending');
      expect(w.calls('closeTab')).toEqual([]);
    });

    it('runtime.onStartup during a running grace extends it', async () => {
      const st = store();
      st.release();
      const w = setup(defaultConfig(), { session: st.session });
      await w.h.ready;
      w.clock.advance(8_000);
      w.h.noteStartup();
      w.clock.advance(5_000);
      w.port.addTab(tab(1, PR));
      w.port.addTab(tab(2, PR));
      w.h.recordCreated(2);
      await w.h.onCandidate(2, PR, 'pending');
      expect(w.calls('closeTab')).toEqual([]);
    });
  });

  it('onReplaced: an added tab that is already established is not made fresh', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(3, 'https://a.com/'));
    await w.h.onCandidate(3, 'https://a.com/', 'committed'); // 3 established
    w.h.seed([{ ...w.port.state.tabs[0]!, id: 2, url: 'chrome://newtab/' }]); // 2 fresh, no creation time
    w.h.onReplaced(3, 2);
    w.port.state.tabs.find((x) => x.id === 3)!.url = PR;
    await w.h.onCandidate(3, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it.each(['', 'not a url', 'chrome://settings/', 'about:srcdoc'])('seed does not treat %j as a new-tab page', async (u) => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, u));
    w.h.seed(w.port.state.tabs);
    w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it.each(['chrome://newtab/', 'chrome://new-tab-page/', 'about:blank'])('seed treats %s as fresh', async (u) => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, u));
    w.h.seed(w.port.state.tabs);
    w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([[2]]);
  });

  it.each([{ discarded: true }, { status: 'unloaded' }])('tab created with %o is never new', async (info) => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2, info);
    await w.h.onCandidate(2, PR, 'pending');
    await w.h.onCandidate(2, PR, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('onReplaced: added tab inherits freshness; removed id state is cleared', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(3, PR));
    w.h.recordCreated(2);
    w.h.onReplaced(3, 2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
    await w.h.onCandidate(3, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([[3]]);
  });

  it('re-check: existing tab navigated away before close -> skip', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    const orig = w.port.snapshot.bind(w.port);
    let n = 0;
    w.port.snapshot = async () => {
      if (++n === 2) w.port.state.tabs.find((x) => x.id === 1)!.url = 'https://elsewhere.com/';
      return orig();
    };
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('re-check: candidate pinned before close -> skip', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    const orig = w.port.snapshot.bind(w.port);
    let n = 0;
    w.port.snapshot = async () => {
      if (++n === 2) w.port.state.tabs.find((x) => x.id === 2)!.pinned = true;
      return orig();
    };
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('re-check: candidate locked before close -> skip', async () => {
    let lockedNow = false;
    const w = setup(defaultConfig(), { isLocked: (id) => id === 2 && lockedNow });
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    const orig = w.port.snapshot.bind(w.port);
    let n = 0;
    w.port.snapshot = async () => {
      if (++n === 2) lockedNow = true;
      return orig();
    };
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('paused -> no action', async () => {
    const w = setup(defaultConfig(), { isPaused: () => true });
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('locked candidate -> no action', async () => {
    const w = setup(defaultConfig(), { isLocked: (id) => id === 2 });
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('a locked existing tab is still kept and focused', async () => {
    const w = setup(defaultConfig(), { isLocked: (id) => id === 1 });
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([[2]]);
  });

  it('exempt URLs -> no action', async () => {
    const w = setup();
    w.port.addTab(tab(1, 'chrome://newtab'));
    w.port.addTab(tab(2, 'chrome://newtab'));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, 'chrome://newtab', 'pending');
    expect(w.port.calls).toEqual([]);
  });

  it('skips closing when the user navigated away before the close (fresh re-check)', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    const orig = w.port.snapshot.bind(w.port);
    let n = 0;
    w.port.snapshot = async () => {
      if (++n === 2) w.port.state.tabs.find((x) => x.id === 2)!.url = 'https://elsewhere.com/';
      return orig();
    };
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
    expect(w.closed).toEqual([]);
  });

  it('candidate gone -> no action', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('creation-time age rule expires after 10 s (once the tab has committed a real URL)', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, 'https://a.com/'));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, 'https://a.com/', 'committed');
    w.clock.advance(10_000);
    w.port.state.tabs.find((x) => x.id === 2)!.url = PR;
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('onRemoved prunes creation time and handled memo', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    w.h.onRemoved(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('a new key for the same tab is evaluated again', async () => {
    const cfg = defaultConfig();
    cfg.dedupe.mode = 'ask';
    const w = setup(cfg);
    const B = 'https://b.com/x';
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(3, B));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    w.port.state.tabs.find((x) => x.id === 2)!.url = B;
    await w.h.onCandidate(2, B, 'committed');
    expect(w.ask).toHaveBeenCalledTimes(2);
  });

  it('same-window scope ignores duplicates in other windows', async () => {
    const cfg = defaultConfig();
    cfg.dedupe.scope = 'same-window';
    const w = setup(cfg);
    w.port.addTab(tab(1, PR, { windowId: 2 }));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('never closes the existing tab (closeTab only ever targets the candidate)', async () => {
    const w = setup();
    for (let i = 1; i <= 4; i++) w.port.addTab(tab(i, PR));
    for (const id of [2, 3, 4]) {
      w.h.recordCreated(id);
      await w.h.onCandidate(id, PR, 'pending');
    }
    expect(w.calls('closeTab')).toEqual([[2], [3], [4]]);
    expect(w.port.state.tabs.map((x) => x.id)).toEqual([1]);
  });

  it('ask mode with a matching alwaysSwitchSites pattern closes the new tab without asking', async () => {
    const cfg = defaultConfig();
    cfg.dedupe.mode = 'ask';
    cfg.dedupe.alwaysSwitchSites = ['https://github.com/*'];
    const w = setup(cfg);
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, `${PR}/files`, { active: true }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}/files`, 'pending');
    expect(w.ask).not.toHaveBeenCalled();
    expect(w.calls('closeTab')).toEqual([[2]]);
  });

  it('ask mode with a non-matching alwaysSwitchSites pattern still asks', async () => {
    const cfg = defaultConfig();
    cfg.dedupe.mode = 'ask';
    cfg.dedupe.alwaysSwitchSites = ['https://example.com/*'];
    const w = setup(cfg);
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, `${PR}/files`, { active: true }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}/files`, 'pending');
    expect(w.ask).toHaveBeenCalledTimes(1);
    expect(w.calls('closeTab')).toEqual([]);
  });
});

describe('DedupeHandler onClosed / exemptOnce', () => {
  it('reports the close (entry id, entry, focused tab) after closing', async () => {
    const onClosed = vi.fn();
    const w = setup(undefined, { onClosed });
    w.port.addTab(tab(1, PR, { windowId: 2 }));
    w.port.addTab(tab(2, `${PR}/files`, { active: true }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}/files`, 'pending');
    expect(onClosed).toHaveBeenCalledWith('rc1', expect.objectContaining({ url: `${PR}/files` }), expect.objectContaining({ id: 1 }));
  });

  it('exemptOnce skips the restored tab until its URL changes', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR, { windowId: 2 }));
    w.port.addTab(tab(2, `${PR}/files`, { active: true }));
    w.port.addTab(tab(3, 'https://example.com/a', { windowId: 2 }));
    w.h.recordCreated(2);
    w.h.exemptOnce(2);
    await w.h.onCandidate(2, `${PR}/files`, 'pending');
    await w.h.onCandidate(2, `${PR}/files`, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
    w.port.state.tabs.find((t) => t.id === 2)!.url = 'https://example.com/a';
    await w.h.onCandidate(2, 'https://example.com/a', 'pending');
    expect(w.calls('closeTab')).toEqual([[2]]);
  });
});

describe('DedupeHandler: compiled program (M2 T6)', () => {
  const v2 = (rules: Rule[], o: Partial<Config> = {}): Config => ({ ...defaultConfig(), rules, ...o });
  const dd = (dedupe: Rule['actions'][number] & { dedupe: object }): Rule => ({ id: 'd', name: 'D', enabled: true, match: { url: 'github.com/**' }, actions: [dedupe] });

  it('without the github-prs recipe, /pull/1/files is not a duplicate of /pull/1', async () => {
    const c = defaultConfig();
    const w = setup({ ...c, recipes: c.recipes.map((r) => (r.id === 'github-prs' ? { ...r, enabled: false } : r)) });
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, `${PR}/files`));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}/files`, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('a dedupe-only rule override applies (R8: first dedupe action wins) and is recorded as the rule', async () => {
    const w = setup(v2([dd({ dedupe: { followFragment: false } })]));
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, `${PR}#discussion_r1`));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, `${PR}#discussion_r1`, 'pending');
    expect(w.calls('focusTab')).toEqual([[1, 1, undefined]]);
    expect(w.closed[0]).toMatchObject({ ruleId: 'user/d' });
  });

  it('keepFragment override: tabs on different fragments are not duplicates', async () => {
    const w = setup(v2([dd({ dedupe: { keepFragment: true } })]));
    w.port.addTab(tab(1, `${PR}#a`));
    w.port.addTab(tab(2, `${PR}#b`));
    w.port.addTab(tab(3, `${PR}#a`));
    w.h.recordCreated(2);
    w.h.recordCreated(3);
    await w.h.onCandidate(2, `${PR}#b`, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
    await w.h.onCandidate(3, `${PR}#a`, 'pending');
    expect(w.calls('closeTab')).toEqual([[3]]);
  });

  it('mode override from a rule matched only through its opener', async () => {
    const r: Rule = { id: 'o', name: 'o', enabled: true, match: { opener: { url: 'a.com/*' } }, actions: [{ dedupe: { mode: 'off' } }] };
    const w = setup(v2([r]));
    w.port.addTab(tab(9, 'https://a.com/x'));
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR, { openerTabId: 9 }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([]);
  });
});

describe('DedupeHandler: dry-run dedupe actions', () => {
  it('a dry-run rule with dedupe mode off has no live effect: the global always-switch applies', async () => {
    const r: Rule = { id: 'd', name: 'D', enabled: true, dryRun: true, match: { url: 'github.com/**' }, actions: [{ dedupe: { mode: 'off' } }] };
    const w = setup({ ...defaultConfig(), rules: [r] });
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, PR));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, PR, 'pending');
    expect(w.calls('closeTab')).toEqual([[2]]);
    expect(w.closed[0]?.ruleId).toBeUndefined();
  });
});
