// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/svelte';
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

  it('[Keep] dismisses the prompt without closing and keeps the project (never pruned)', async () => {
    render(Projects);
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Ticket is done. Close this group?')).toBeNull();
    expect(types()).not.toContain('projects.closeGroup');
    expect(send).toHaveBeenCalledWith({ type: 'projects.setKeep', projectId: 'jira:ABC-1', keep: true });
  });

  it('a closed GitHub issue: the prompt says the issue is closed, not the ticket done', async () => {
    cards = [{ ...done, id: 'github-issue:acme/api#7', key: 'acme/api#7', title: 'acme/api#7 · Login fails',
      status: { name: 'Closed', category: 'done', via: 'api' } }];
    render(Projects);
    expect(await screen.findByText('Issue is closed. Close this group?')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Issue is closed' })).toBeTruthy();
    expect(screen.queryByText('Ticket is done. Close this group?')).toBeNull();
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

describe('collapsing project cards (#151)', () => {
  const KEY = 'projects.collapsed';
  const other: ProjectCardData = {
    id: 'jira:ABC-4', key: 'ABC-4', title: 'ABC-4 · Signup', status: { name: 'In Progress', category: 'indeterminate', via: 'api' }, done: false,
    tabs: [{ tabId: 4, windowId: 1, title: 'ABC-4 ticket', url: 'https://acme.atlassian.net/browse/ABC-4', lastAccessed: 5 }],
    linked: [],
  };
  const toggle = (title: string) => screen.getByRole('button', { name: title });
  const header = (title: string) => screen.getByRole('heading', { name: title }).closest('header')!;
  const stored = async () => (await fakeBrowser.storage.local.get(KEY))[KEY];
  const lists = () => types().filter((t) => t === 'projects.list').length;

  it('every card starts expanded; its header disclosure button collapses it to the header and expands it again', async () => {
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    const btn = toggle('ABC-1 · Login fails');
    expect(btn.tagName).toBe('BUTTON'); // a native button: Enter and Space work
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(btn.getAttribute('aria-controls') ?? '')!;
    expect(body).toBeTruthy();
    expect(body.textContent).toContain('Fix login');
    expect(screen.getByRole('button', { name: 'Fix login' })).toBeTruthy();

    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: 'Fix login' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'ABC-1 · Login fails' })).toBeTruthy();
    expect(screen.getByText('2 tabs')).toBeTruthy();

    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Fix login' })).toBeTruthy();
  });

  it('the collapsed set is stored, and a card stays collapsed when the tab opens again', async () => {
    const first = render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    await fireEvent.click(toggle('ABC-1 · Login fails'));
    await waitFor(async () => expect(await stored()).toEqual(['jira:ABC-1']));
    first.unmount();

    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Fix login' })).toBeNull();
  });

  it('collapsed in another page (the popup or the side panel): the open page follows', async () => {
    cards = [done, other];
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    await fakeBrowser.storage.local.set({ [KEY]: ['jira:ABC-4'] });
    await waitFor(() => expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false'));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('true');
  });

  it('a collapsed card never expands by itself when the list refreshes', async () => {
    let answer!: (r: unknown) => void;
    send.mockImplementation((req: { type: string }) =>
      req.type === 'sources.refresh' ? new Promise((r) => { answer = r; })
        : Promise.resolve(req.type === 'projects.list' ? { ok: true, data: cards } : { ok: true, data: null }));
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    await fireEvent.click(toggle('ABC-1 · Login fails'));
    answer({ ok: true, data: null });
    await waitFor(() => expect(lists()).toBe(2));
    await waitFor(() => expect(stored()).resolves.toEqual(['jira:ABC-1']));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
  });

  it('collapsed and done: the header shows a Done badge and Close group (no Close and archive or Keep)', async () => {
    await fakeBrowser.storage.local.set({ [KEY]: ['jira:ABC-1'] });
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    const h = header('ABC-1 · Login fails');
    expect(within(h).getByText('Done').className).toContain('badge');
    expect(within(h).getByText('Done').getAttribute('title')).toBe('Ticket is done. Close this group?');
    expect(screen.queryByRole('group', { name: 'Ticket is done' })).toBeNull(); // the body's prompt is hidden
    expect(screen.queryByRole('button', { name: 'Close and archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
    await fireEvent.click(within(h).getByRole('button', { name: 'Close group' }));
    expect(send).toHaveBeenCalledWith({ type: 'projects.closeGroup', projectId: 'jira:ABC-1' });
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
  });

  it('expanded, the header has no badge or Close group: the prompt in the body has them', async () => {
    render(Projects);
    await screen.findByText('Ticket is done. Close this group?');
    const h = header('ABC-1 · Login fails');
    expect(within(h).queryByRole('button', { name: 'Close group' })).toBeNull();
    expect(h.querySelector('.badge')).toBeNull();
  });

  it('a card that is not done shows no badge when collapsed', async () => {
    cards = [other];
    await fakeBrowser.storage.local.set({ [KEY]: ['jira:ABC-4'] });
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    expect(header('ABC-4 · Signup').querySelector('.badge')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close group' })).toBeNull();
  });

  it('Keep removes the badge from the collapsed header', async () => {
    render(Projects);
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    await fireEvent.click(toggle('ABC-1 · Login fails'));
    const h = header('ABC-1 · Login fails');
    expect(h.querySelector('.badge')).toBeNull();
    expect(within(h).queryByRole('button', { name: 'Close group' })).toBeNull();
    expect(within(h).getByText('Done').className).toContain('tone-done'); // the status pill is back
  });

  it('Collapse all collapses every card, then Expand all expands them; both are stored', async () => {
    cards = [done, other];
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    await fireEvent.click(toggle('ABC-4 · Signup'));
    await fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false');
    await waitFor(async () => expect([...(await stored() as string[])].sort()).toEqual(['jira:ABC-1', 'jira:ABC-4']));

    await fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('true');
    await waitFor(async () => expect(await stored()).toEqual([]));
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeTruthy();
  });

  it('no Collapse all without cards', async () => {
    cards = [];
    render(Projects);
    await screen.findByText('No projects yet. Turn on a Jira ticket recipe, then open a Jira ticket.');
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull();
  });

  it('ids of projects no longer listed are pruned from storage when the list loads', async () => {
    await fakeBrowser.storage.local.set({ [KEY]: ['jira:GONE-9', 'jira:ABC-1'] });
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    await waitFor(async () => expect(await stored()).toEqual(['jira:ABC-1']));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
  });

  it('only the first list prunes: a card missing from a later refresh is still collapsed when it comes back', async () => {
    cards = [done, other];
    render(Projects, { live: true });
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    await fireEvent.click(toggle('ABC-4 · Signup'));
    const configChanged = () => (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> })
      .trigger({ type: 'config.changed', rev: 'r2' });
    cards = [done];
    await configChanged();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'ABC-4 · Signup' })).toBeNull());
    cards = [done, other];
    await configChanged();
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false');
    expect(await stored()).toEqual(['jira:ABC-4']);
  });

  it('a failed list prunes nothing', async () => {
    await fakeBrowser.storage.local.set({ [KEY]: ['jira:GONE-9'] });
    send.mockImplementation(async (req: { type: string }) => (req.type === 'projects.list' ? { ok: false, error: 'projects unavailable' } : { ok: true, data: null }));
    render(Projects);
    await screen.findByRole('alert');
    expect(await stored()).toEqual(['jira:GONE-9']);
  });

  /**
   * Storage the test steps through: `hold('get' | 'set')` keeps this page's next reads or writes pending until released;
   * with `manual`, this page's storage.onChanged events wait in a queue until `deliver()` (Chrome delivers them
   * asynchronously, after other pages may have written, and can resolve set() first), or `deliver(n)` for the oldest n.
   * `otherPage` writes as the other page (popup or side panel).
   */
  function steppedStorage({ manual = false } = {}) {
    const local = fakeBrowser.storage.local;
    const realGet = local.get.bind(local);
    const realSet = local.set.bind(local);
    const gates: { get?: Promise<void>; set?: Promise<void> } = {};
    const writes: unknown[] = [];
    vi.spyOn(local, 'get').mockImplementation((async (keys: string) => { await gates.get; return realGet(keys); }) as never);
    vi.spyOn(local, 'set').mockImplementation((async (items: Record<string, unknown>) => {
      writes.push(items[KEY]);
      await gates.set;
      return realSet(items);
    }) as never);
    type Listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void;
    let listener: Listener | undefined;
    const queued: Parameters<Listener>[] = [];
    if (manual) {
      fakeBrowser.storage.onChanged.addListener((changes, area) => { queued.push([changes, area]); });
      vi.spyOn(fakeBrowser.storage.onChanged, 'addListener').mockImplementation(((l: Listener) => { listener = l; }) as never);
    }
    return {
      writes,
      hold(kind: 'get' | 'set'): () => void {
        let release!: () => void;
        gates[kind] = new Promise((r) => { release = () => { gates[kind] = undefined; r(); }; });
        return release;
      },
      deliver(n = queued.length): void { for (const [changes, area] of queued.splice(0, n)) listener!(changes, area); },
      otherPage: (ids: string[]) => realSet({ [KEY]: ids }),
    };
  }

  /** Lets this page's write chain and the render finish. */
  const settle = () => new Promise((r) => { setTimeout(r, 0); });

  it('a fast double toggle while the first write is pending ends expanded, and never shows its first write', async () => {
    const s = steppedStorage();
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    const btn = toggle('ABC-1 · Login fails');
    const release = s.hold('set');
    await fireEvent.click(btn);
    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const shown: (string | null)[] = [];
    const watch = new MutationObserver(() => shown.push(btn.getAttribute('aria-expanded')));
    watch.observe(btn, { attributes: true, attributeFilter: ['aria-expanded'] });
    release();
    await waitFor(async () => expect(await stored()).toEqual([]));
    await waitFor(() => expect(s.writes).toEqual([['jira:ABC-1'], []]));
    watch.disconnect();
    expect(shown.filter((v) => v !== 'true')).toEqual([]); // the [ABC-1] write never collapsed it on screen
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('a change from the other page that arrives while this page\'s write is pending is kept, on screen and stored', async () => {
    cards = [done, other];
    const s = steppedStorage({ manual: true });
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    await s.otherPage(['jira:ABC-1']); // its event has not reached this page yet
    const release = s.hold('set');
    await fireEvent.click(toggle('ABC-4 · Signup'));
    await waitFor(() => expect(s.writes).toHaveLength(1));
    s.deliver(); // the other page's change arrives while this page's write is pending
    await waitFor(() => expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false'));
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false');
    release();
    await waitFor(async () => expect(await stored()).toEqual(['jira:ABC-1', 'jira:ABC-4']));
    await settle(); // the write is done; its own change has not arrived yet
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false');
    s.deliver();
    await Promise.resolve();
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false');
  });

  it('two quick toggles whose set() resolves before their change arrives never flip the card back', async () => {
    const s = steppedStorage({ manual: true });
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    const btn = toggle('ABC-1 · Login fails');
    const shown: (string | null)[] = [];
    const watch = new MutationObserver(() => shown.push(btn.getAttribute('aria-expanded')));
    watch.observe(btn, { attributes: true, attributeFilter: ['aria-expanded'] });
    await fireEvent.click(btn);
    await fireEvent.click(btn);
    await waitFor(() => expect(s.writes).toEqual([['jira:ABC-1'], []]));
    await waitFor(async () => expect(await stored()).toEqual([]));
    await settle(); // both writes are done; neither change has arrived
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    s.deliver(1); // the first write's change: [ABC-1]
    await settle();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    s.deliver();
    await settle();
    watch.disconnect();
    expect(shown).toEqual(['false', 'true']);
  });

  it('an edit whose own change never arrives as written ends at the next change, so it never sticks', async () => {
    cards = [done, other];
    const s = steppedStorage({ manual: true });
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    const release = s.hold('set');
    await fireEvent.click(toggle('ABC-4 · Signup')); // reads [], will write [ABC-4]
    await waitFor(() => expect(s.writes).toHaveLength(1));
    await s.otherPage(['jira:ABC-1']); // before this page's set(): its change will read [ABC-1] → [ABC-4]
    release();
    await waitFor(async () => expect(await stored()).toEqual(['jira:ABC-4']));
    await settle();
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false');
    s.deliver();
    await settle();
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('true');
    await s.otherPage([]); // the other page expands it: no edit of this page is left on top
    s.deliver();
    await settle();
    expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('true');
  });

  it('a card with a subtitle: the title link and the disclosure button both show, each with its own name', async () => {
    cards = [{ ...other, id: 'jira:ABC-7', key: 'ABC-7', title: 'ABC-7', summary: 'Billing export' }];
    render(Projects);
    const link = await screen.findByRole('link', { name: 'ABC-7 · Billing export' });
    const btn = screen.getByRole('button', { name: 'ABC-7' });
    expect(link.closest('header')).toBe(btn.closest('header'));
    expect(link.textContent).toBe('ABC-7 · Billing export');
    expect(screen.getAllByRole('button', { name: /ABC-7/ })).toEqual([btn]);
    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('link', { name: 'ABC-7 · Billing export' })).toBe(link);
  });

  it('the prune keeps a card the other page collapsed after this page read the stored set', async () => {
    cards = [done, other];
    await fakeBrowser.storage.local.set({ [KEY]: ['jira:GONE-9'] });
    const s = steppedStorage({ manual: true });
    const answers: ((r: unknown) => void)[] = [];
    send.mockImplementation((req: { type: string }) =>
      req.type === 'projects.list' ? new Promise((r) => { answers.push(r); }) : Promise.resolve({ ok: false, error: 'skip' }));
    render(Projects);
    await waitFor(() => expect(answers).toHaveLength(1));
    await waitFor(() => expect(fakeBrowser.storage.local.get).toHaveBeenCalled());
    await s.otherPage(['jira:GONE-9', 'jira:ABC-4']); // between this page's first read and its prune
    answers[0]!({ ok: true, data: cards });
    await screen.findByRole('heading', { name: 'ABC-4 · Signup' });
    await waitFor(async () => expect(await stored()).toEqual(['jira:ABC-4']));
    s.deliver();
    await waitFor(() => expect(toggle('ABC-4 · Signup').getAttribute('aria-expanded')).toBe('false'));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('true');
  });

  it('storage unavailable: every card is expanded, and collapsing still works on the page', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage down'));
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage down'));
    render(Projects);
    await screen.findByRole('heading', { name: 'ABC-1 · Login fails' });
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(toggle('ABC-1 · Login fails'));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(toggle('ABC-1 · Login fails').getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
