import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { AnchorService } from '../../src/engine/anchors';
import { DedupeHandler } from '../../src/engine/dedupe-handler';
import { Reconciler } from '../../src/engine/reconciler';
import { RT_KEY, type RuntimeState } from '../../src/engine/state';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';
import type { GroupAction, Rule } from '../../src/core/lang/types';
import { programOf } from '../helpers/config';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;
const PR = 'https://github.com/acme/api/pull/1';
const HOME = 'https://github.com/acme/api';
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});

/** One user rule: github PRs of `acme/:repo` grouped by repo, anchored at the repo home. */
function cfgOf(group: Partial<GroupAction> = {}, rule: Partial<Rule> = {}): Config {
  const r: Rule = {
    id: 'pr', name: 'PRs', enabled: true, match: { url: 'github.com/acme/:repo/pull/*' },
    actions: [{ group: { title: '{repo}', color: 'blue', anchors: ['https://github.com/acme/{repo}'], ...group } }],
    ...rule,
  };
  const base = defaultConfig();
  return { ...base, rules: [...base.rules, r], order: [...base.order, 'user/pr'] };
}

function setup(cfg: Config = cfgOf(), windows: number[] = [1]) {
  const port = new FakeBrowserPort();
  for (const w of windows) port.addWindow(w);
  const program = { c: cfg };
  const getProgram = async () => programOf(program.c);
  const logs: { action: string; detail: string }[] = [];
  const log = { add: (e: { action: string; detail: string }) => { logs.push(e); } };
  const armed: [string, number | undefined][] = [];
  // eslint-disable-next-line prefer-const
  let anchors: AnchorService;
  const r = new Reconciler(port, getProgram, {
    log, anchors: { onGroupCreated: (...a) => anchors.onGroupCreated(...a) },
  });
  anchors = new AnchorService(port, {
    state: () => r.liveState(), log,
    armExemption: (url, windowId) => { armed.push([url, windowId]); return () => {}; },
  });
  const calls = (m: string) => port.calls.filter((c) => c.method === m).map((c) => c.args);
  const groupOf = (id: number) => {
    const gid = port.state.tabs.find((t) => t.id === id)?.groupId;
    return port.state.groups.find((g) => g.id === gid)?.title;
  };
  const idOf = (url: string) => port.state.tabs.filter((t) => t.url === url).map((t) => t.id);
  return { port, r, anchors, logs, armed, calls, groupOf, idOf, program, getProgram };
}

