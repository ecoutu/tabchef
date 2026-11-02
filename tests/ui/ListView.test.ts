// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { browser } from 'wxt/browser';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));

import ListView from '../../src/entrypoints/popup/tabs/ListView.svelte';
import type { ViewRow, ViewSummary } from '../../src/engine/views';

const finished: ViewSummary = { id: 'finished', tab: 'Finished', kind: 'list', actions: ['focus', 'close', 'keep'], count: 1 };
const row = (tabId: number, o: Partial<ViewRow> = {}): ViewRow => ({
  tabId, windowId: 1, title: `Tab ${tabId}`, url: `http://localhost:3000/cb${tabId}`, pinned: false, ...o,
});
const sug = (tabId: number) => row(tabId, { suggested: true, reason: 'Close OAuth callback tabs', ruleKey: 'finished/oauth-callback' });

beforeEach(() => { send.mockReset(); send.mockResolvedValue({ ok: true, data: null }); });
afterEach(cleanup);

describe('ListView (M2 T17)', () => {
  it('rows: title focuses, Close and Keep act on the suggestion, then refresh', async () => {
    const onChange = vi.fn();
    render(ListView, { view: finished, rows: [sug(3)], onChange });
    expect(screen.getByText('Close OAuth callback tabs')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Tab 3' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.focus', tabId: 3 });
    await fireEvent.click(screen.getByRole('button', { name: 'Keep Tab 3' }));
    expect(send).toHaveBeenCalledWith({ type: 'view.keep', viewId: 'finished', tabId: 3, url: 'http://localhost:3000/cb3' });
    await fireEvent.click(screen.getByRole('button', { name: 'Close Tab 3' }));
    expect(send).toHaveBeenCalledWith({ type: 'view.close', viewId: 'finished', tabId: 3, url: 'http://localhost:3000/cb3' });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('only the declared actions are offered; Keep only on suggestions', () => {
    render(ListView, { view: { ...finished, actions: ['focus'] }, rows: [sug(3)], onChange: vi.fn() });
    expect(screen.queryByRole('button', { name: /^Close/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Keep/ })).toBeNull();
    cleanup();
    render(ListView, { view: finished, rows: [row(4)], onChange: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Keep Tab 4' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Tab 4' })).toBeTruthy();
  });

  it('close-all closes every row in one request and reports skipped tabs', async () => {
    send.mockResolvedValue({ ok: true, data: { closed: 1, skipped: 1 } });
    render(ListView, { view: { ...finished, actions: ['close-all'] }, rows: [row(1), row(2)], onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Close all' }));
    expect(send.mock.calls.map((c) => c[0])).toEqual([{
      type: 'view.close', viewId: 'finished',
      tabs: [{ tabId: 1, url: 'http://localhost:3000/cb1' }, { tabId: 2, url: 'http://localhost:3000/cb2' }],
    }]);
    expect((await screen.findByRole('status')).textContent).toBe('1 skipped');
  });

  it('groups rows under their groupBy value', () => {
    render(ListView, { view: finished, rows: [row(1, { group: 'api' }), row(2, { group: 'api' }), row(3, { group: 'web' })], onChange: vi.fn() });
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['api', 'web']);
  });

  it('paused / notice reason and the empty state; errors are inline', async () => {
    render(ListView, { view: { ...finished, count: 0, paused: 'Paused: needs access to meet.google.com' }, rows: [], onChange: vi.fn() });
    expect(screen.getByText('Paused: needs access to meet.google.com')).toBeTruthy();
    expect(screen.getByText('Nothing here.')).toBeTruthy();
    cleanup();
    send.mockResolvedValue({ ok: false, error: 'tab is locked' });
    render(ListView, { view: finished, rows: [row(4)], onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Close Tab 4' }));
    expect((await screen.findByRole('alert')).textContent).toContain('tab is locked');
  });
});

describe('ListView: Merged PRs (M3 T13)', () => {
  const merged: ViewSummary = { id: 'merged', tab: 'Merged', kind: 'list', actions: ['focus', 'close', 'close-all'], count: 1 };
  const pr = (tabId: number, o: Partial<ViewRow> = {}) => row(tabId, { url: `https://github.com/acme/api/pull/${tabId}`, source: { state: 'merged' }, ...o });

  it('shows the PR state pill and the stale marker', () => {
    render(ListView, { view: merged, rows: [pr(1), pr(2, { stale: true, source: { state: 'closed' } })], onChange: vi.fn() });
    expect(screen.getAllByText(/^(merged|closed)$/).map((e) => e.textContent)).toEqual(['merged', 'closed']);
    expect(screen.getAllByText('stale')).toHaveLength(1);
    expect(screen.getByTitle('Could not refresh this; it may be out of date').textContent).toBe('stale');
  });

  describe('locked state', () => {
    const lockedView: ViewSummary = {
      ...merged, count: 0, paused: 'Paused: needs access to github.com',
      locked: { text: 'Needs GitHub access', connections: [{ id: 'github', label: 'GitHub' }], hosts: ['github.com'], origins: ['https://github.com/*'], permissions: [] },
    };
    it('no connection and no host: the copy and both buttons', () => {
      render(ListView, { view: lockedView, rows: [], onChange: vi.fn() });
      expect(screen.getByText('Needs GitHub access')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Allow github.com' })).toBeTruthy();
      expect(screen.queryByText('Nothing here.')).toBeNull();
    });
    it('[Allow github.com] calls permissions.request inside the click handler (before any await)', async () => {
      const request = vi.fn(async () => true);
      (browser.permissions as unknown as { request: typeof request }).request = request;
      render(ListView, { view: lockedView, rows: [], onChange: vi.fn() });
      screen.getByRole('button', { name: 'Allow github.com' }).click(); // synchronous dispatch: no await before the request
      expect(request).toHaveBeenCalledWith({ origins: ['https://github.com/*'], permissions: ['scripting'] });
    });
    it('[Connect GitHub] opens options.html#/connections', async () => {
      const create = vi.fn(async () => ({}));
      (browser.tabs as unknown as { create: typeof create }).create = create;
      render(ListView, { view: lockedView, rows: [], onChange: vi.fn() });
      await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
      expect(create).toHaveBeenCalledWith({ url: expect.stringMatching(/\/options\.html#\/connections$/) });
    });
  });
});
