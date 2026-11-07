// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ProjectCardData, ProjectHomeData, SavedProjectData } from '../../src/core/projects/types';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Projects from '../../src/entrypoints/options/Projects.svelte';
import ProjectHome from '../../src/entrypoints/options/ProjectHome.svelte';
import PopupProjects from '../../src/entrypoints/popup/tabs/Projects.svelte';
import Popup from '../../src/entrypoints/popup/App.svelte';
import Panel from '../../src/entrypoints/panel/App.svelte';
import { projectHomeHash } from '../../src/ui/routes';

const card = (id: string, title: string): ProjectCardData => ({ id, key: id, title, done: false, tabs: [], linked: [] });
const cards = [card('jira-ticket-either:ABC-1', 'ABC-1 · Login fails'), card('repo:acme/web', 'acme/web')];
const homeOf = (id: string): ProjectHomeData | null => {
  const c = cards.find((x) => x.id === id);
  return c ? {
    ...c, groups: [], recipeName: 'r',
    settings: { container: 'group', placement: ['existing'], join: ['rules'], onOpenElsewhere: 'leave', onSwitchAway: 'unload' },
  } : null;
};
const reply = async (req: { type: string; id?: string }) => {
  if (req.type === 'projects.list') return { ok: true, data: cards };
  if (req.type === 'projects.savedLists') return { ok: true, data: { saved: [], archived: [] } };
  if (req.type === 'projects.home') return { ok: true, data: homeOf(req.id ?? '') };
  return { ok: true, data: null };
};

