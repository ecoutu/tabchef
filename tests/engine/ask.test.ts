import { describe, expect, it, vi } from 'vitest';
import { createAskController, listPendingAsks, PENDING_KEY, type AskApi, type AskDeps } from '../../src/engine/ask';
import { compilePattern } from '../../src/core/match/pattern';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;
const PR = 'https://github.com/acme/api/pull/1';
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});

function setup(over: Partial<AskDeps> = {}) {
  const port = new FakeBrowserPort();
  port.addWindow(1);
  port.addWindow(2);
  port.addTab(tab(1, PR, { windowId: 2, title: 'Existing PR' }));
  port.addTab(tab(2, `${PR}?utm_source=x`, { active: true }));
  let cfg: Config = defaultConfig();
  const store = new Map<string, unknown>();
  const api = {
    executeScript: vi.fn<AskApi['executeScript']>(async () => {}),
    sendMessage: vi.fn<AskApi['sendMessage']>(async () => ({ ok: true })),
    waitForComplete: vi.fn<AskApi['waitForComplete']>(async () => true),
    clearNotification: vi.fn<AskApi['clearNotification']>(async () => {}),
    listNotificationIds: vi.fn<AskApi['listNotificationIds']>(async () => []),
    createNotification: vi.fn<AskApi['createNotification']>(async () => {}),
    session: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => { store.set(k, v); },
    },
  };
  const closed: unknown[] = [];
  const logs: { action: string; detail: string }[] = [];
  const deps: AskDeps = {
    api,
    bannerFile: '/content-scripts/banner.js',
    getConfig: async () => cfg,
    updateConfig: async (fn) => { cfg = fn(cfg); },
    recentlyClosed: { add: (e) => { closed.push(e); return 'rc'; } },
    log: { add: (e) => { logs.push(e); } },
    // Stand-in for the shared badge refresh (no duplicate sets in these worlds' badge expectations).
    scheduleBadge: async () => {
      const l = await listPendingAsks(api.session);
      await port.setBadge(l.length ? String(l.length) : '');
    },
    ...over,
  };
  const ctl = createAskController(port, deps);
  const snap = async () => (await port.snapshot()).tabs;
  const askDefault = async () => {
    const t = await snap();
    await ctl.ask(t.find((x) => x.id === 2)!, t.find((x) => x.id === 1)!);
    await ctl.settled();
  };
  const calls = (m: string) => port.calls.filter((c) => c.method === m).map((c) => c.args);
  return { port, api, ctl, store, closed, logs, askDefault, calls, cfg: () => cfg };
}

