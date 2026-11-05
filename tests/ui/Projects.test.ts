// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ProjectCardData } from '../../src/core/projects/types';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Projects from '../../src/entrypoints/popup/tabs/Projects.svelte';

const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const PR = 'https://github.com/acme/api/pull/7';
const LINKED = 'https://github.com/acme/web/pull/9';
const done: ProjectCardData = {
  id: 'jira:ABC-1', key: 'ABC-1', title: 'ABC-1 · Login fails', status: { name: 'Done', category: 'done', via: 'api' }, done: true,
  tabs: [
    { tabId: 1, windowId: 1, title: 'ABC-1 ticket', url: TICKET, lastAccessed: 10 },
    { tabId: 2, windowId: 1, title: 'Fix login', url: PR, pill: 'merged', stale: true },
  ],
  linked: [{ url: LINKED, title: 'Web fix', state: 'open' }],
};
let cards: ProjectCardData[];

beforeEach(() => {
  fakeBrowser.reset();
  cards = [done];
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    switch (req.type) {
      case 'projects.list': return { ok: true, data: cards };
      case 'projects.closeGroup': return { ok: true, data: { closed: 2, skipped: 0, ids: ['rc-1', 'rc-2'] } };
      case 'projects.openLinked': return { ok: true, data: { tabId: 9 } };
      default: return { ok: true, data: null };
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const types = () => send.mock.calls.map((c) => (c[0] as { type: string }).type);

describe('Projects tab (M3 T17)', () => {
  it('a card: title, status pill, tab count, tab rows with PR pill and stale dot, greyed linked rows', async () => {
    render(Projects);
    expect(await screen.findByRole('heading', { name: 'ABC-1 · Login fails' })).toBeTruthy();
    expect(screen.getByText('Done').className).toContain('tone-done');
    expect(screen.getByText('2 tabs')).toBeTruthy();
    expect(screen.getByText('merged')).toBeTruthy();
    expect(screen.getByTitle('Last known state; GitHub unavailable')).toBeTruthy();
    expect(screen.getByText('Web fix').closest('li')!.className).toContain('linked');
  });

  it('clicking a tab title focuses it', async () => {
    render(Projects);
    await fireEvent.click(await screen.findByRole('button', { name: 'Fix login' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.focus', tabId: 2 });
  });

  it('"Open ↗" (named after its PR) sends projects.openLinked with that URL', async () => {
    render(Projects);
    const open = await screen.findByRole('button', { name: 'Open Web fix' });
    expect(open.textContent).toBe('Open ↗');
    await fireEvent.click(open);
    expect(send).toHaveBeenCalledWith({ type: 'projects.openLinked', projectId: 'jira:ABC-1', url: LINKED });
  });

  it('Done: the exact prompt; [Close group] sends projects.closeGroup with the id, then an undo toast', async () => {
    render(Projects);
    expect(await screen.findByText('Ticket is done. Close this group?')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Ticket is done' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Close group' }));
    expect(send).toHaveBeenCalledWith({ type: 'projects.closeGroup', projectId: 'jira:ABC-1' });
    expect((await screen.findByRole('status')).textContent).toContain('Closed 2 tabs');
    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(send).toHaveBeenCalledWith({ type: 'recent.undo', id: 'rc-1' });
    expect(send).toHaveBeenCalledWith({ type: 'recent.undo', id: 'rc-2' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
  });

  it('a failed undo keeps the entries not yet restored behind Undo', async () => {
    send.mockImplementation(async (req: { type: string; id?: string }) => {
      switch (req.type) {
        case 'projects.list': return { ok: true, data: cards };
        case 'projects.closeGroup': return { ok: true, data: { closed: 3, skipped: 0, ids: ['rc-1', 'rc-2', 'rc-3'] } };
        case 'recent.undo': return req.id === 'rc-2' ? { ok: false, error: 'window gone' } : { ok: true, data: null };
        default: return { ok: true, data: null };
      }
    });
    render(Projects);
    await fireEvent.click(await screen.findByRole('button', { name: 'Close group' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect((await screen.findByRole('alert')).textContent).toBe('window gone');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    send.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const undone = send.mock.calls.map((c) => c[0] as { type: string; id?: string }).filter((r) => r.type === 'recent.undo').map((r) => r.id);
    expect(undone).toEqual(['rc-2']); // rc-1 was restored; rc-2 failed and stops the loop, rc-3 is still pending
  });

  it('[Keep] dismisses the prompt without closing', async () => {
    render(Projects);
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Ticket is done. Close this group?')).toBeNull();
    expect(types()).not.toContain('projects.closeGroup');
  });

  it('no prompt for a project that is not done', async () => {
    cards = [{ ...done, status: { name: 'In Progress', category: 'indeterminate', via: 'api' }, done: false }];
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    expect(screen.queryByText('Ticket is done. Close this group?')).toBeNull();
  });

  it('the empty state', async () => {
    cards = [];
    render(Projects);
    expect(await screen.findByText('No projects yet. Turn on a Jira ticket recipe, then open a Jira ticket.')).toBeTruthy();
  });

  it('M3-R83: opening the tab sends sources.refresh, then lists again once it answers', async () => {
    render(Projects);
    await waitFor(() => expect(types().filter((t) => t === 'projects.list')).toHaveLength(2));
    expect(types()).toContain('sources.refresh');
    expect(types().indexOf('sources.refresh')).toBeLessThan(types().lastIndexOf('projects.list'));
  });

  it('while the first list is pending: a loading status, replaced by the cards', async () => {
    let answer!: (r: unknown) => void;
    send.mockImplementation((req: { type: string }) =>
      req.type === 'projects.list' ? new Promise((r) => { answer = r; }) : Promise.resolve({ ok: false, error: 'skip' }));
    render(Projects);
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Loading projects…');
    answer({ ok: true, data: cards });
    expect(await screen.findByRole('heading', { name: 'ABC-1 · Login fails' })).toBeTruthy();
    expect(screen.queryByText('Loading projects…')).toBeNull();
  });

  it('no loading status on a later refresh', async () => {
    const answers: ((r: unknown) => void)[] = [];
    let refreshed!: (r: unknown) => void;
    send.mockImplementation((req: { type: string }) =>
      req.type === 'projects.list' ? new Promise((r) => { answers.push(r); })
        : req.type === 'sources.refresh' ? new Promise((r) => { refreshed = r; }) : Promise.resolve({ ok: true, data: null }));
    render(Projects);
    await waitFor(() => expect(answers).toHaveLength(1));
    answers[0]!({ ok: true, data: cards });
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    refreshed({ ok: true, data: null });
    await waitFor(() => expect(answers).toHaveLength(2)); // after sources.refresh: still pending
    expect(screen.queryByText('Loading projects…')).toBeNull();
  });

  it('a failed first list: the error replaces the loading status', async () => {
    let answer!: (r: unknown) => void;
    send.mockImplementation((req: { type: string }) =>
      req.type === 'projects.list' ? new Promise((r) => { answer = r; }) : Promise.resolve({ ok: false, error: 'skip' }));
    render(Projects);
    await screen.findByText('Loading projects…');
    answer({ ok: false, error: 'projects unavailable' });
    expect((await screen.findByRole('alert')).textContent).toBe('projects unavailable');
    expect(screen.queryByText('Loading projects…')).toBeNull();
  });

  it('a failed list shows the error', async () => {
    send.mockImplementation(async (req: { type: string }) => (req.type === 'projects.list' ? { ok: false, error: 'projects unavailable' } : { ok: true, data: null }));
    render(Projects);
    expect((await screen.findByRole('alert')).textContent).toBe('projects unavailable');
  });
});