beforeEach(() => {
  fakeBrowser.reset();
  window.location.hash = '';
  send.mockReset();
  send.mockImplementation(reply);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Projects page (M4 T3)', () => {
  it('renders one link per project card, to its Project home', async () => {
    render(Projects);
    for (const c of cards) {
      const a = (await screen.findByRole('link', { name: new RegExp(c.title) })) as HTMLAnchorElement;
      expect(a.getAttribute('href')).toBe(projectHomeHash(c.id));
    }
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
  it('says so when there are no projects', async () => {
    send.mockImplementation(async () => ({ ok: true, data: [] }));
    render(Projects);
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });
});

describe('Projects page: New project (M4 T6, M4-R8)', () => {
  const created = 'manual-project:tax-2026';
  const withCreate = (result: { ok: boolean; data?: unknown; error?: string } = { ok: true, data: { id: created } }) => {
    send.mockImplementation(async (req: { type: string }) => (req.type === 'projects.create' ? result : reply(req)));
  };

  it('?new=<tabId>: the name form is open; Create makes a Manual project with that tab, then opens its home', async () => {
    withCreate();
    render(Projects, { newTab: '5' });
    const name = await screen.findByLabelText('Project name');
    await fireEvent.input(name, { target: { value: '  Tax 2026 ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(window.location.hash).toBe(projectHomeHash(created)));
    expect(send).toHaveBeenCalledWith({ type: 'projects.create', recipeId: 'manual-project', name: 'Tax 2026', tabIds: [5] });
  });

  it('otherwise a New project button opens the same form, without a tab', async () => {
    withCreate();
    render(Projects);
    expect(screen.queryByLabelText('Project name')).toBeNull();
    await fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    await fireEvent.input(screen.getByLabelText('Project name'), { target: { value: 'Taxes' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(window.location.hash).toBe(projectHomeHash(created)));
    expect(send).toHaveBeenCalledWith({ type: 'projects.create', recipeId: 'manual-project', name: 'Taxes' });
  });

  it('M4-R10: with the Manual projects recipe off, the page says so and links to Recipes instead of offering the form', async () => {
    send.mockImplementation(async (req: { type: string }) => (req.type === 'config.get'
      ? { ok: true, data: { config: { recipes: [{ id: 'manual-project', enabled: false, params: {}, source: 'builtin' }] }, rev: 'r1' } }
      : reply(req)));
    for (const props of [{ newTab: '5' }, {}]) {
      render(Projects, props);
      expect((await screen.findByText(/Manual projects are turned off\./)).textContent).toContain('Manual projects are turned off.');
      expect((screen.getByRole('link', { name: 'Recipes' }) as HTMLAnchorElement).getAttribute('href')).toBe('#/recipes');
      expect(screen.queryByLabelText('Project name')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
      cleanup();
    }
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'projects.create' }));
  });

  it('with the recipe on (config.get), the form is offered as usual', async () => {
    send.mockImplementation(async (req: { type: string }) => (req.type === 'config.get'
      ? { ok: true, data: { config: { recipes: [{ id: 'manual-project', enabled: true, params: {}, source: 'builtin' }] }, rev: 'r1' } }
      : reply(req)));
    render(Projects, { newTab: '5' });
    expect(await screen.findByLabelText('Project name')).toBeTruthy();
    expect(screen.queryByText(/turned off/)).toBeNull();
  });

  it('Create is off until a name is typed; a failure is shown and the page stays', async () => {
    withCreate({ ok: false, error: 'turn on the recipe manual-project first' });
    render(Projects, { newTab: '5' });
    const create = (await screen.findByRole('button', { name: 'Create' })) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText('Project name'), { target: { value: 'Taxes' } });
    await fireEvent.click(create);
    expect((await screen.findByRole('alert')).textContent).toContain('turn on the recipe manual-project first');
    expect(window.location.hash).toBe('');
  });
});

describe('Projects page: Save a group (M4 T8)', () => {
  const groups = [{ id: 5, title: 'Taxes', color: 'blue', tabCount: 2 }, { id: 6, title: '', color: 'red', tabCount: 1 }];
  const withGroups = (save: { ok: boolean; data?: unknown; error?: string } = { ok: true, data: { id: 'manual-project:taxes' } }, off = false) => {
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'projects.groups') return { ok: true, data: off ? [] : groups };
      if (req.type === 'projects.saveGroup') return save;
      if (req.type === 'config.get' && off) return { ok: true, data: { config: { recipes: [{ id: 'manual-project', enabled: false, params: {}, source: 'builtin' }] }, rev: 'r1' } };
      return reply(req);
    });
  };

  it('lists the open unmanaged groups with their tab count; Save makes the project and opens its home', async () => {
    withGroups();
    render(Projects);
    expect((await screen.findByText('Taxes')).closest('li')!.textContent).toContain('2 tabs');
    const untitled = screen.getByText('Name the group in Chrome to save it').closest('li')!;
    expect(untitled.textContent).toContain('1 tab');
    expect(untitled.querySelector('button')).toBeNull(); // M4-R15: no Save for an untitled group
    expect(screen.getAllByRole('button', { name: /^Save / })).toHaveLength(1);
    await fireEvent.click(screen.getAllByRole('button', { name: /^Save / })[0]!);
    await waitFor(() => expect(window.location.hash).toBe(projectHomeHash('manual-project:taxes')));
    expect(send).toHaveBeenCalledWith({ type: 'projects.saveGroup', groupId: 5 });
  });

  it('a refused save (e.g. a name clash) shows its message and stays', async () => {
    withGroups({ ok: false, error: 'A project named “Taxes” already exists. Rename the group first, then save it.' });
    render(Projects);
    await fireEvent.click((await screen.findAllByRole('button', { name: /^Save / }))[0]!);
    expect((await screen.findByRole('alert')).textContent).toContain('already exists');
    expect(window.location.hash).toBe('');
  });

  it('with Manual projects off, no list is offered', async () => {
    withGroups(undefined, true);
    render(Projects);
    await screen.findByText(/Manual projects are turned off\./);
    expect(screen.queryByText('Save a group')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save / })).toBeNull();
  });

  it('shows an error handed in by the context menu', async () => {
    render(Projects, { initialError: 'This tab is not in a group.' });
    expect((await screen.findByRole('alert')).textContent).toContain('This tab is not in a group.');
  });
});

