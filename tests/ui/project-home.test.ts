// @vitest-environment jsdom
// The Project home page (M4 T4, spec §6.12, D4): header → open tabs by group → linked not open → settings (collapsed,
// read-only, with help tips); re-fetched on config.changed and every 5 s while visible.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ProjectHomeData } from '../../src/core/projects/types';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import ProjectHome from '../../src/entrypoints/options/ProjectHome.svelte';
import { staleText } from '../../src/ui/projects-model';

const ID = 'jira-ticket-either:ABC-1';
const home = (o: Partial<ProjectHomeData> = {}): ProjectHomeData => ({
  id: ID, key: 'ABC-1', title: 'ABC-1 · Login fails', done: false,
  status: { name: 'In Progress', category: 'indeterminate', via: 'api' },
  tabs: [
    { tabId: 1, windowId: 1, title: 'Login fails - Jira', url: 'https://acme.atlassian.net/browse/ABC-1' },
    { tabId: 2, windowId: 1, title: 'fix login', url: 'https://github.com/acme/api/pull/5', pill: 'open', stale: true },
    { tabId: 3, windowId: 2, title: 'web', url: 'https://github.com/acme/web/pull/9', pill: 'merged' },
  ],
  linked: [{ url: 'https://github.com/acme/api/pull/6', title: 'ABC-1: tests', state: 'open' }],
  groups: [
    { title: 'ABC-1', color: 'blue', windowId: 1, tabIds: [2, 1] },
    { title: 'ABC-1', color: 'blue', windowId: 2, tabIds: [3] },
  ],
  settings: { container: 'group', placement: ['existing', 'current'], join: ['rules', 'manual'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload' },
  recipeName: 'Jira ticket',
  ...o,
});
let data: ProjectHomeData | null;

beforeEach(() => {
  fakeBrowser.reset();
  data = home();
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    switch (req.type) {
      case 'projects.home': return { ok: true, data };
      case 'projects.closeGroup': return { ok: true, data: { closed: 3, skipped: 0, ids: ['rc1', 'rc2', 'rc3'] } };
      case 'projects.openLinked': return { ok: true, data: { tabId: 9 } };
      default: return { ok: true, data: null };
    }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const calls = (type: string) => send.mock.calls.map((c) => c[0] as { type: string }).filter((r) => r.type === type);
const trigger = (m: unknown) => (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> }).trigger(m);

describe('Project home (M4 T4)', () => {
  it('asks for this project, and lays out header → tabs by group → linked not open → settings (D4)', async () => {
    render(ProjectHome, { id: ID });
    const h = await screen.findByRole('heading', { level: 2, name: 'ABC-1 · Login fails' });
    expect(calls('projects.home')[0]).toEqual({ type: 'projects.home', id: ID });
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.getByText('2 open · 1 merged')).toBeTruthy();
    const tabs = screen.getByRole('region', { name: 'Open tabs' });
    const linked = screen.getByRole('region', { name: 'Linked, not open' });
    const settings = screen.getByText('Settings').closest('details')!;
    const order = [h, tabs, linked, settings];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect((screen.getByRole('link', { name: 'Projects' }) as HTMLAnchorElement).getAttribute('href')).toBe('#/projects');
  });

  it('open tabs grouped in tab-bar order; a tab title focuses it; a stale pill says why', async () => {
    render(ProjectHome, { id: ID });
    const tabs = await screen.findByRole('region', { name: 'Open tabs' });
    const groups = within(tabs).getAllByRole('list');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getAllByRole('button').map((b) => b.textContent)).toEqual(['fix login', 'Login fails - Jira']);
    expect(within(groups[1]!).getAllByRole('button').map((b) => b.textContent)).toEqual(['web']);
    expect(within(tabs).getByRole('img', { name: staleText('GitHub') })).toBeTruthy();
    await fireEvent.click(within(groups[1]!).getByRole('button', { name: 'web' }));
    expect(calls('tab.focus')).toEqual([{ type: 'tab.focus', tabId: 3 }]);
  });

  it('header actions: Open in tab bar focuses the first tab; Close group closes, offers Undo, and the page says the project is gone', async () => {
    render(ProjectHome, { id: ID });
    await fireEvent.click(await screen.findByRole('button', { name: 'Open in tab bar' }));
    expect(calls('tab.focus')).toEqual([{ type: 'tab.focus', tabId: 2 }]);
    data = null;
    await fireEvent.click(screen.getByRole('button', { name: 'Close group' }));
    expect(calls('projects.closeGroup')).toEqual([{ type: 'projects.closeGroup', projectId: ID }]);
    expect(await screen.findByText('This project is no longer open.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Closed 3 tabs');
    data = home();
    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls('recent.undo').map((r) => (r as unknown as { id: string }).id)).toEqual(['rc1', 'rc2', 'rc3']));
    expect(await screen.findByRole('heading', { level: 2, name: 'ABC-1 · Login fails' })).toBeTruthy();
  });

  it('"Open into project" opens a linked PR as a member, then re-reads the project', async () => {
    render(ProjectHome, { id: ID });
    const linked = await screen.findByRole('region', { name: 'Linked, not open' });
    expect(within(linked).getByText('ABC-1: tests')).toBeTruthy();
    const before = calls('projects.home').length;
    await fireEvent.click(within(linked).getByRole('button', { name: 'Open ABC-1: tests into project' }));
    expect(calls('projects.openLinked')).toEqual([{ type: 'projects.openLinked', projectId: ID, url: 'https://github.com/acme/api/pull/6' }]);
    await waitFor(() => expect(calls('projects.home').length).toBe(before + 1));
  });

  it('no linked PRs: the section says so', async () => {
    data = home({ linked: [] });
    render(ProjectHome, { id: ID });
    const linked = await screen.findByRole('region', { name: 'Linked, not open' });
    expect(within(linked).getByText('Nothing linked that is not open.')).toBeTruthy();
  });

  it('settings: collapsed, read-only, each with a help tip, naming the recipe', async () => {
    render(ProjectHome, { id: ID });
    const details = (await screen.findByText('Settings')).closest('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll('input, select, textarea')).toHaveLength(0);
    for (const label of ['Container', 'Placement', 'Joins by', 'Opened elsewhere', 'Switching away']) {
      expect(within(details).getByRole('button', { name: `About ${label}`, hidden: true }), label).toBeTruthy();
    }
    expect(within(details).getByText('A tab group')).toBeTruthy();
    expect(details.textContent).toContain('Jira ticket');
  });

  it('an unknown id: "This project is no longer open" with a link to the projects list', async () => {
    data = null;
    render(ProjectHome, { id: 'nope' });
    expect(await screen.findByText('This project is no longer open.')).toBeTruthy();
    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '#/projects');
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it('a failed request shows its error, not the project-gone text', async () => {
    send.mockImplementation(async () => ({ ok: false, error: 'projects unavailable' }));
    render(ProjectHome, { id: ID });
    expect((await screen.findByRole('alert')).textContent).toContain('projects unavailable');
    expect(screen.queryByText('This project is no longer open.')).toBeNull();
  });

  it('live: re-fetched on config.changed', async () => {
    render(ProjectHome, { id: ID });
    await waitFor(() => expect(calls('projects.home').length).toBe(2)); // on open, and after sources.refresh
    data = home({ title: 'Renamed' });
    await trigger({ type: 'config.changed', rev: 'r2' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Renamed' })).toBeTruthy();
  });

  it('live: re-fetched every 5 s while visible, not while hidden', async () => {
    vi.useFakeTimers();
    render(ProjectHome, { id: ID });
    await vi.advanceTimersByTimeAsync(0);
    const start = calls('projects.home').length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls('projects.home').length).toBe(start + 1);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls('projects.home').length).toBe(start + 1);
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls('projects.home').length).toBe(start + 2);
  });
});
