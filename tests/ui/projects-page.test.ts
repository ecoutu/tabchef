// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ProjectCardData, ProjectHomeData } from '../../src/core/projects/types';

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