describe('Projects page: Open / Saved / Archived (M4 T9)', () => {
  const saved = (id: string, title: string, o: Partial<SavedProjectData> = {}): SavedProjectData => ({ id, key: id, title, savedCount: 2, held: 0, updatedAt: 1, ...o });
  let lists: { saved: SavedProjectData[]; archived: SavedProjectData[] };
  let open: ProjectCardData[];
  const calls = (type: string) => send.mock.calls.map((c) => c[0] as { type: string }).filter((r) => r.type === type);
  beforeEach(() => {
    open = [
      { ...card('jira-ticket-either:ABC-1', 'ABC-1'), status: { name: 'Done', category: 'done', via: 'api' }, done: true },
      { ...card('jira-ticket-either:ABC-2', 'ABC-2'), status: { name: 'Done', category: 'done', via: 'api' }, done: false }, // stale Done
    ];
    lists = { saved: [saved('manual-project:taxes', 'Taxes')], archived: [saved('jira-ticket-either:ABC-0', 'ABC-0', { archivedAt: 3, held: 1 }), saved('manual-project:old', 'Old', { archivedAt: 2 })] };
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'projects.list') return { ok: true, data: open };
      if (req.type === 'projects.savedLists') return { ok: true, data: lists };
      if (req.type === 'projects.closeAndArchive') return { ok: true, data: { closed: 1, skipped: 0, ids: ['rc1'] } };
      return { ok: true, data: null };
    });
  });
  const section = (name: string) => screen.findByRole('region', { name });

  it('lists each project under its section, linking to its home', async () => {
    render(Projects);
    const o = await section('Open');
    expect(within(o).getAllByRole('link').map((a) => a.textContent)).toEqual(['ABC-1', 'ABC-2']);
    const s = await section('Saved');
    await waitFor(() => expect(within(s).getAllByRole('link').map((a) => a.textContent)).toEqual(['Taxes']));
    expect(within(s).getByRole('link', { name: 'Taxes' }).getAttribute('href')).toBe(projectHomeHash('manual-project:taxes'));
    expect(s.textContent).toContain('2 saved tabs');
    const a = await section('Archived');
    expect(within(a).getAllByRole('link').map((x) => x.textContent)).toEqual(['ABC-0', 'Old']);
  });

  it('Close and archive only on an open card whose ticket is Done by fresh data (M3-R90)', async () => {
    render(Projects);
    const o = await section('Open');
    expect(within(o).getAllByRole('button', { name: /^Close and archive/ })).toHaveLength(1);
    await fireEvent.click(within(o).getByRole('button', { name: 'Close and archive ABC-1' }));
    expect(calls('projects.closeAndArchive')).toEqual([{ type: 'projects.closeAndArchive', projectId: 'jira-ticket-either:ABC-1' }]);
  });

  it('Saved: Reopen and Archive; Archived: "Archived: reopen?" when a rule assigns its key, Reopen and Unarchive', async () => {
    render(Projects);
    const s = await section('Saved');
    await fireEvent.click(await within(s).findByRole('button', { name: 'Reopen Taxes' }));
    expect(calls('projects.reopen')).toEqual([{ type: 'projects.reopen', projectId: 'manual-project:taxes' }]);
    await fireEvent.click(within(s).getByRole('button', { name: 'Archive Taxes' }));
    expect(calls('projects.archive')).toEqual([{ type: 'projects.archive', projectId: 'manual-project:taxes' }]);
    const a = await section('Archived');
    const abc = within(a).getByRole('link', { name: 'ABC-0' }).closest('li')!;
    expect(abc.textContent).toContain('Archived: reopen?');
    expect(within(a).getByRole('link', { name: 'Old' }).closest('li')!.textContent).not.toContain('reopen?');
    await fireEvent.click(within(a).getByRole('button', { name: 'Unarchive Old' }));
    expect(calls('projects.unarchive')).toEqual([{ type: 'projects.unarchive', projectId: 'manual-project:old' }]);
    await fireEvent.click(within(a).getByRole('button', { name: 'Reopen ABC-0' }));
    expect(calls('projects.reopen').at(-1)).toEqual({ type: 'projects.reopen', projectId: 'jira-ticket-either:ABC-0' });
  });

  it('M4-R6: live, re-read on config.changed', async () => {
    render(Projects);
    await section('Saved');
    lists = { saved: [saved('manual-project:taxes', 'Taxes'), saved('manual-project:new', 'New one')], archived: [] };
    await (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> }).trigger({ type: 'config.changed', rev: 'r2' });
    expect(await screen.findByRole('link', { name: 'New one' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Old' })).toBeNull());
  });

  it('popup card: a fresh Done ticket offers Close and archive in its Done prompt', async () => {
    render(PopupProjects);
    await fireEvent.click(await screen.findByRole('button', { name: 'Close and archive' }));
    expect(calls('projects.closeAndArchive')).toEqual([{ type: 'projects.closeAndArchive', projectId: 'jira-ticket-either:ABC-1' }]);
  });
});