describe('ask: preference order', () => {
  it('host permission + scripting: injects the banner and sends banner.show', async () => {
    const w = setup();
    w.port.granted.add('https://github.com/*').add('scripting');
    await w.askDefault();
    expect(w.api.executeScript).toHaveBeenCalledWith(2, '/content-scripts/banner.js');
    expect(w.api.sendMessage).toHaveBeenCalledWith(2, {
      type: 'banner.show',
      payload: { kind: 'duplicate', existingTitle: 'Existing PR', tabId: 2, existingTabId: 1 },
    });
    expect(w.api.createNotification).not.toHaveBeenCalled();
  });

  it('banner payload carries the existing tab group title', async () => {
    const w = setup();
    w.port.state.groups.push({ id: 5, windowId: 2, title: 'PRs', color: 'blue', collapsed: false });
    w.port.state.tabs.find((t) => t.id === 1)!.groupId = 5;
    w.port.granted.add('https://github.com/*').add('scripting');
    await w.askDefault();
    expect(w.api.sendMessage.mock.calls[0]![1]).toMatchObject({ payload: { groupTitle: 'PRs' } });
  });

  it('no host permission but notifications: creates a notification with Switch / Keep both', async () => {
    const w = setup();
    w.port.granted.add('scripting').add('notifications');
    await w.askDefault();
    expect(w.api.executeScript).not.toHaveBeenCalled();
    expect(w.api.createNotification).toHaveBeenCalledTimes(1);
    const [id, opts] = w.api.createNotification.mock.calls[0]!;
    expect(id).toBe('dedupe:2:1');
    expect(opts.buttons.map((b) => b.title)).toEqual(['Switch', 'Keep both']);
  });

  it('neither: adds to the pending list and sets the badge', async () => {
    const w = setup();
    await w.askDefault();
    expect(w.api.createNotification).not.toHaveBeenCalled();
    expect(w.port.badge).toBe('1');
    const pending = await listPendingAsks(w.api.session);
    expect(pending).toEqual([expect.objectContaining({ newTabId: 2, existingTabId: 1, key: 'https://github.com/acme/api/pull/1' })]);
    expect(w.store.has(PENDING_KEY)).toBe(true);
  });

  it('updates the badge through the shared scheduleBadge, never with a pending-only count (M8)', async () => {
    const scheduleBadge = vi.fn(async () => {});
    const w = setup({ scheduleBadge });
    await w.askDefault();
    expect(scheduleBadge).toHaveBeenCalled();
    expect(w.calls('setBadge')).toEqual([]);
  });

  it('a failing badge refresh (snapshot throws) never rejects a pending mutation (CR#7)', async () => {
    let failBadge = false;
    const w = setup({ scheduleBadge: async () => { if (failBadge) throw new Error('snapshot failed'); } });
    await w.askDefault();
    expect(await listPendingAsks(w.api.session)).toHaveLength(1);
    failBadge = true;
    await expect(w.ctl.resolvePending(2, 1, 'keep')).resolves.toBeUndefined();
    expect(await listPendingAsks(w.api.session)).toEqual([]);
  });

  it('frozen tab with host permission uses the notification path and never executeScript', async () => {
    const w = setup();
    w.port.state.tabs.find((t) => t.id === 2)!.frozen = true;
    w.port.granted.add('https://github.com/*').add('scripting').add('notifications');
    await w.askDefault();
    expect(w.api.executeScript).not.toHaveBeenCalled();
    expect(w.api.sendMessage).not.toHaveBeenCalled();
    expect(w.api.createNotification).toHaveBeenCalledTimes(1);
  });

  it('discarded tab skips the banner too', async () => {
    const w = setup();
    w.port.state.tabs.find((t) => t.id === 2)!.discarded = true;
    w.port.granted.add('https://github.com/*').add('scripting');
    await w.askDefault();
    expect(w.api.executeScript).not.toHaveBeenCalled();
    expect(w.port.badge).toBe('1');
  });

  it('falls back to a notification when injection fails', async () => {
    const w = setup();
    w.api.executeScript.mockRejectedValueOnce(new Error('Cannot access'));
    w.port.granted.add('https://github.com/*').add('scripting').add('notifications');
    await w.askDefault();
    expect(w.api.createNotification).toHaveBeenCalledTimes(1);
  });

  it('resolves without waiting for the user', async () => {
    const w = setup();
    w.port.granted.add('https://github.com/*').add('scripting');
    await expect(w.askDefault()).resolves.toBeUndefined();
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('never requests permissions', async () => {
    const w = setup();
    await w.askDefault();
    expect(w.calls('hasPermission').length).toBeGreaterThan(0);
  });
});

describe('ask: choices', () => {
  it('switch closes the new tab, focuses the existing one and records recentlyClosed', async () => {
    const w = setup();
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([[2]]);
    expect(w.calls('focusTab')).toEqual([[1, 2, undefined]]);
    expect(w.closed).toEqual([expect.objectContaining({ reason: 'duplicate', url: `${PR}?utm_source=x`, windowId: 1 })]);
  });

  it('keep closes nothing', async () => {
    const w = setup();
    await w.ctl.handleChoice(2, 1, 'keep');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('always-switch-site appends origin/* to the config and switches', async () => {
    const w = setup();
    await w.ctl.handleChoice(2, 1, 'always-switch-site');
    expect(w.cfg().dedupe.alwaysSwitchSites).toEqual(['https://github.com/*']);
    expect(w.calls('closeTab')).toEqual([[2]]);
  });

  it('always-switch-site does not duplicate an existing pattern', async () => {
    const w = setup();
    await w.ctl.handleChoice(2, 1, 'always-switch-site');
    w.port.addTab(tab(3, PR));
    await w.ctl.handleChoice(3, 1, 'always-switch-site');
    expect(w.cfg().dedupe.alwaysSwitchSites).toEqual(['https://github.com/*']);
  });

  it('switch is skipped silently if the new tab navigated elsewhere', async () => {
    const w = setup();
    w.port.state.tabs.find((t) => t.id === 2)!.url = 'https://example.com/';
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('switch is skipped silently if the existing tab is gone', async () => {
    const w = setup();
    await w.port.closeTab(1);
    w.port.calls.length = 0;
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('notification button 0 switches, button 1 keeps, closed keeps', async () => {
    const w = setup();
    await w.ctl.onNotificationClosed('dedupe:2:1');
    await w.ctl.onNotificationButton('dedupe:2:1', 1);
    expect(w.calls('closeTab')).toEqual([]);
    await w.ctl.onNotificationButton('dedupe:2:1', 0);
    expect(w.calls('closeTab')).toEqual([[2]]);
  });

  it('notification switch rechecks the key against the stated existing tab', async () => {
    const w = setup();
    w.port.state.tabs.find((t) => t.id === 1)!.url = 'https://example.com/';
    await w.ctl.onNotificationButton('dedupe:2:1', 0);
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('ignores foreign notification ids', async () => {
    const w = setup();
    await w.ctl.onNotificationButton('other:2:1', 0);
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('pending switch via popup removes the entry and clears the badge', async () => {
    const w = setup();
    await w.askDefault();
    await w.ctl.resolvePending(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([[2]]);
    expect(await listPendingAsks(w.api.session)).toEqual([]);
    expect(w.port.badge).toBe('');
  });
});

describe('ask: delivery after load, ack, fallbacks', () => {
  const grantBanner = (w: ReturnType<typeof setup>) => w.port.granted.add('https://github.com/*').add('scripting');

  it('ask resolves before the tab is complete; the banner is injected only after complete', async () => {
    const w = setup();
    grantBanner(w);
    let complete!: (v: boolean) => void;
    w.api.waitForComplete.mockImplementationOnce(() => new Promise<boolean>((r) => { complete = r; }));
    const t = await w.port.snapshot();
    await w.ctl.ask(t.tabs.find((x) => x.id === 2)!, t.tabs.find((x) => x.id === 1)!);
    expect(w.api.executeScript).not.toHaveBeenCalled();
    expect(await listPendingAsks(w.api.session)).toHaveLength(1);
    expect(w.port.badge).toBe('1');
    await vi.waitFor(() => expect(w.api.waitForComplete).toHaveBeenCalled());
    expect(w.api.executeScript).not.toHaveBeenCalled();
    complete(true);
    await w.ctl.settled();
    expect(w.api.executeScript).toHaveBeenCalledTimes(1);
  });

  it('an ack removes the pending entry and clears the badge', async () => {
    const w = setup();
    grantBanner(w);
    await w.askDefault();
    expect(await listPendingAsks(w.api.session)).toEqual([]);
    expect(w.port.badge).toBe('');
  });

  it('no ack: falls back to a notification, which removes the pending entry', async () => {
    const w = setup();
    grantBanner(w);
    w.port.granted.add('notifications');
    w.api.sendMessage.mockResolvedValueOnce(undefined);
    await w.askDefault();
    expect(w.api.createNotification).toHaveBeenCalledTimes(1);
    expect(await listPendingAsks(w.api.session)).toEqual([]);
  });

  it('timeout waiting for complete: falls back to notification', async () => {
    const w = setup();
    grantBanner(w);
    w.port.granted.add('notifications');
    w.api.waitForComplete.mockResolvedValueOnce(false);
    await w.askDefault();
    expect(w.api.executeScript).not.toHaveBeenCalled();
    expect(w.api.createNotification).toHaveBeenCalledTimes(1);
  });

  it('no ack and no notifications permission: stays pending', async () => {
    const w = setup();
    grantBanner(w);
    w.api.sendMessage.mockResolvedValueOnce(undefined);
    await w.askDefault();
    expect(await listPendingAsks(w.api.session)).toHaveLength(1);
    expect(w.port.badge).toBe('1');
  });

  it('notification path removes the pending entry once created', async () => {
    const w = setup();
    w.port.granted.add('notifications');
    await w.askDefault();
    expect(await listPendingAsks(w.api.session)).toEqual([]);
  });
});

describe('ask: switch re-check semantics', () => {
  it('skips when scope is same-window and the tabs are in different windows', async () => {
    const w = setup();
    w.cfg().dedupe.scope = 'same-window';
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('skips incognito tabs unless includeIncognito', async () => {
    const w = setup();
    w.port.state.tabs.find((t) => t.id === 2)!.incognito = true;
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('skips when a matching group rule sets dedupe off', async () => {
    const w = setup();
    w.cfg().groupRules.push({
      id: 'r', name: 'r', enabled: true, match: { url: 'https://github.com/*' },
      group: { title: 'G', color: 'blue' }, dedupe: 'off',
    });
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('skips a locked new tab', async () => {
    const w = setup({ isLocked: (id) => id === 2 });
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('closeTab')).toEqual([]);
  });

  it('follows the fragment when configured', async () => {
    const w = setup();
    w.port.state.tabs.find((t) => t.id === 2)!.url = `${PR}#discussion`;
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.calls('focusTab')).toEqual([[1, 2, `${PR}#discussion`]]);
  });

  it('writes a dedupe-close why-log entry', async () => {
    const w = setup();
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(w.logs).toEqual([expect.objectContaining({ action: 'dedupe-close' })]);
  });

  it('uses the asked pair, not another duplicate', async () => {
    const w = setup();
    w.port.addTab(tab(3, PR, { windowId: 2 }));
    await w.ctl.handleChoice(2, 3, 'switch');
    expect(w.calls('focusTab')).toEqual([[3, 2, undefined]]);
  });
});

describe('ask: localhost origins and permissions', () => {
  it('always-switch-site on a localhost port builds a pattern that matches the site', async () => {
    const w = setup();
    w.port.addTab(tab(5, 'http://localhost:3000/a'));
    w.port.addTab(tab(6, 'http://localhost:3000/a'));
    await w.ctl.handleChoice(6, 5, 'always-switch-site');
    const [pat] = w.cfg().dedupe.alwaysSwitchSites;
    expect(pat).toBe('http://localhost:3000/*');
    expect(compilePattern(pat!)('http://localhost:3000/x')).not.toBeNull();
  });

  it('host permission is checked portless', async () => {
    const w = setup();
    w.port.state.tabs.find((t) => t.id === 2)!.url = 'http://localhost:3000/a';
    w.port.granted.add('http://localhost/*').add('scripting');
    await w.askDefault();
    expect(w.api.executeScript).toHaveBeenCalledTimes(1);
  });

  it('never calls permissions.request', async () => {
    const request = vi.fn();
    vi.stubGlobal('chrome', { permissions: { request } });
    try {
      const w = setup();
      await w.askDefault();
      w.port.granted.add('notifications');
      await w.askDefault();
      await w.ctl.handleChoice(2, 1, 'keep');
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ask: pending list lifecycle', () => {
  it('removes entries when either tab closes and updates the badge', async () => {
    const w = setup();
    await w.askDefault();
    w.port.addTab(tab(3, 'https://example.org/a'));
    w.port.addTab(tab(4, 'https://example.org/a'));
    const t = await w.port.snapshot();
    await w.ctl.ask(t.tabs.find((x) => x.id === 4)!, t.tabs.find((x) => x.id === 3)!);
    await w.ctl.settled();
    expect(w.port.badge).toBe('2');
    await w.ctl.onTabRemoved(1);
    expect(w.port.badge).toBe('1');
    await w.ctl.onTabRemoved(4);
    expect(w.port.badge).toBe('');
    expect(await listPendingAsks(w.api.session)).toEqual([]);
  });

  it('clears notifications involving a closed tab', async () => {
    const w = setup();
    w.api.listNotificationIds.mockResolvedValue(['dedupe:2:1', 'dedupe:7:8', 'other:1:2']);
    await w.ctl.onTabRemoved(1);
    expect(w.api.clearNotification.mock.calls).toEqual([['dedupe:2:1']]);
  });
});

describe('ask: onClosed', () => {
  it('reports the close after a switch', async () => {
    const onClosed = vi.fn();
    const w = setup({ onClosed });
    await w.ctl.handleChoice(2, 1, 'switch');
    expect(onClosed).toHaveBeenCalledWith('rc', expect.objectContaining({ reason: 'duplicate' }), expect.objectContaining({ id: 1 }));
  });
});
