// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { browser } from 'wxt/browser';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));

import ListView from '../../src/entrypoints/popup/tabs/ListView.svelte';
import type { ViewRow, ViewSummary } from '../../src/engine/views';
import type { DoneProject } from '../../src/core/projects/types';

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

describe('ListView: done projects in the Finished view (#195)', () => {
  const issue: DoneProject = {
    id: 'github-issue:acme/web#12', key: 'acme/web#12', title: 'acme/web#12 · Fix login', summary: 'Fix login',
    status: { name: 'Closed', category: 'done', via: 'api' }, tabCount: 2,
  };
  const ticket: DoneProject = {
    id: 'jira-ticket-title:ABC-1', key: 'ABC-1', title: 'ABC-1', summary: 'Login fails', status: { name: 'Done', category: 'done', via: 'api' }, tabCount: 1,
  };

  it('one row per done project: title, why, status pill, tab count and the three prompt buttons', () => {
    render(ListView, { view: { ...finished, count: 3 }, rows: [sug(3)], projects: [issue, ticket], onChange: vi.fn() });
    const rows = screen.getAllByRole('group');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['acme/web#12 · Fix login', 'ABC-1']);
    // each row stays a list item of its list; the group is inside it (R5-M3)
    for (const r of rows) expect(r.tagName).not.toBe('LI');
    expect(rows.map((r) => r.closest('li')?.parentElement?.tagName)).toEqual(['UL', 'UL']);
    expect(rows[0]!.textContent).toContain('Issue is closed');
    expect(rows[0]!.textContent).toContain('Closed');
    expect(rows[0]!.textContent).toContain('2 tabs');
    expect(rows[1]!.textContent).toContain('Ticket is done');
    expect(rows[1]!.textContent).toContain('Login fails');
    expect(rows[1]!.textContent).toContain('1 tab');
    for (const name of ['Close group', 'Close and archive', 'Keep open']) {
      expect(screen.getByRole('button', { name: `${name} acme/web#12 · Fix login` }).textContent).toBe(name);
    }
    expect(screen.getByText('Tab 3')).toBeTruthy(); // the tab suggestions stay listed
    expect(screen.queryByText('Nothing here.')).toBeNull();
  });

  it('Close group and Close and archive send the card prompt\'s requests, show the undo toast and refresh', async () => {
    const onChange = vi.fn();
    send.mockImplementation(async (r: { type: string }) => (r.type.startsWith('projects.close')
      ? { ok: true, data: { closed: 2, skipped: 0, ids: ['rc-1', 'rc-2'] } } : { ok: true, data: null }));
    render(ListView, { view: finished, rows: [], projects: [issue], onChange });
    await fireEvent.click(screen.getByRole('button', { name: 'Close group acme/web#12 · Fix login' }));
    expect(send).toHaveBeenCalledWith({ type: 'projects.closeGroup', projectId: issue.id });
    expect((await screen.findByRole('status')).textContent).toContain('Closed 2 tabs');
    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(send).toHaveBeenCalledWith({ type: 'recent.undo', id: 'rc-1' });
    await fireEvent.click(screen.getByRole('button', { name: 'Close and archive acme/web#12 · Fix login' }));
    expect(send).toHaveBeenCalledWith({ type: 'projects.closeAndArchive', projectId: issue.id });
    expect(onChange).toHaveBeenCalled();
  });

  it('Keep sends projects.keepDone (the card prompt\'s Keep) and refreshes', async () => {
    const onChange = vi.fn();
    render(ListView, { view: finished, rows: [], projects: [issue], onChange });
    await fireEvent.click(screen.getByRole('button', { name: 'Keep open acme/web#12 · Fix login' }));
    expect(send.mock.calls.map((c) => c[0])).toEqual([{ type: 'projects.keepDone', projectId: issue.id }]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // #157: the same words as the card's Done prompt (doneKeepLabel), from project sync (view.data's syncOn) and the
  // project's keep. The label is right on first render, and ListView sends no projects.sync.status of its own.
  it('#157: with project sync on, Keep says it saves to bookmarks, unless the project is already saved', () => {
    render(ListView, { view: finished, rows: [], projects: [issue, { ...ticket, keep: true }], syncOn: true, onChange: vi.fn() });
    const keep = screen.getByRole('button', { name: 'Keep and save to bookmarks acme/web#12 · Fix login' });
    expect(keep.textContent).toBe('Keep and save to bookmarks');
    expect(screen.getByRole('button', { name: 'Keep open ABC-1' }).textContent).toBe('Keep open');
    expect(send).not.toHaveBeenCalled();
  });

  it('#157: with project sync off, Keep says it keeps the group open', () => {
    render(ListView, { view: finished, rows: [], projects: [issue], onChange: vi.fn() });
    expect(screen.getByRole('button', { name: 'Keep open acme/web#12 · Fix login' }).textContent).toBe('Keep open');
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed action shows its error', async () => {
    send.mockResolvedValue({ ok: false, error: 'unknown project' });
    render(ListView, { view: finished, rows: [], projects: [issue], onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Keep open acme/web#12 · Fix login' }));
    expect((await screen.findByRole('alert')).textContent).toContain('unknown project');
  });
});