describe('Project home', () => {
  it('shows the project and links back to the list', async () => {
    render(ProjectHome, { id: 'repo:acme/web' });
    expect(await screen.findByRole('heading', { name: 'acme/web' })).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Projects' }) as HTMLAnchorElement).getAttribute('href')).toBe('#/projects');
  });
});

describe('card title links', () => {
  it('popup App: the title link opens options.html at the project route', async () => {
    send.mockImplementation(async (req: { type: string }) => {
      switch (req.type) {
        case 'projects.list': case 'projects.home': return reply(req);
        case 'views.list': return { ok: true, data: [{ id: 'projects', tab: 'Projects', kind: 'projects', actions: [], count: 0 }] };
        case 'safety.status': return { ok: true, data: { paused: false, locked: [] } };
        case 'recent.list': return { ok: true, data: [] };
        default: return { ok: true, data: null };
      }
    });
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never);
    vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(Popup);
    (await screen.findByRole('link', { name: 'acme/web' })).click();
    await waitFor(() => expect(create).toHaveBeenCalledWith({ url: `${fakeBrowser.runtime.getURL('/options.html')}#/project/repo%3Aacme%2Fweb` }));
  });

  it('popup: the title link opens the dashboard tab at the project route', async () => {
    const onOpenProject = vi.fn((id: string) => void id);
    render(PopupProjects, { onOpenProject });
    (await screen.findByRole('link', { name: 'acme/web' })).click();
    expect(onOpenProject).toHaveBeenCalledWith('repo:acme/web');
  });
  it('popup: the title link href is the absolute dashboard URL, and a modified click is left to the browser', async () => {
    const onOpenProject = vi.fn((id: string) => void id);
    render(PopupProjects, { onOpenProject });
    const link = await screen.findByRole('link', { name: 'acme/web' });
    expect(link.getAttribute('href')).toBe(`${fakeBrowser.runtime.getURL('/options.html')}#/project/repo%3Aacme%2Fweb`);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(onOpenProject).not.toHaveBeenCalled();
  });
  it('panel: the link navigates within the panel, and ProjectHome links back to the list', async () => {
    render(Panel);
    (await screen.findByRole('link', { name: 'acme/web' })).click();
    await waitFor(() => expect(window.location.hash).toBe('#/project/repo%3Aacme%2Fweb'));
    expect(await screen.findByRole('heading', { name: 'acme/web' })).toBeTruthy();
    (screen.getByRole('link', { name: 'Projects' }) as HTMLAnchorElement).click();
    await waitFor(() => expect(window.location.hash).toBe('#/projects'));
    expect(await screen.findByRole('link', { name: 'acme/web' })).toBeTruthy();
  });
});

