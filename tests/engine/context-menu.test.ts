import { describe, it, expect, vi } from 'vitest';
import {
  createProjectMenu, installMenus, MENU_CONTEXTS, MENU_IDS, onMenuClick, refreshMenus, type MenuApi,
} from '../../src/engine/context-menu';
import { explainHash, matchRoute, newRuleHash, OPTIONS_ROUTES, projectHomeHash, projectsErrorHash } from '../../src/ui/routes';

const api = (): MenuApi & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    removeAll: vi.fn(async () => { calls.push('removeAll'); }),
    create: vi.fn((p: { id: string }) => { calls.push(`create:${p.id}`); }),
    update: vi.fn(async () => {}),
    remove: vi.fn(async (id: string) => { calls.push(`remove:${id}`); }),
  };
};

/** Chrome's menu as create / update / remove / removeAll leave it (id → parentId, enabled), recording every call. */
const chromeMenu = (seed: [id: string, parentId?: string][] = []) => {
  const items = new Map<string, { parentId?: string; enabled: boolean }>(seed.map(([id, parentId]) => [id, { parentId, enabled: true }]));
  const calls: string[] = [];
  const drop = (id: string) => { items.delete(id); for (const [c, it] of [...items]) if (it.parentId === id) drop(c); };
  const a: MenuApi = {
    removeAll: async () => { calls.push('removeAll'); items.clear(); },
    create: (p) => { calls.push(`create:${p.id}`); items.set(p.id, { parentId: p.parentId, enabled: p.enabled ?? true }); },
    update: async (id, p) => {
      if (!items.has(id)) throw new Error(`Cannot find menu item with id ${id}`);
      if (p.enabled !== undefined) items.get(id)!.enabled = p.enabled;
    },
    remove: async (id) => { calls.push(`remove:${id}`); if (!items.has(id)) throw new Error(`Cannot find menu item with id ${id}`); drop(id); },
  };
  return { api: a, items, calls };
};
/** Every item installMenus creates with the projects A-1 (`tc-project:r:A-1`). */
const FULL_MENU: [string, string?][] = [
  ['tc-group'], ['tc-close'], ['tc-allowdup'], ['tc-lock'], ['tc-why'], ['tc-save-group'],
  ['tc-project'], ['tc-project:r:A-1', 'tc-project'], ['tc-project-new', 'tc-project'], ['tc-project-remove'],
];
/** storage.session as the menu uses it. */
const sessionArea = (init: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: vi.fn(async (k: string | string[]) => Object.fromEntries([k].flat().filter((x) => x in data).map((x) => [x, data[x]]))),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
  };
};
const A1 = [{ id: 'r:A-1', title: 'A-1' }];
/** The top-level items Chrome shows, in its order. */
const tops = (items: Map<string, { parentId?: string }>) => [...items].filter(([, it]) => !it.parentId).map(([id]) => id);

