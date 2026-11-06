// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
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
