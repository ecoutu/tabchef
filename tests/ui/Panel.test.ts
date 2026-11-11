// @vitest-environment jsdom
// The side panel (M3 T17): an unlisted page with the Projects view, and the popup's "Open in side panel" button.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/svelte';
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
      case 'projects.home': {
        const id = (req as unknown as { id: string }).id;
        return { ok: true, data: { id, key: id.slice(5), title: id.slice(5), done: false, tabs: [], linked: [], groups: [] } };
      }
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.location.hash = ''; });

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

describe('side panel breadcrumbs (#180)', () => {
  it('the list: a plain Projects heading, no breadcrumbs', async () => {
    render(Panel);
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });

  it("a project: the header is Projects › <project>; Projects goes back to the list, and the project's own link is gone", async () => {
    window.location.hash = '#/project/repo%3Aacme%2Fweb';
    render(Panel);
    expect(await screen.findByRole('heading', { level: 2, name: 'acme/web' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.closest('header')).toBeTruthy();
    await waitFor(() => expect(crumbs.querySelector('[aria-current="page"]')!.textContent).toBe('acme/web'));
    const links = screen.getAllByRole('link', { name: 'Projects' });
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(within(crumbs).getByRole('link', { name: 'Projects' }));
    expect(links[0]!.getAttribute('href')).toBe('#/projects');
    window.location.hash = '#/projects';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
  });
});

describe('side panel breadcrumbs, switching projects (#180)', () => {
  it("going from one project to another, the crumbs follow to the second one's title", async () => {
    window.location.hash = '#/project/repo%3Aacme%2Fweb';
    render(Panel);
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(crumbs.querySelector('[aria-current="page"]')!.textContent).toBe('acme/web'));
    window.location.hash = '#/project/repo%3Aacme%2Fapi';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).querySelector('[aria-current="page"]')!.textContent).toBe('acme/api'));
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
  });
});

describe('popup "Open in side panel" (M3-R82)', () => {
  const setup = (opened: () => Promise<void> = () => Promise.resolve()) => {
    (vi.spyOn(browser.tabs, 'query') as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([{ id: 5, windowId: 3 }]);
    // The promise overload (the callback one confuses vi.spyOn's types).
    const perms = browser.permissions as unknown as Record<'request', (p: unknown) => Promise<boolean>>;
    const request = vi.spyOn(perms, 'request').mockResolvedValue(true);
    const setOptions = vi.spyOn(browser.sidePanel, 'setOptions').mockResolvedValue(undefined);
    const open = vi.fn((o: unknown) => { void o; return opened(); });
    (browser.sidePanel as unknown as { open: typeof open }).open = open;
    return { request, setOptions, open };
  };

  it('sets panel.html and opens it in the window within the click, with no permission request (sidePanel is required)', async () => {
    const s = setup();
    render(Popup);
    const btn = await screen.findByRole('button', { name: 'Open in side panel' });
    btn.click(); // no await: open must run inside the click's user gesture
    expect(s.setOptions).toHaveBeenCalledWith({ path: 'panel.html', enabled: true });
    expect(s.open).toHaveBeenCalledWith({ windowId: 3 });
    // A runtime grant of an optional sidePanel makes a later sidePanel.open() crash Chrome 156.
    expect(s.request).not.toHaveBeenCalled();
  });

  it('an open failure shows the error', async () => {
    setup(() => Promise.reject(new Error('No active side panel for windowId: 3')));
    render(Popup);
    await fireEvent.click(await screen.findByRole('button', { name: 'Open in side panel' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No active side panel for windowId: 3');
  });

  it('no button without a projects view; the projects view renders the Projects tab', async () => {
    setup();
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