describe('AnchorService', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('a new group opens its rendered anchor in the background, inside the group', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    expect(w.calls('createTab')).toEqual([[{ url: HOME, windowId: 1, active: false }]]);
    const [id] = w.idOf(HOME);
    expect(w.groupOf(1)).toBe('api');
    expect(w.groupOf(id!)).toBe('api');
    expect(w.anchors.isAnchor(id!)).toBe(true);
    expect(w.anchors.isAnchor(1)).toBe(false);
    // armed before the tab exists, so dedupe does not treat the new anchor tab as a duplicate (R11)
    expect(w.armed).toEqual([[HOME, 1]]);
    // persisted in RuntimeState
    const rt = (await browser.storage.session.get(RT_KEY))[RT_KEY] as RuntimeState;
    expect(rt.anchors).toEqual([{ tabId: id, windowId: 1, title: 'api', url: HOME, groupId: w.port.state.groups.find((g) => g.title === 'api')!.id }]);
    // the anchor's URL does not match the rule: strict must not ungroup it on later flushes (R21)
    await w.r.flush();
    expect(w.groupOf(id!)).toBe('api');
    expect(w.calls('ungroup')).toEqual([]);
  });

  it('an existing tab with the anchor URL in the window is moved into the group, not created', async () => {
    const w = setup();
    w.port.addTab(tab(1, `${HOME}#readme`));
    w.port.addTab(tab(2, PR));
    await w.r.flush();
    expect(w.calls('createTab')).toEqual([]);
    expect(w.groupOf(1)).toBe('api');
    expect(w.groupOf(2)).toBe('api');
    expect(w.anchors.isAnchor(1)).toBe(true);
  });

  it('a tab with the anchor URL in another window is not moved; a new anchor is created', async () => {
    const w = setup(cfgOf(), [1, 2]);
    w.port.addTab(tab(1, HOME, { windowId: 2 }));
    w.port.addTab(tab(2, PR));
    await w.r.flush();
    expect(w.calls('createTab')).toEqual([[{ url: HOME, windowId: 1, active: false }]]);
    expect(w.groupOf(1)).toBeUndefined();
  });

  it('an adopted group (after a restart) opens no anchors', async () => {
    const w = setup();
    w.port.addGroup({ id: 50, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    w.port.addTab(tab(1, PR, { groupId: 50 }));
    w.port.addTab(tab(2, `${PR}/files`));
    await w.r.flush();
    expect(w.groupOf(2)).toBe('api');
    expect(w.calls('createTab')).toEqual([]);
  });

  it('a closed anchor is not reopened until its group is removed and created again', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    await w.port.closeTab(id!);
    await w.anchors.onTabRemoved(id!, false);
    expect(w.anchors.isAnchor(id!)).toBe(false);
    await w.r.flush();
    expect(w.calls('createTab')).toHaveLength(1);
    // The group goes away and comes back while the dismissal stands (no onRemoved seen): still not reopened.
    await w.port.closeTab(1);
    w.port.addTab(tab(3, PR));
    await w.r.flush();
    expect(w.groupOf(3)).toBe('api');
    expect(w.calls('createTab')).toHaveLength(1);
    // tabGroups.onRemoved clears the dismissal: the next creation opens the anchor again.
    await w.port.closeTab(3);
    await w.anchors.onGroupRemoved({ windowId: 1, title: 'api' });
    w.port.addTab(tab(4, PR));
    await w.r.flush();
    expect(w.calls('createTab')).toHaveLength(2);
    expect(w.groupOf(w.idOf(HOME)[0]!)).toBe('api');
    const rt = (await browser.storage.session.get(RT_KEY))[RT_KEY] as RuntimeState;
    expect(rt.anchorsDismissed).toEqual([]);
  });

  it('an anchor closed with its window is not dismissed', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    await w.anchors.onTabRemoved(id!, true);
    expect(w.anchors.isAnchor(id!)).toBe(false);
    expect((await w.r.liveState()).anchorsDismissed.size).toBe(0);
  });

  it('group removal drops anchor entries of tabs that survived it (ungrouped)', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    await w.anchors.onGroupRemoved({ windowId: 1, title: 'api' });
    expect(w.anchors.isAnchor(id!)).toBe(false);
  });

  it('anchors survive a worker restart (RuntimeState)', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    const r2 = new Reconciler(w.port, w.getProgram);
    const a2 = new AnchorService(w.port, { state: () => r2.liveState() });
    await a2.ready;
    expect(a2.isAnchor(id!)).toBe(true);
  });

  it('a replaced tab keeps its anchor status', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    await w.anchors.onTabReplaced(99, id!);
    expect(w.anchors.isAnchor(99)).toBe(true);
    expect(w.anchors.isAnchor(id!)).toBe(false);
  });

  it('only http(s) anchors open; others are skipped and logged', async () => {
    const w = setup(cfgOf({ anchors: ['javascript:alert(1)', 'chrome://settings', 'https://example.com/{repo}'] }));
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    expect(w.calls('createTab')).toEqual([[{ url: 'https://example.com/api', windowId: 1, active: false }]]);
    expect(w.logs.filter((l) => l.action === 'anchor-skipped')).toHaveLength(2);
  });

  it('a dry-run group rule opens no anchors (R48: it falls through, its group is never created)', async () => {
    const w = setup(cfgOf({}, { dryRun: true }));
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    expect(w.calls('createTab')).toEqual([]);
    expect(w.calls('group')).toEqual([]);
  });

  it('an anchor that navigates away is planned like any tab again', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    w.port.state.tabs.find((t) => t.id === id)!.url = 'https://other.example/';
    await w.r.flush();
    expect(w.groupOf(id!)).toBeUndefined(); // strict: no longer matches and no longer at its anchor URL
  });

  it('dedupe never closes an anchor', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    w.port.addTab(tab(2, HOME, { windowId: 1 })); // an older-looking duplicate elsewhere is irrelevant: anchor is new
    const h = new DedupeHandler(w.port, w.getProgram, {
      recentlyClosed: { add: () => 'rc' }, log: { add: () => {} }, ask: vi.fn(async () => {}),
      isPaused: () => false, isLocked: () => false, isAnchor: (t) => w.anchors.isAnchor(t),
    });
    h.recordCreated(id!);
    await h.onCandidate(id!, HOME, 'committed');
    expect(w.calls('closeTab')).toEqual([]);
    // the existing (target) side of a dedupe is harmless: a new duplicate of the anchor is closed, the anchor kept
    w.port.addTab(tab(3, HOME));
    h.recordCreated(3);
    await h.onCandidate(3, HOME, 'committed');
    expect(w.calls('closeTab')).toEqual([[3]]);
    expect(w.port.state.tabs.some((t) => t.id === id)).toBe(true);
  });
});

