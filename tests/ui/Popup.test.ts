// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Popup from '../../src/entrypoints/popup/App.svelte';

let locked: number[];
let warning: string | undefined;
let dryRun: boolean;
type V = { id: string; tab: string; kind: 'list' | 'duplicates' | 'projects'; actions: string[]; count: number; paused?: string; notice?: string };
let views: V[];
const dupView: V = { id: 'duplicates', tab: 'Duplicates', kind: 'duplicates', actions: ['focus', 'close', 'close-all'], count: 0 };
const finView: V = { id: 'finished', tab: 'Finished', kind: 'list', actions: ['focus', 'close', 'keep'], count: 1 };
const listView = (id: string, count = 0): V => ({ id, tab: id.toUpperCase(), kind: 'list', actions: ['focus'], count });

beforeEach(() => {
  fakeBrowser.reset();
  locked = [];
  warning = undefined;
  dryRun = false;
  views = [dupView];
  (vi.spyOn(browser.tabs, 'query') as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([{ id: 5 }]);
  send.mockReset();
  send.mockImplementation(async (req: { type: string; tabId?: number; viewId?: string }) => {
    switch (req.type) {
      case 'views.list': return { ok: true, data: views };
      case 'view.data': return req.viewId === 'duplicates'
        ? { ok: true, data: { kind: 'duplicates', sets: [], pending: [] } }
        : { ok: true, data: { kind: 'list', rows: req.viewId === 'finished' ? [{ tabId: 3, windowId: 1, title: 'Callback', url: 'http://localhost/cb', pinned: false, suggested: true, reason: 'Close OAuth callback tabs' }] : [] } };
      case 'safety.status': return { ok: true, data: { paused: false, locked } };
      case 'recent.list': return { ok: true, data: [] };
      case 'config.get': return { ok: true, data: { config: { dryRun }, rev: 'r' } };
      case 'config.status': return { ok: true, data: warning ? { syncing: false, warning } : { syncing: false } };
      case 'tab.lock': locked = [...locked, req.tabId!]; return { ok: true, data: null };
      case 'tab.unlock': locked = locked.filter((x) => x !== req.tabId); return { ok: true, data: null };
      default: return { ok: true, data: null };
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Popup', () => {
  it('shows a one-line sync warning when present (I5)', async () => {
    warning = 'Config too large to sync; saved on this device only.';
    render(Popup);
    expect((await screen.findByText(warning)).getAttribute('role')).toBe('status');
  });

  it('no warning line without a warning', async () => {
    render(Popup);
    await waitFor(() => expect(send.mock.calls.some((c) => c[0].type === 'config.status')).toBe(true));
    expect(screen.queryByTestId('sync-warning')).toBeNull();
  });

  it('header shows a "Dry run" chip only while global dry run is on (M2 T12)', async () => {
    render(Popup);
    await waitFor(() => expect(send.mock.calls.some((c) => c[0].type === 'config.get')).toBe(true));
    expect(screen.queryByText('Dry run')).toBeNull();
    cleanup();
    dryRun = true;
    render(Popup);
    expect(await screen.findByText('Dry run')).toBeTruthy();
  });

  it('header Lock current tab locks the active tab, then offers Unlock', async () => {
    render(Popup);
    await fireEvent.click(await screen.findByRole('button', { name: 'Lock current tab' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.lock', tabId: 5 });
    await fireEvent.click(await screen.findByRole('button', { name: 'Unlock current tab' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.unlock', tabId: 5 });
    await screen.findByRole('button', { name: 'Lock current tab' });
  });

  it('one tab per view; the Duplicates view renders the M1 Duplicates tab (M2 T17)', async () => {
    views = [dupView, finView];
    render(Popup);
    expect((await screen.findByRole('tab', { name: /Finished/ })).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /Duplicates/ }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('No duplicate tabs.')).toBeTruthy();
    expect(send).toHaveBeenCalledWith({ type: 'view.data', viewId: 'duplicates' });
  });

  it('opening the Finished view lists its suggestion and remembers the tab', async () => {
    views = [dupView, finView];
    render(Popup);
    await fireEvent.click(await screen.findByRole('tab', { name: /Finished/ }));
    expect(await screen.findByText('Close OAuth callback tabs')).toBeTruthy();
    expect(send).toHaveBeenCalledWith({ type: 'view.data', viewId: 'finished' });
    expect((await browser.storage.local.get('popup.lastTab'))['popup.lastTab']).toBe('finished');
  });

  it('views past visibleCount go under More ▾, in the popup.prefs order (R20)', async () => {
    views = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => listView(id, i));
    await browser.storage.local.set({ 'popup.prefs': { tabOrder: ['g'], visibleCount: 3 } });
    render(Popup);
    await screen.findByRole('tab', { name: /^G/ });
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim().charAt(0))).toEqual(['G', 'A', 'B']);
    await fireEvent.click(screen.getByRole('button', { name: /More/ }));
    const items = screen.getAllByRole('menuitem').filter((m) => /^[C-F]/.test(m.textContent?.trim() ?? ''));
    expect(items.map((m) => m.textContent?.trim().charAt(0))).toEqual(['C', 'D', 'E', 'F']);
    await fireEvent.click(items[1]!);
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'view.data', viewId: 'd' }));
  });

  it('"Show in tab bar" moves an overflow view into the visible tabs and stores popup.prefs', async () => {
    views = ['a', 'b', 'c'].map((id) => listView(id));
    await browser.storage.local.set({ 'popup.prefs': { visibleCount: 2 } });
    render(Popup);
    await fireEvent.click(await screen.findByRole('button', { name: /More/ }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Show C in tab bar' }));
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim().charAt(0))).toEqual(['A', 'C']));
    expect((await browser.storage.local.get('popup.prefs'))['popup.prefs']).toEqual({ visibleCount: 2, tabOrder: ['a', 'c', 'b'] });
  });

  it('popup.prefs that cannot be read fall back to the defaults (5 visible)', async () => {
    views = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => listView(id));
    vi.spyOn(browser.storage.local, 'get').mockRejectedValue(new Error('no storage'));
    render(Popup);
    await screen.findByRole('tab', { name: /^A/ });
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });

  it('a paused view is faded with its reason (R45)', async () => {
    views = [dupView, { ...finView, paused: 'Paused: needs access to meet.google.com' }];
    render(Popup);
    const tab = await screen.findByRole('tab', { name: /Finished/ });
    expect(tab.classList.contains('faded')).toBe(true);
    expect(tab.getAttribute('title')).toBe('Paused: needs access to meet.google.com');
  });

  it('Close group and Undo on a project card refresh the other tabs\' counts (views.list)', async () => {
    const projView: V = { id: 'projects', tab: 'Projects', kind: 'projects', actions: [], count: 1 };
    views = [projView, { ...dupView, count: 2 }];
    const card = { id: 'jira:ABC-1', key: 'ABC-1', title: 'ABC-1 · Login fails', status: { name: 'Done', category: 'done', via: 'api' }, done: true,
      tabs: [{ tabId: 1, windowId: 1, title: 'ABC-1 ticket', url: 'https://acme.atlassian.net/browse/ABC-1' }], linked: [] };
    const base = send.getMockImplementation()!;
    send.mockImplementation(async (req: { type: string }) => {
      switch (req.type) {
        case 'projects.list': return { ok: true, data: [card] };
        case 'projects.closeGroup': views = [projView, { ...dupView, count: 0 }]; return { ok: true, data: { closed: 1, skipped: 0, ids: ['rc-1'] } };
        case 'recent.undo': views = [projView, { ...dupView, count: 2 }]; return { ok: true, data: null };
        default: return base(req);
      }
    });
    await browser.storage.local.set({ 'popup.lastTab': 'projects' });
    render(Popup);
    const dup = await screen.findByRole('tab', { name: /Duplicates/ });
    await waitFor(() => expect(dup.textContent).toContain('2'));
    await fireEvent.click(await screen.findByRole('button', { name: 'Close group' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Duplicates/ }).textContent).toContain('0'));
    await fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Duplicates/ }).textContent).toContain('2'));
  });

  it('#195: the Finished view lists done projects; Keep there refreshes the popup', async () => {
    views = [dupView, { ...finView, count: 2 }];
    const project = { id: 'github-issue:acme/web#12', key: 'acme/web#12', title: 'acme/web#12 · Fix login', status: { name: 'Closed', category: 'done', via: 'api' }, tabCount: 2 };
    const base = send.getMockImplementation()!;
    send.mockImplementation(async (req: { type: string; viewId?: string }) => {
      if (req.type === 'view.data' && req.viewId === 'finished') return { ok: true, data: { kind: 'list', rows: [], projects: [project] } };
      if (req.type === 'projects.keepDone') { views = [dupView, { ...finView, count: 0 }]; return { ok: true, data: null }; }
      return base(req);
    });
    await browser.storage.local.set({ 'popup.lastTab': 'finished' });
    render(Popup);
    expect(await screen.findByRole('group', { name: 'acme/web#12 · Fix login' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Keep acme/web#12 · Fix login' }));
    expect(send).toHaveBeenCalledWith({ type: 'projects.keepDone', projectId: project.id });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Finished/ }).textContent).toContain('0'));
  });

  it('#195: refreshes when the done projects change (storage.session projects.done)', async () => {
    render(Popup);
    await waitFor(() => expect(send.mock.calls.filter((c) => c[0].type === 'views.list')).toHaveLength(1));
    await browser.storage.session.set({ 'projects.done': { projects: [], kept: [] } });
    await waitFor(() => expect(send.mock.calls.filter((c) => c[0].type === 'views.list')).toHaveLength(2));
  });

  it('refreshes when the Finished suggestions change (storage.session closeSuggestions)', async () => {
    render(Popup);
    await waitFor(() => expect(send.mock.calls.filter((c) => c[0].type === 'views.list')).toHaveLength(1));
    await browser.storage.session.set({ closeSuggestions: [{ tabId: 3 }] });
    await waitFor(() => expect(send.mock.calls.filter((c) => c[0].type === 'views.list')).toHaveLength(2));
  });
});