describe('context menu (M2 T16)', () => {
  it('installMenus removes stale items first, then creates the items with their exact titles and contexts', async () => {
    const a = api();
    await installMenus(a);
    expect(a.calls[0]).toBe('removeAll');
    const created = (a.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(created.map((c) => [c.id, c.title])).toEqual([
      ['tc-group', 'Group pages like this under…'],
      ['tc-close', 'Auto-close pages like this'],
      ['tc-allowdup', 'Allow duplicates of pages like this'],
      ['tc-lock', 'Lock this tab'],
      ['tc-why', 'Why is this tab here?'],
      ['tc-save-group', 'Save group as project'],
      ['tc-project', 'Add to project'],
      ['tc-project-new', 'New project…'],
      ['tc-project-remove', 'Remove from project'],
    ]);
    for (const c of created) expect(c.contexts).toEqual([...MENU_CONTEXTS]);
    // M4 T6: on with no open project too, for its New project… child.
    expect(created.find((c) => c.id === 'tc-project').enabled).toBe(true);
    expect(created.find((c) => c.id === 'tc-project-new').parentId).toBe('tc-project');
    expect(MENU_CONTEXTS).toEqual(['page', 'link', 'action']);
  });

  it('on activation of an exempt tab (chrome://) every item is disabled', async () => {
    const a = api();
    await refreshMenus(a, { id: 3, url: 'chrome://settings' }, () => false);
    const up = (a.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(up.map((c) => c[0]).sort()).toEqual([...Object.values(MENU_IDS)].sort()); // not the project items
    for (const c of up) expect(c[1].enabled).toBe(false);
  });

  it('on activation of a web tab items are enabled and the lock title follows the lock state', async () => {
    const a = api();
    await refreshMenus(a, { id: 3, url: 'https://github.com/' }, (id) => id === 3);
    const up = (a.update as ReturnType<typeof vi.fn>).mock.calls;
    for (const c of up) expect(c[1].enabled).toBe(true);
    expect(up.find((c) => c[0] === 'tc-lock')![1].title).toBe('Unlock this tab');
    const b = api();
    await refreshMenus(b, { id: 3, url: 'https://github.com/' }, () => false);
    expect((b.update as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'tc-lock')![1].title).toBe('Lock this tab');
  });

  it('a failed update (items not created yet) never rejects', async () => {
    const a = api();
    a.update = vi.fn(async () => { throw new Error('Cannot find menu item'); });
    await expect(refreshMenus(a, { id: 1, url: 'https://x.com/' }, () => false)).resolves.toBeUndefined();
  });

  const deps = (locked = false) => {
    const state = { locked };
    return {
      state,
      openPage: vi.fn(),
      safety: {
        isLocked: vi.fn(() => state.locked),
        lock: vi.fn(() => { state.locked = true; }),
        unlock: vi.fn(() => { state.locked = false; }),
      },
      refresh: vi.fn(),
    };
  };
  const tab = { id: 9, url: 'https://github.com/acme/api/pull/1' };

  it('tc-group / tc-close / tc-allowdup open NewRule with the page URL, or the link URL on a link', async () => {
    const d = deps();
    await onMenuClick({ menuItemId: 'tc-group', pageUrl: tab.url }, tab, d);
    await onMenuClick({ menuItemId: 'tc-close', pageUrl: tab.url, linkUrl: 'https://x.com/a' }, tab, d);
    await onMenuClick({ menuItemId: 'tc-allowdup' }, tab, d); // action context: no pageUrl, the tab's URL
    expect(d.openPage.mock.calls.map((c) => c[0])).toEqual([
      newRuleHash(tab.url, 'group'), newRuleHash('https://x.com/a', 'close'), newRuleHash(tab.url, 'allowDup'),
    ]);
    expect(matchRoute([{ path: '/rules' }, { path: '/rules/new' }], newRuleHash(tab.url, 'group')))
      .toEqual({ path: '/rules/new', params: { url: tab.url, kind: 'group' } });
  });

  it('tc-lock toggles the SafetyService lock directly and refreshes the title', async () => {
    const d = deps();
    await onMenuClick({ menuItemId: 'tc-lock' }, tab, d);
    expect(d.safety.lock).toHaveBeenCalledWith(9);
    await onMenuClick({ menuItemId: 'tc-lock' }, tab, d);
    expect(d.safety.unlock).toHaveBeenCalledWith(9);
    expect(d.refresh).toHaveBeenCalledTimes(2);
    expect(d.openPage).not.toHaveBeenCalled();
  });

  it('tc-why opens the explain route of the tab (R54)', async () => {
    const d = deps();
    await onMenuClick({ menuItemId: 'tc-why' }, tab, d);
    expect(d.openPage).toHaveBeenCalledWith(explainHash(9));
  });

  it('ignores exempt tabs, unknown items and clicks without a tab', async () => {
    const d = deps();
    await onMenuClick({ menuItemId: 'tc-lock' }, { id: 1, url: 'chrome://settings' }, d);
    await onMenuClick({ menuItemId: 'tc-why' }, undefined, d);
    await onMenuClick({ menuItemId: 'other' }, tab, d);
    expect(d.safety.lock).not.toHaveBeenCalled();
    expect(d.openPage).not.toHaveBeenCalled();
  });

  it('createProjectMenu: one child of tc-project per open project; rebuilt only when the projects change', async () => {
    const a = api();
    const { sync } = createProjectMenu(a);
    await sync([{ id: 'r:ABC-1', title: 'ABC-1' }, { id: 'r:ABC-2', title: 'ABC-2 · Login' }]);
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:ABC-1', 'create:tc-project:r:ABC-2', 'create:tc-project-new', 'create:tc-project-remove']);
    const created = (a.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(created.at(-5)).toMatchObject({ id: 'tc-project', title: 'Add to project', enabled: true });
    expect(created.at(-4)).toMatchObject({ id: 'tc-project:r:ABC-1', parentId: 'tc-project', title: 'ABC-1' });
    a.calls.length = 0;
    await sync([{ id: 'r:ABC-1', title: 'ABC-1' }, { id: 'r:ABC-2', title: 'ABC-2 · Login' }]);
    expect(a.calls).toEqual([]);
    await sync([]);
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project-new', 'create:tc-project-remove']);
    expect((a.create as ReturnType<typeof vi.fn>).mock.calls.at(-3)![0]).toMatchObject({ id: 'tc-project', enabled: true });
  });

  it('a project child adds the tab to that project; Remove from project removes it', async () => {
    const d = { ...deps(), projects: { addTab: vi.fn(async () => {}), removeTab: vi.fn(async () => {}), saveGroup: vi.fn(async () => '') } };
    await onMenuClick({ menuItemId: 'tc-project:jira-ticket-title:ABC-1' }, tab, d);
    expect(d.projects.addTab).toHaveBeenCalledWith(9, 'jira-ticket-title:ABC-1');
    await onMenuClick({ menuItemId: 'tc-project-remove' }, tab, d);
    expect(d.projects.removeTab).toHaveBeenCalledWith(9);
    await onMenuClick({ menuItemId: 'tc-project:x' }, { id: 1, url: 'chrome://settings' }, d);
    expect(d.projects.addTab).toHaveBeenCalledTimes(1);
  });

  it('M4 T6: New project… opens the Projects page with the tab to put in the new project', async () => {
    const d = deps();
    await onMenuClick({ menuItemId: 'tc-project-new' }, tab, d);
    expect(d.openPage).toHaveBeenCalledWith('#/projects?new=9');
    expect(matchRoute(OPTIONS_ROUTES, '#/projects?new=9')).toEqual({ path: '/projects', params: { new: '9' } });
    await onMenuClick({ menuItemId: 'tc-project-new' }, { id: 1, url: 'chrome://settings' }, d);
    expect(d.openPage).toHaveBeenCalledTimes(1);
  });

  it('M4 T8: Save group as project saves the tab\'s group and opens the new project\'s home', async () => {
    const d = { ...deps(), projects: { addTab: vi.fn(), removeTab: vi.fn(), saveGroup: vi.fn(async () => 'manual-project:taxes') }, };
    await onMenuClick({ menuItemId: 'tc-save-group' }, { ...tab, groupId: 5 }, d);
    expect(d.projects.saveGroup).toHaveBeenCalledWith(5);
    expect(d.openPage).toHaveBeenCalledWith(projectHomeHash('manual-project:taxes'));
    expect(d.openPage).toHaveBeenCalledTimes(1);
  });

  it('M4 T8: an engine error is reported, not swallowed; an ungrouped tab says so; exempt pages do nothing', async () => {
    const saveGroup = vi.fn(async () => { throw new Error('turn on the recipe Manual projects first'); });
    const d = { ...deps(), projects: { addTab: vi.fn(), removeTab: vi.fn(), saveGroup }, };
    await onMenuClick({ menuItemId: 'tc-save-group' }, { ...tab, groupId: 5 }, d);
    expect(d.openPage).toHaveBeenCalledWith(projectsErrorHash('turn on the recipe Manual projects first'));
    expect(matchRoute(OPTIONS_ROUTES, projectsErrorHash('a b: c')).params).toEqual({ error: 'a b: c' });
    await onMenuClick({ menuItemId: 'tc-save-group' }, { ...tab, groupId: -1 }, d);
    await onMenuClick({ menuItemId: 'tc-save-group' }, tab, d);
    expect(d.openPage).toHaveBeenLastCalledWith(projectsErrorHash('This tab is not in a group.'));
    expect(d.openPage).toHaveBeenCalledTimes(3);
    expect(saveGroup).toHaveBeenCalledTimes(1);
    await onMenuClick({ menuItemId: 'tc-save-group' }, { id: 1, url: 'chrome://settings', groupId: 5 }, d);
    expect(saveGroup).toHaveBeenCalledTimes(1);
  });

  it('#223: the first sync after a worker start re-creates only the project items, and resolves true so the caller refreshes', async () => {
    const a = api();
    const m = createProjectMenu(a);
    expect(await m.sync([])).toBe(true); // the projects shown before this worker started are unknown
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project-new', 'create:tc-project-remove']);
    a.calls.length = 0;
    expect(await m.sync(A1)).toBe(true);
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:A-1', 'create:tc-project-new', 'create:tc-project-remove']);
    a.calls.length = 0;
    expect(await m.sync(A1)).toBe(false); // the same list: nothing re-created, nothing to refresh
    expect(a.calls).toEqual([]);
  });

  it('#223: a wake with nothing missing re-creates nothing: no removeAll, no rule items, not even the same project list', async () => {
    const chrome = chromeMenu(FULL_MENU);
    const session = sessionArea({ contextMenuProjects: A1 }); // the list the previous worker showed
    const m = createProjectMenu(chrome.api, { session });
    expect(await m.repair()).toBe(false);
    expect(await m.sync(A1)).toBe(false); // the first pass lists the same projects
    expect(chrome.calls).toEqual([]);
    expect(await m.sync([...A1, { id: 'r:B-1', title: 'B-1' }])).toBe(true); // a changed list: only the project items
    expect(chrome.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:A-1', 'create:tc-project:r:B-1', 'create:tc-project-new', 'create:tc-project-remove']);
    expect(session.data.contextMenuProjects).toEqual([...A1, { id: 'r:B-1', title: 'B-1' }]); // the next worker starts from it
  });

  it('#223: a wake with no pass repairs lost items with the last known projects (open ticket projects kept)', async () => {
    const chrome = chromeMenu(FULL_MENU.filter(([id]) => id.startsWith('tc-project'))); // Chrome kept only the project items
    const m = createProjectMenu(chrome.api, { session: sessionArea({ contextMenuProjects: A1 }) });
    expect(await m.repair()).toBe(true); // background.ts refreshes titles and enabled state after it
    expect(chrome.calls[0]).toBe('removeAll');
    expect([...chrome.items.keys()].sort()).toEqual(FULL_MENU.map(([id]) => id).sort());
    chrome.calls.length = 0;
    expect(await m.sync(A1)).toBe(false); // the first pass lists the same projects: nothing more to do
    expect(chrome.calls).toEqual([]);
  });

  it('#223: with the projects known, a lost project child or New project… is found and repaired', async () => {
    for (const lostId of ['tc-project:r:A-1', 'tc-project-new']) {
      const chrome = chromeMenu(FULL_MENU.filter(([id]) => id !== lostId));
      const m = createProjectMenu(chrome.api, { session: sessionArea({ contextMenuProjects: A1 }) });
      expect(await m.repair(), lostId).toBe(true);
      expect(chrome.calls[0]).toBe('removeAll');
      expect([...chrome.items.keys()].sort()).toEqual(FULL_MENU.map(([id]) => id).sort());
    }
  });

  it('#223: with the projects unknown (a new browser session), the repair re-creates the lost fixed items and keeps the project items', async () => {
    const chrome = chromeMenu(FULL_MENU.filter(([id]) => id.startsWith('tc-project')));
    const m = createProjectMenu(chrome.api, { session: sessionArea() });
    expect(await m.repair()).toBe(true);
    expect(chrome.calls).not.toContain('removeAll');
    expect(chrome.calls.filter((c) => c.includes('tc-project'))).toEqual([]); // Add to project › keeps A-1 until the first pass
    expect([...chrome.items.keys()].sort()).toEqual(FULL_MENU.map(([id]) => id).sort());
    chrome.calls.length = 0;
    expect(await m.sync([...A1, { id: 'r:B-1', title: 'B-1' }])).toBe(true); // the first pass: the project items, at the end again
    expect(chrome.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:A-1', 'create:tc-project:r:B-1', 'create:tc-project-new', 'create:tc-project-remove']);
    expect(tops(chrome.items)).toEqual(['tc-group', 'tc-close', 'tc-allowdup', 'tc-lock', 'tc-why', 'tc-save-group', 'tc-project', 'tc-project-remove']);
  });

  it('#223: with the projects unknown, only the lost project item is re-created; the fixed items and Chrome\'s children stay', async () => {
    const cases: [lost: string[], calls: string[]][] = [
      [['tc-project-remove'], ['create:tc-project-remove']],
      [['tc-project-new'], ['create:tc-project-new']], // A-1 stays under Add to project
      [['tc-project', 'tc-project:r:A-1', 'tc-project-new'], ['create:tc-project', 'create:tc-project-new']],
    ];
    for (const [lost, calls] of cases) {
      const chrome = chromeMenu(FULL_MENU.filter(([id]) => !lost.includes(id)));
      expect(await createProjectMenu(chrome.api).repair(), lost[0]).toBe(true);
      expect(chrome.calls, lost[0]).toEqual(calls);
    }
  });

  it('#223: with the projects unknown and Add to project lost too, the repair creates it with New project… only', async () => {
    const chrome = chromeMenu();
    const m = createProjectMenu(chrome.api);
    expect(await m.repair()).toBe(true);
    expect([...chrome.items.keys()].sort()).toEqual(FULL_MENU.map(([id]) => id).filter((id) => id !== 'tc-project:r:A-1').sort());
    chrome.calls.length = 0;
    expect(await m.sync(A1)).toBe(true); // the first pass adds the projects
    expect(chrome.items.has('tc-project:r:A-1')).toBe(true);
  });

  it('#223: a failed rebuild rejects and the next sync rebuilds every item, even with the same list', async () => {
    const chrome = chromeMenu(FULL_MENU.filter(([id]) => id !== 'tc-lock'));
    const removeAll = chrome.api.removeAll;
    chrome.api.removeAll = vi.fn().mockRejectedValueOnce(new Error('removeAll failed')).mockImplementation(removeAll);
    const m = createProjectMenu(chrome.api, { session: sessionArea({ contextMenuProjects: A1 }) });
    await expect(m.repair()).rejects.toThrow('removeAll failed');
    expect(chrome.items.has('tc-lock')).toBe(false);
    expect(await m.sync(A1)).toBe(true); // the list shown, but the rebuild is still owed
    expect(chrome.calls[0]).toBe('removeAll');
    expect([...chrome.items.keys()].sort()).toEqual(FULL_MENU.map(([id]) => id).sort());
    chrome.calls.length = 0;
    expect(await m.sync(A1)).toBe(false); // done: the same list does nothing again
    expect(chrome.calls).toEqual([]);
  });

  it('#223: an unreadable or malformed stored project list counts as unknown; storage failures are logged', async () => {
    for (const stored of [{ contextMenuProjects: 'x' }, { contextMenuProjects: [{ id: 1 }] }]) {
      const chrome = chromeMenu(FULL_MENU.filter(([id]) => id.startsWith('tc-project')));
      expect(await createProjectMenu(chrome.api, { session: sessionArea(stored) }).repair()).toBe(true);
      expect(chrome.calls).not.toContain('removeAll'); // not a full rebuild with a made-up list
    }
    const readErr = new Error('read failed');
    const writeErr = new Error('write failed');
    const broken = { get: vi.fn(async () => { throw readErr; }), set: vi.fn(async () => { throw writeErr; }) };
    const warn = vi.fn();
    const m = createProjectMenu(api(), { session: broken, warn });
    expect(await m.sync(A1)).toBe(true);
    expect(await m.sync(A1)).toBe(false);
    expect(warn.mock.calls).toEqual([['context menu projects read', readErr], ['context menu projects write', writeErr]]);
  });

  it('M3-R71: overlapping syncs and an install run one at a time; install re-adds the last projects', async () => {
    const a = api();
    let release!: () => void;
    let first = true;
    a.remove = vi.fn(async (id: string) => {
      a.calls.push(`remove:${id}`);
      if (first) { first = false; await new Promise<void>((r) => { release = r; }); }
    });
    const m = createProjectMenu(a);
    const one = m.sync([{ id: 'r:A-1', title: 'A-1' }]);
    const two = m.sync([{ id: 'r:B-1', title: 'B-1' }]);
    const inst = m.install();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove']); // the second sync waits
    release();
    await Promise.all([one, two, inst]);
    const rules = ['create:tc-group', 'create:tc-close', 'create:tc-allowdup', 'create:tc-lock', 'create:tc-why', 'create:tc-save-group'];
    expect(a.calls.slice(2)).toEqual([
      'create:tc-project', 'create:tc-project:r:A-1', 'create:tc-project-new', 'create:tc-project-remove',
      'remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:B-1', 'create:tc-project-new', 'create:tc-project-remove',
      'removeAll', ...rules, 'create:tc-project', 'create:tc-project:r:B-1', 'create:tc-project-new', 'create:tc-project-remove',
    ]);
    a.calls.length = 0;
    await m.sync([{ id: 'r:B-1', title: 'B-1' }]);
    expect(a.calls).toEqual([]);
  });
});
