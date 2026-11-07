// @vitest-environment jsdom
// Shared project actions (M4 P2): send + surface the error, Close group summary and Undo, and the live refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import { LIVE_MS, createProjectActions, startLiveRefresh, type Toast } from '../../src/ui/project-actions';

function setup() {
  const s = { error: 'unset', toast: undefined as Toast | undefined, reloads: 0 };
  const actions = createProjectActions({
    reload: async () => { s.reloads++; },
    setError: (e) => { s.error = e; },
    getToast: () => s.toast,
    setToast: (t) => { s.toast = t; },
  });
  return { s, actions };
}

beforeEach(() => { send.mockReset(); fakeBrowser.reset(); });
afterEach(() => { vi.useRealTimers(); });

describe('act', () => {
  it('surfaces the error of a failed request and returns false', async () => {
    const { s, actions } = setup();
    send.mockResolvedValue({ ok: false, error: 'No such tab' });
    expect(await actions.act(() => send({ type: 'tab.focus', tabId: 1 }))).toBe(false);
    expect(s.error).toBe('No such tab');
  });
  it('falls back to a generic message and clears the error on success', async () => {
    const { s, actions } = setup();
    expect(await actions.act(async () => ({ ok: false }))).toBe(false);
    expect(s.error).toBe('Something went wrong');
    expect(await actions.act(async () => ({ ok: true }))).toBe(true);
    expect(s.error).toBe('');
  });
});

describe('closeGroup', () => {
  it('summarises the closed and skipped tabs, keeps the ids for Undo and reloads', async () => {
    const { s, actions } = setup();
    send.mockResolvedValue({ ok: true, data: { closed: 3, skipped: 2, ids: ['a', 'b', 'c'] } });
    await actions.closeGroup('p1');
    expect(send).toHaveBeenCalledWith({ type: 'projects.closeGroup', projectId: 'p1' });
    expect(s.toast).toEqual({ text: 'Closed 3 tabs · 2 skipped', ids: ['a', 'b', 'c'] });
    expect(s.reloads).toBe(1);
  });
  it('uses the singular for one tab and shows no toast when nothing happened', async () => {
    const { s, actions } = setup();
    send.mockResolvedValue({ ok: true, data: { closed: 1, skipped: 0, ids: ['a'] } });
    await actions.closeGroup('p1');
    expect(s.toast?.text).toBe('Closed 1 tab');
    send.mockResolvedValue({ ok: true, data: { closed: 0, skipped: 0, ids: [] } });
    await actions.closeGroup('p1');
    expect(s.toast).toBeUndefined();
  });
  it('surfaces a failure without reloading', async () => {
    const { s, actions } = setup();
    send.mockResolvedValue({ ok: false, error: 'boom' });
    await actions.closeGroup('p1');
    expect(s.error).toBe('boom');
    expect(s.reloads).toBe(0);
  });
});

describe('reopen', () => {
  it('says how many saved tabs could not be opened, without Undo, and reloads', async () => {
    const { s, actions } = setup();
    send.mockResolvedValue({ ok: true, data: { opened: 2, failed: 1 } });
    expect(await actions.reopen('p1')).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'projects.reopen', projectId: 'p1' });
    expect(s.toast).toEqual({ text: 'Opened 2 tabs · 1 could not be opened', ids: [] });
    expect(s.error).toBe('');
    expect(s.reloads).toBe(1);
  });
  it('says how many saved tabs could not be opened when none opened', async () => {
    const { s, actions } = setup();
    send.mockResolvedValue({ ok: true, data: { opened: 0, failed: 3 } });
    expect(await actions.reopen('p1')).toBe(true);
    expect(s.toast).toEqual({ text: '3 saved tabs could not be opened', ids: [] });
    send.mockResolvedValue({ ok: true, data: { opened: 0, failed: 1 } });
    await actions.reopen('p1');
    expect(s.toast).toEqual({ text: '1 saved tab could not be opened', ids: [] });
  });
  it('leaves the toast alone when every tab opened, and surfaces a failure without reloading', async () => {
    const { s, actions } = setup();
    s.toast = { text: 'Closed 2 tabs', ids: ['a', 'b'] };
    send.mockResolvedValue({ ok: true, data: { opened: 1 } });
    await actions.reopen('p1');
    expect(s.toast).toEqual({ text: 'Closed 2 tabs', ids: ['a', 'b'] });
    send.mockResolvedValue({ ok: false, error: 'boom' });
    expect(await actions.reopen('p1')).toBe(false);
    expect(s.error).toBe('boom');
    expect(s.reloads).toBe(1);
  });
});

describe('undo', () => {
  it('restores each entry, clears the toast and reloads', async () => {
    const { s, actions } = setup();
    s.toast = { text: 'Closed 2 tabs', ids: ['a', 'b'] };
    send.mockResolvedValue({ ok: true });
    await actions.undo(['a', 'b']);
    expect(send.mock.calls.map((c) => c[0])).toEqual([{ type: 'recent.undo', id: 'a' }, { type: 'recent.undo', id: 'b' }]);
    expect(s.toast).toBeUndefined();
    expect(s.reloads).toBe(1);
  });
  it('on a failure keeps the entries not restored behind Undo', async () => {
    const { s, actions } = setup();
    s.toast = { text: 'Closed 3 tabs', ids: ['a', 'b', 'c'] };
    send.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'gone' });
    await actions.undo(['a', 'b', 'c']);
    expect(s.toast).toEqual({ text: 'Closed 3 tabs', ids: ['b', 'c'] });
    expect(s.error).toBe('gone');
    expect(s.reloads).toBe(1);
  });
});

describe('startLiveRefresh', () => {
  const visibility = (v: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });

  it('reloads every 5 s only while visible, on visibilitychange and on config.changed, and stops on stop()', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {});
    visibility('visible');
    const stop = startLiveRefresh(load);
    expect(LIVE_MS).toBe(5000);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(load).toHaveBeenCalledTimes(1);
    visibility('hidden');
    vi.advanceTimersByTime(10000);
    expect(load).toHaveBeenCalledTimes(1);
    visibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(load).toHaveBeenCalledTimes(2);
    await fakeBrowser.runtime.sendMessage({ type: 'config.changed', rev: 'r1' });
    expect(load).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(20000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
