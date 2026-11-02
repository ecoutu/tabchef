import { describe, it, expect, vi } from 'vitest';
import {
  createProjectMenu, installMenus, MENU_CONTEXTS, MENU_IDS, onMenuClick, refreshMenus, type MenuApi,
} from '../../src/engine/context-menu';
import { explainHash, matchRoute, newRuleHash } from '../../src/ui/routes';

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

describe('context menu (M2 T16)', () => {
  it('installMenus removes stale items first, then creates the items with their exact titles and contexts', async () => {
    const a = api();
    await installMenus(a);
    expect(a.calls[0]).toBe('removeAll');
    const created = (a.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(created.map((c) => [c.id, c.title])).toEqual([
      ['tc-group', 'Group pages like this under…'],
      ['tc-close', 'Auto-close pages like this'],
      ['tc-allowdup', 'Never dedupe this site'],
      ['tc-lock', 'Lock this tab'],
      ['tc-why', 'Why is this tab here?'],
      ['tc-project', 'Add to project'],
      ['tc-project-remove', 'Remove from project'],
    ]);
    for (const c of created) expect(c.contexts).toEqual([...MENU_CONTEXTS]);
    expect(created.find((c) => c.id === 'tc-project').enabled).toBe(false); // no open project yet
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
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:ABC-1', 'create:tc-project:r:ABC-2', 'create:tc-project-remove']);
    const created = (a.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(created[0]).toMatchObject({ id: 'tc-project', title: 'Add to project', enabled: true });
    expect(created[1]).toMatchObject({ id: 'tc-project:r:ABC-1', parentId: 'tc-project', title: 'ABC-1' });
    a.calls.length = 0;
    await sync([{ id: 'r:ABC-1', title: 'ABC-1' }, { id: 'r:ABC-2', title: 'ABC-2 · Login' }]);
    expect(a.calls).toEqual([]);
    await sync([]);
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project-remove']);
    expect((a.create as ReturnType<typeof vi.fn>).mock.calls.at(-2)![0]).toMatchObject({ id: 'tc-project', enabled: false });
  });

  it('a project child adds the tab to that project; Remove from project removes it', async () => {
    const d = { ...deps(), projects: { addTab: vi.fn(async () => {}), removeTab: vi.fn(async () => {}) } };
    await onMenuClick({ menuItemId: 'tc-project:jira-ticket-title:ABC-1' }, tab, d);
    expect(d.projects.addTab).toHaveBeenCalledWith(9, 'jira-ticket-title:ABC-1');
    await onMenuClick({ menuItemId: 'tc-project-remove' }, tab, d);
    expect(d.projects.removeTab).toHaveBeenCalledWith(9);
    await onMenuClick({ menuItemId: 'tc-project:x' }, { id: 1, url: 'chrome://settings' }, d);
    expect(d.projects.addTab).toHaveBeenCalledTimes(1);
  });

  it('M3-R71: overlapping syncs and an install run one at a time; install re-adds the last projects', async () => {
    const a = api();
    let release!: () => void;
    let first = true;
    a.remove = vi.fn(async (id: string) => {
      a.calls.push(`remove:${id}`);
      if (first && id === 'tc-project') { first = false; await new Promise<void>((r) => { release = r; }); }
    });
    const m = createProjectMenu(a);
    const one = m.sync([{ id: 'r:A-1', title: 'A-1' }]);
    const two = m.sync([{ id: 'r:B-1', title: 'B-1' }]);
    const inst = m.install();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.calls).toEqual(['remove:tc-project', 'remove:tc-project-remove']); // the second sync waits
    release();
    await Promise.all([one, two, inst]);
    expect(a.calls.slice(2)).toEqual([
      'create:tc-project', 'create:tc-project:r:A-1', 'create:tc-project-remove',
      'remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:B-1', 'create:tc-project-remove',
      'removeAll', 'create:tc-group', 'create:tc-close', 'create:tc-allowdup', 'create:tc-lock', 'create:tc-why', 'create:tc-project', 'create:tc-project-remove',
      'remove:tc-project', 'remove:tc-project-remove', 'create:tc-project', 'create:tc-project:r:B-1', 'create:tc-project-remove',
    ]);
    a.calls.length = 0;
    await m.sync([{ id: 'r:B-1', title: 'B-1' }]);
    expect(a.calls).toEqual([]);
  });
});