describe('AnchorService: failures, renames and user decisions (M2 polish P1)', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('a tab the user chose to leave alone is not reused as the anchor; a new one is opened', async () => {
    const w = setup();
    w.port.addTab(tab(1, HOME));
    w.port.addTab(tab(2, PR));
    (await w.r.liveState()).leaveAlone.add(1);
    await w.r.flush();
    expect(w.calls('createTab')).toEqual([[{ url: HOME, windowId: 1, active: false }]]);
    expect(w.anchors.isAnchor(1)).toBe(false);
    expect(w.groupOf(1)).toBeUndefined();
  });

  it('a failed anchor tab open is logged; the group is still created', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.failNext('createTab', 'no window');
    await w.r.flush();
    expect(w.groupOf(1)).toBe('api');
    expect(w.idOf(HOME)).toEqual([]);
    expect(w.logs).toContainEqual(expect.objectContaining({ action: 'anchor-failed' }));
  });

  it('an anchor whose join into the group failed is not kept as an anchor (it would be stranded ungrouped)', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    const group = w.port.group.bind(w.port);
    vi.spyOn(w.port, 'group').mockImplementation(async (ids, o) => {
      if (o.groupId !== undefined) throw new Error('join failed');
      return group(ids, o);
    });
    await w.r.flush();
    const [id] = w.idOf(HOME);
    expect(w.groupOf(1)).toBe('api');
    expect(w.anchors.isAnchor(id!)).toBe(false);
    expect(w.logs).toContainEqual(expect.objectContaining({ action: 'anchor-failed', detail: expect.stringContaining('join failed') }));
  });

  it('a group whose title could not be set logs that its anchors were not opened', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.failNext('updateGroup', 'title failed');
    await w.r.flush().catch(() => {});
    expect(w.calls('createTab')).toEqual([]);
    expect(w.logs).toContainEqual(expect.objectContaining({ action: 'anchor-skipped', detail: expect.stringContaining('could not be titled') }));
  });

  it('a renamed group keeps its anchors: removing it by its new title drops them', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    const g = w.port.state.groups.find((x) => x.title === 'api')!;
    g.title = 'API work';
    await w.anchors.onGroupUpdated({ id: g.id, windowId: 1, title: 'API work' });
    await w.anchors.onGroupRemoved({ windowId: 1, title: 'API work' });
    expect(w.anchors.isAnchor(id!)).toBe(false);
  });
});