describe('Projects page: project sync (M4 T14b)', () => {
  let status: { enabled: boolean; lastSyncAt?: number; lastResult?: unknown };
  let request: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    status = { enabled: false };
    request = vi.fn(async () => true);
    (fakeBrowser.permissions as unknown as { request: typeof request }).request = request;
    send.mockImplementation(async (req: { type: string; enabled?: boolean }) => {
      if (req.type === 'projects.sync.status') return { ok: true, data: status };
      if (req.type === 'projects.sync.set') { status = { ...status, enabled: !!req.enabled }; return { ok: true, data: status }; }
      return reply(req);
    });
  });
  const toggle = () => screen.findByRole('checkbox', { name: 'Sync kept projects across your devices' }) as Promise<HTMLInputElement>;

  it('shows the toggle off, with no status, until sync has run', async () => {
    render(Projects);
    expect((await toggle()).checked).toBe(false);
    expect(screen.queryByText(/Last synced/)).toBeNull();
  });
  it('turning it on requests the bookmarks permission in the click, then sends projects.sync.set', async () => {
    render(Projects);
    const box = await toggle();
    box.click();
    expect(request).toHaveBeenCalledTimes(1); // synchronously, inside the gesture
    expect(request).toHaveBeenCalledWith({ permissions: ['bookmarks'] });
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'projects.sync.set', enabled: true }));
    await waitFor(() => expect(box.checked).toBe(true));
  });
  it('denied: the toggle stays off, sync.set is not sent, and a plain message says why', async () => {
    request.mockResolvedValue(false);
    render(Projects);
    const box = await toggle();
    box.click();
    expect(await screen.findByText('Sync stays off: Chrome did not give Tabchef access to your bookmarks.')).toBeTruthy();
    expect(box.checked).toBe(false);
    expect(send).not.toHaveBeenCalledWith({ type: 'projects.sync.set', enabled: true });
  });
  it('turning it off sends sync.set false and keeps the permission', async () => {
    status = { enabled: true };
    const remove = vi.fn();
    (fakeBrowser.permissions as unknown as { remove: typeof remove }).remove = remove;
    render(Projects);
    const box = await toggle();
    await waitFor(() => expect(box.checked).toBe(true));
    box.click();
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'projects.sync.set', enabled: false }));
    await waitFor(() => expect(box.checked).toBe(false));
    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('a failed sync.set shows the error and leaves the toggle as it was', async () => {
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'projects.sync.status') return { ok: true, data: status };
      if (req.type === 'projects.sync.set') return { ok: false, error: 'Allow Tabchef to use your bookmarks first.' };
      return reply(req);
    });
    render(Projects);
    const box = await toggle();
    box.click();
    expect(await screen.findByText('Allow Tabchef to use your bookmarks first.')).toBeTruthy();
    expect(box.checked).toBe(false);
  });
  it('status: last synced time, merged count, and conflicts and ignored folders named in plain words', async () => {
    status = { enabled: true, lastSyncAt: Date.now() - 5 * 60_000, lastResult: {
      merged: 2,
      conflicts: ['project jira:ABC-1: deleted on one device but edited on the other; kept the edit'],
      ignored: ['The Tabchef bookmark folder was missing: no project was removed here, and the kept ones were written again.'],
    } };
    render(Projects);
    expect(await screen.findByText('Last synced 5 min ago. 2 projects merged.')).toBeTruthy();
    expect(screen.getByText('Kept after a conflict (1)')).toBeTruthy();
    expect(screen.getByText('project jira:ABC-1: deleted on one device but edited on the other; kept the edit')).toBeTruthy();
    expect(screen.getByText('Skipped (1)')).toBeTruthy();
    expect(screen.getByText(/The Tabchef bookmark folder was missing/)).toBeTruthy();
  });
  it('status: a failed last sync shows its error; no result yet reads "Not synced yet."', async () => {
    status = { enabled: true, lastSyncAt: Date.now(), lastResult: { error: 'bookmarks unavailable' } };
    render(Projects);
    expect(await screen.findByText('The last sync failed: bookmarks unavailable')).toBeTruthy();
    cleanup();
    status = { enabled: true };
    render(Projects);
    expect(await screen.findByText('Not synced yet.')).toBeTruthy();
  });
  it('a failing sync.status does not break the page', async () => {
    send.mockImplementation(async (req: { type: string }) => (req.type === 'projects.sync.status' ? { ok: false, error: 'x' } : reply(req)));
    render(Projects);
    expect(await screen.findByRole('link', { name: 'acme/web' })).toBeTruthy();
    expect((await toggle()).checked).toBe(false);
  });
});

describe('Projects page: sync help tip (M4 T14b)', () => {
  it('covers unchanged-only deletes, open projects only no longer kept, and a missing folder deleting nothing', async () => {
    render(Projects);
    const btn = await screen.findByRole('button', { name: 'About Sync kept projects across your devices' });
    const tip = document.getElementById(btn.getAttribute('aria-describedby')!)!.textContent!;
    expect(tip).toContain('visible Tabchef folder in Other bookmarks');
    expect(tip).toContain('only if it has not changed there since the last sync; otherwise it stays and is listed here');
    expect(tip).toContain('A project with tabs open on a device is not removed there, only no longer kept.');
    expect(tip).toContain('If the Tabchef folder is missing, nothing is deleted and your projects are written again.');
    expect(tip).toContain('extensions cannot hide them');
  });
});