describe('Popup live refresh of the list views', () => {
  const calls = (type: string, viewId?: string) =>
    send.mock.calls.filter((c) => c[0].type === type && (viewId === undefined || c[0].viewId === viewId)).length;
  afterEach(() => { vi.useRealTimers(); });

  it('the Finished tab re-lists every 5 s while visible (views.list refreshes the done projects), not while hidden', async () => {
    vi.useFakeTimers();
    views = [finView];
    render(Popup);
    await vi.advanceTimersByTimeAsync(0);
    const lists = calls('views.list');
    const data = calls('view.data', 'finished');
    expect(data).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls('views.list')).toBe(lists + 1);
    expect(calls('view.data', 'finished')).toBe(data + 1);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls('views.list')).toBe(lists + 1);
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('views.list')).toBe(lists + 2);
  });

  it('the Duplicates tab re-lists too', async () => {
    vi.useFakeTimers();
    render(Popup);
    await vi.advanceTimersByTimeAsync(0);
    const data = calls('view.data', 'duplicates');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls('view.data', 'duplicates')).toBe(data + 2);
  });

  it('stops when the popup closes', async () => {
    vi.useFakeTimers();
    views = [finView];
    render(Popup);
    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    const lists = calls('views.list');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls('views.list')).toBe(lists);
  });

  it('does not poll on the Projects tab (it lists projects itself), and starts again on a list tab', async () => {
    vi.useFakeTimers();
    const projView: V = { id: 'projects', tab: 'Projects', kind: 'projects', actions: [], count: 0 };
    views = [projView, finView];
    const base = send.getMockImplementation()!;
    send.mockImplementation(async (req: { type: string }) => (req.type === 'projects.list' ? { ok: true, data: [] } : base(req)));
    render(Popup);
    await vi.advanceTimersByTimeAsync(0);
    const lists = calls('views.list');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls('views.list')).toBe(lists);
    await fireEvent.click(screen.getByRole('tab', { name: /Finished/ }));
    await vi.advanceTimersByTimeAsync(0);
    const after = calls('views.list');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls('views.list')).toBe(after + 1);
  });
});