describe('AnchorService: following a renamed group (by group id)', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const WEB_PR = 'https://github.com/acme/web/pull/2';
  const WEB_HOME = 'https://github.com/acme/web';

  it('an anchor dragged into another group is not retitled when that group is collapsed', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    w.port.addTab(tab(2, WEB_PR));
    await w.r.flush();
    const [apiHome] = w.idOf(HOME);
    const web = w.port.state.groups.find((x) => x.title === 'web')!;
    w.port.state.tabs.find((t) => t.id === apiHome)!.groupId = web.id; // the user drags it into "web"
    web.collapsed = true;
    await w.anchors.onGroupUpdated({ id: web.id, windowId: 1, title: 'web' });
    expect((await w.r.liveState()).anchors.find((a) => a.tabId === apiHome)?.title).toBe('api');
    // Removing "api" drops its anchor, wherever the tab went.
    await w.anchors.onGroupRemoved({ windowId: 1, title: 'api' });
    expect(w.anchors.isAnchor(apiHome!)).toBe(false);
    expect(w.anchors.isAnchor(w.idOf(WEB_HOME)[0]!)).toBe(true);
  });

  it('an anchor record stored without a group id still follows a rename of the group it is in (as before)', async () => {
    await browser.storage.session.set({ [RT_KEY]: { anchors: [{ tabId: 5, windowId: 1, title: 'api', url: HOME }] } });
    const w = setup();
    w.port.addGroup({ id: 50, windowId: 1, title: 'API', color: 'blue', collapsed: false });
    w.port.addTab(tab(5, HOME, { groupId: 50 }));
    await w.anchors.onGroupUpdated({ id: 50, windowId: 1, title: 'API' });
    expect((await w.r.liveState()).anchors).toEqual([{ tabId: 5, windowId: 1, title: 'API', url: HOME }]);
  });

  it('a rename moves the dismissal with the group: removing it by its new title clears it', async () => {
    const w = setup();
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [id] = w.idOf(HOME);
    await w.anchors.onTabRemoved(id!); // the user closes the anchor: "1|api" is dismissed
    const g = w.port.state.groups.find((x) => x.title === 'api')!;
    g.title = 'API work';
    await w.anchors.onGroupUpdated({ id: g.id, windowId: 1, title: 'API work' });
    expect([...(await w.r.liveState()).anchorsDismissed]).toEqual(['1|API work']);
    await w.anchors.onGroupRemoved({ windowId: 1, title: 'API work' });
    expect((await w.r.liveState()).anchorsDismissed.size).toBe(0);
  });

  it('a rename retitles the group\'s anchors and moves the dismissal of the group in one step', async () => {
    const w = setup(cfgOf({ anchors: ['https://github.com/acme/{repo}', 'https://github.com/acme/{repo}/issues'] }));
    w.port.addTab(tab(1, PR));
    await w.r.flush();
    const [home] = w.idOf(HOME);
    const [issues] = w.idOf(`${HOME}/issues`);
    await w.anchors.onTabRemoved(home!);
    const g = w.port.state.groups.find((x) => x.title === 'api')!;
    g.title = 'API';
    await w.anchors.onGroupUpdated({ id: g.id, windowId: 1, title: 'API' });
    const st = await w.r.liveState();
    expect(st.anchors.find((a) => a.tabId === issues)?.title).toBe('API');
    expect([...st.anchorsDismissed]).toEqual(['1|API']);
  });
});

describe('AnchorService: the dedupe exemption is disarmed once the anchor is recorded', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it("a user's own duplicate of the anchor URL within 15 s is not exempted (it is closed as a duplicate)", async () => {
    const port = new FakeBrowserPort();
    port.addWindow(1);
    const getProgram = async () => programOf(cfgOf());
    // eslint-disable-next-line prefer-const
    let anchors: AnchorService;
    const r = new Reconciler(port, getProgram, { log: { add: () => {} }, anchors: { onGroupCreated: (...a) => anchors.onGroupCreated(...a) } });
    const dedupe = new DedupeHandler(port, getProgram, {
      recentlyClosed: { add: () => 'rc' }, log: { add: () => {} }, ask: vi.fn(async () => {}),
      isPaused: () => false, isLocked: () => false, isAnchor: (t) => anchors.isAnchor(t),
    });
    anchors = new AnchorService(port, { state: () => r.liveState(), log: { add: () => {} }, armExemption: (u, w) => dedupe.armExemption(u, w) });
    port.addTab(tab(1, PR));
    await r.flush();
    const [anchor] = port.state.tabs.filter((t) => t.url === HOME).map((t) => t.id);
    expect(anchors.isAnchor(anchor!)).toBe(true);
    // The anchor itself is never closed by dedupe (isAnchor), with or without the exemption.
    dedupe.recordCreated(anchor!);
    await dedupe.onCandidate(anchor!, HOME, 'committed');
    // The user opens the same URL a moment later: a plain new duplicate, closed in favor of the anchor.
    port.addTab(tab(5000, HOME));
    dedupe.recordCreated(5000);
    await dedupe.onCandidate(5000, HOME, 'committed');
    expect(port.calls.filter((c) => c.method === 'closeTab').map((c) => c.args)).toEqual([[5000]]);
    expect(port.state.tabs.some((t) => t.id === anchor)).toBe(true);
  });
});
