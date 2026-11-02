// @vitest-environment jsdom
// The side panel (M3 T17): an unlisted page with the Projects view, and the popup's "Open in side panel" button.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Panel from '../../src/entrypoints/panel/App.svelte';
import Popup from '../../src/entrypoints/popup/App.svelte';

const projectsView = { id: 'projects', tab: 'Projects', kind: 'projects', actions: [], count: 0 };
let views: unknown[];

beforeEach(() => {
  fakeBrowser.reset();
  views = [projectsView];
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    switch (req.type) {
      case 'projects.list': return { ok: true, data: [] };
      case 'views.list': return { ok: true, data: views };
      case 'view.data': return { ok: true, data: { kind: 'list', rows: [] } };
      case 'safety.status': return { ok: true, data: { paused: false, locked: [] } };
      case 'recent.list': return { ok: true, data: [] };
      case 'config.get': return { ok: true, data: { config: { dryRun: false }, rev: 'r' } };
      case 'config.status': return { ok: true, data: { syncing: false } };
      default: return { ok: true, data: null };
    }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const lists = () => send.mock.calls.filter((c) => (c[0] as { type: string }).type === 'projects.list').length;
const trigger = (m: unknown) => (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> }).trigger(m);

describe('side panel page (M3 T17)', () => {
  it('renders the Projects view', async () => {
    render(Panel);
    expect(await screen.findByText('No projects yet. Turn on a Jira ticket recipe, then open a Jira ticket.')).toBeTruthy();
  });

  it('re-fetches projects.list on config.changed', async () => {
    render(Panel);
    await waitFor(() => expect(lists()).toBe(2)); // on open, and after sources.refresh
    await trigger({ type: 'config.changed', rev: 'r2' });
    await waitFor(() => expect(lists()).toBe(3));
  });

  it('re-fetches every 5 s while visible, not while hidden', async () => {
    vi.useFakeTimers();
    render(Panel);
    await vi.advanceTimersByTimeAsync(0);
    const start = lists();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lists()).toBe(start + 1);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists()).toBe(start + 1);
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toBe(start + 2); // shown again: at once, not on the next tick
    await vi.advanceTimersByTimeAsync(5000);
    expect(lists()).toBe(start + 3);
  });
});

describe('popup "Open in side panel" (M3-R82)', () => {
  const gestureLost = () => Promise.reject(new Error('sidePanel.open() may only be called in response to a user gesture.'));
  const setup = (granted: boolean, opened: () => Promise<void> = () => Promise.resolve()) => {
    (vi.spyOn(browser.tabs, 'query') as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([{ id: 5, windowId: 3 }]);
    // The promise overloads (the callback ones confuse vi.spyOn's types).
    const perms = browser.permissions as unknown as Record<'contains' | 'request', (p: unknown) => Promise<boolean>>;
    vi.spyOn(perms, 'contains').mockResolvedValue(granted);
    const request = vi.spyOn(perms, 'request').mockResolvedValue(true);
    const setOptions = vi.spyOn(browser.sidePanel, 'setOptions').mockResolvedValue(undefined);
    const open = vi.fn((o: unknown) => { void o; return opened(); });
    (browser.sidePanel as unknown as { open: typeof open }).open = open;
    return { request, setOptions, open };
  };

  it('requests sidePanel synchronously in the click handler, then sets panel.html and opens it in the window', async () => {
    const s = setup(false);
    render(Popup);
    const btn = await screen.findByRole('button', { name: 'Open in side panel' });
    await waitFor(() => expect(browser.permissions.contains).toHaveBeenCalled());
    btn.click(); // no await: the request must already have happened
    expect(s.request).toHaveBeenCalledWith({ permissions: ['sidePanel'] });
    await waitFor(() => expect(s.open).toHaveBeenCalledWith({ windowId: 3 }));
    expect(s.setOptions).toHaveBeenCalledWith({ path: 'panel.html', enabled: true });
  });

  it('when open rejects (gesture lost), the label becomes "Open side panel" and the second click opens it directly', async () => {
    const s = setup(false, gestureLost);
    render(Popup);
    await fireEvent.click(await screen.findByRole('button', { name: 'Open in side panel' }));
    const again = await screen.findByRole('button', { name: 'Open side panel' });
    s.open.mockImplementation(() => Promise.resolve());
    s.request.mockClear();
    again.click();
    expect(s.open).toHaveBeenLastCalledWith({ windowId: 3 }); // synchronously: no permission prompt in between
    expect(s.request).not.toHaveBeenCalled();
  });

  it('an open failure other than the lost gesture (granted already) shows the error', async () => {
    setup(true, () => Promise.reject(new Error('No active side panel for windowId: 3')));
    render(Popup);
    await fireEvent.click(await screen.findByRole('button', { name: 'Open in side panel' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No active side panel for windowId: 3');
  });

  it('already granted: the click opens without a permission request', async () => {
    const s = setup(true);
    render(Popup);
    const btn = await screen.findByRole('button', { name: 'Open in side panel' });
    await waitFor(() => expect(browser.permissions.contains).toHaveBeenCalledWith({ permissions: ['sidePanel'] }));
    await Promise.resolve();
    btn.click();
    expect(s.open).toHaveBeenCalledWith({ windowId: 3 });
    expect(s.request).not.toHaveBeenCalled();
  });

  it('a declined request opens nothing', async () => {
    const s = setup(false);
    s.request.mockResolvedValue(false);
    render(Popup);
    await fireEvent.click(await screen.findByRole('button', { name: 'Open in side panel' }));
    await Promise.resolve();
    expect(s.open).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open in side panel' })).toBeTruthy();
  });

  it('no button without a projects view; the projects view renders the Projects tab', async () => {
    setup(false);
    render(Popup);
    expect(await screen.findByText('No projects yet. Turn on a Jira ticket recipe, then open a Jira ticket.')).toBeTruthy();
    cleanup();
    views = [{ id: 'finished', tab: 'Finished', kind: 'list', actions: ['focus'], count: 0 }];
    render(Popup);
    await waitFor(() => expect(send.mock.calls.some((c) => (c[0] as { type: string }).type === 'views.list')).toBe(true));
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: /side panel/ })).toBeNull();
  });
});
