// The Project home view model (M4 T4): ProjectHomeData (projects.home) shaped for ProjectHome.svelte.
import { describe, expect, it } from 'vitest';
import { buildProjectHome } from '../../src/ui/project-home-model';
import { staleText } from '../../src/ui/projects-model';
import type { ProjectHomeData } from '../../src/core/projects/types';

const T = (tabId: number, o: Partial<ProjectHomeData['tabs'][number]> = {}): ProjectHomeData['tabs'][number] => ({
  tabId, windowId: 1, title: `Tab ${tabId}`, url: `https://example.com/${tabId}`, ...o,
});
const data = (o: Partial<ProjectHomeData> = {}): ProjectHomeData => ({
  id: 'r:ABC-1', key: 'ABC-1', title: 'ABC-1 · Login fails', done: false,
  tabs: [T(1), T(2, { pill: 'open' }), T(3, { pill: 'merged', stale: true }), T(4, { pill: 'unknown' })],
  linked: [
    { url: 'https://github.com/a/b/pull/1', title: 'PR 1', state: 'open' },
    { url: 'https://github.com/a/b/pull/2', title: 'PR 2', state: 'unknown' },
  ],
  groups: [
    { title: 'ABC-1', color: 'blue', windowId: 1, tabIds: [3, 1] },
    { title: '', color: 'grey', windowId: 2, tabIds: [2, 4] },
  ],
  settings: { container: 'group', placement: ['existing', 'current'], join: ['rules', 'manual'], onOpenElsewhere: 'move-and-follow', onSwitchAway: 'unload' },
  recipeName: 'Jira ticket',
  ...o,
});

describe('buildProjectHome (M4 T4)', () => {
  it('counts a PR once across its conversation and /files tabs, a duplicate tab, and its linked entry', () => {
    const v = buildProjectHome(data({
      tabs: [
        T(1, { url: 'https://github.com/a/b/pull/7', pill: 'open' }),
        T(2, { url: 'https://github.com/a/b/pull/7/files', pill: 'open' }),
        T(3, { url: 'https://github.com/a/b/pull/7#issuecomment-1', pill: 'open' }),
      ],
      linked: [{ url: 'https://github.com/a/b/pull/7', title: 'PR 7', state: 'open' }],
      groups: [],
    }));
    expect(v.prCounts).toEqual([{ state: 'open', count: 1 }]);
    expect(v.prSummary).toBe('1 open');
  });
  it('PR counts cover open tabs and linked PRs and exclude unknown (M3-R45)', () => {
    const v = buildProjectHome(data());
    expect(v.prCounts).toEqual([{ state: 'open', count: 2 }, { state: 'merged', count: 1 }]);
    expect(v.prSummary).toBe('2 open · 1 merged');
  });

  it('no PRs: no counts and an empty summary', () => {
    const v = buildProjectHome(data({ tabs: [T(1)], linked: [], groups: [{ title: 'A', color: 'blue', windowId: 1, tabIds: [1] }] }));
    expect(v.prCounts).toEqual([]);
    expect(v.prSummary).toBe('');
  });

  it('groups keep their tab-bar order and list their tabs in it; a stale pill\'s tooltip is staleText; unknown is no pill', () => {
    const v = buildProjectHome(data());
    expect(v.groups.map((g) => [g.title, g.color, g.tabs.map((t) => t.tabId)])).toEqual([
      ['ABC-1', 'blue', [3, 1]],
      ['Not in a group', 'grey', [2, 4]],
    ]);
    const t3 = v.groups[0]!.tabs[0]!;
    expect(t3).toMatchObject({ pill: 'merged', stale: true, staleTip: staleText('GitHub') });
    expect(v.groups[0]!.tabs[1]).not.toHaveProperty('staleTip');
    expect(v.groups[1]!.tabs[1]).not.toHaveProperty('pill');
    expect(v.firstTabId).toBe(3);
  });

  it('header: title, status chip tone, Close group offered when the ticket is done', () => {
    const v = buildProjectHome(data({ status: { name: 'In Progress', category: 'indeterminate', via: 'api' } }));
    expect(v).toMatchObject({ id: 'r:ABC-1', title: 'ABC-1 · Login fails', status: { label: 'In Progress', tone: 'progress' }, done: false });
    expect(buildProjectHome(data({ done: true })).done).toBe(true);
  });

  it('linked PRs not open keep their states, without unknown', () => {
    expect(buildProjectHome(data()).linked).toEqual([
      { url: 'https://github.com/a/b/pull/1', title: 'PR 1', state: 'open' },
      { url: 'https://github.com/a/b/pull/2', title: 'PR 2' },
    ]);
  });

  it('settings in plain words, each with a help tip, and the recipe they come from', () => {
    const v = buildProjectHome(data({ settings: { container: 'window', placement: ['home:work', 'new'], join: ['opener', 'window'], onOpenElsewhere: 'leave', onSwitchAway: 'close-and-save' } }));
    expect(v.recipeName).toBe('Jira ticket');
    expect(v.settings.map((s) => [s.label, s.value])).toEqual([
      ['Container', 'Its own window'],
      ['Placement', 'The shared window "work", then a new window'],
      ['Joins by', 'Tabs it opens, new tabs in its window'],
      ['Opened elsewhere', 'Leave the tab where it opened'],
      ['Switching away', 'Close its tabs and save them'],
    ]);
    for (const s of v.settings) expect(s.help.length, s.label).toBeGreaterThan(20);
    expect(buildProjectHome(data()).settings.map((s) => s.value)).toEqual([
      'A tab group', 'The window it is already in, then the current window', 'Rules, added by hand',
      'Move the tab into the project and follow it', 'Collapse and unload its tabs',
    ]);
  });
});
