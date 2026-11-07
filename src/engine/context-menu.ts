import { isExemptUrl } from '../core/url/normalize';
import { explainHash, newProjectHash, newRuleHash, projectHomeHash, projectsErrorHash, type NewRuleKind } from '../core/links';
import type { ProjectService } from './projects';
import type { SafetyService } from './safety';

// The page / link / toolbar-icon context menu (M2 T16). Items are created on runtime.onInstalled (they persist across
// worker restarts); background.ts registers contextMenus.onClicked at the top level and refreshes the items' title and
// enabled state on tab activation, URL changes of the active tab and lock changes.
// M3 T15: "Add to project" (`tc-project`) has one child per open project (`tc-project:<projectId>`), rebuilt by
// createProjectMenu when the open projects change; "Remove from project" (`tc-project-remove`) follows it.
// M4 T6: the last child, "New project…" (`tc-project-new`), opens the Projects page's New project form for the tab.

export const MENU_IDS = { group: 'tc-group', close: 'tc-close', allowDup: 'tc-allowdup', lock: 'tc-lock', why: 'tc-why', saveGroup: 'tc-save-group' } as const;
export const PROJECT_MENU_ID = 'tc-project';
export const PROJECT_REMOVE_MENU_ID = 'tc-project-remove';
export const PROJECT_NEW_MENU_ID = 'tc-project-new';
const PROJECT_CHILD_PREFIX = `${PROJECT_MENU_ID}:`;
export const MENU_CONTEXTS = ['page', 'link', 'action'] as const;
type MenuContext = (typeof MENU_CONTEXTS)[number];

const LOCK_TITLE = 'Lock this tab';
const UNLOCK_TITLE = 'Unlock this tab';
const ITEMS: { id: string; title: string }[] = [
  { id: MENU_IDS.group, title: 'Group pages like this under…' },
  { id: MENU_IDS.close, title: 'Auto-close pages like this' },
  { id: MENU_IDS.allowDup, title: 'Allow duplicates of pages like this' },
  { id: MENU_IDS.lock, title: LOCK_TITLE },
  { id: MENU_IDS.why, title: 'Why is this tab here?' },
  { id: MENU_IDS.saveGroup, title: 'Save group as project' },
];
const KIND: Record<string, NewRuleKind> = { [MENU_IDS.group]: 'group', [MENU_IDS.close]: 'close', [MENU_IDS.allowDup]: 'allowDup' };

/** The chrome.contextMenus calls used (a subset, so tests can fake it). */
export interface MenuApi {
  removeAll(): Promise<void>;
  create(p: { id: string; title: string; contexts: [MenuContext, ...MenuContext[]]; parentId?: string; enabled?: boolean }): void;
  update(id: string, p: { title?: string; enabled?: boolean }): Promise<void>;
  remove(id: string): Promise<void>;
}
const CONTEXTS: [MenuContext, ...MenuContext[]] = [MENU_CONTEXTS[0], ...MENU_CONTEXTS.slice(1)];

/** The project items: the parent with one child per open project and New project…, then Remove. */
function createProjectItems(api: MenuApi, projects: { id: string; title: string }[]): void {
  api.create({ id: PROJECT_MENU_ID, title: 'Add to project', contexts: CONTEXTS, enabled: true });
  for (const p of projects) api.create({ id: `${PROJECT_CHILD_PREFIX}${p.id}`, parentId: PROJECT_MENU_ID, title: p.title, contexts: CONTEXTS });
  api.create({ id: PROJECT_NEW_MENU_ID, parentId: PROJECT_MENU_ID, title: 'New project…', contexts: CONTEXTS });
  api.create({ id: PROJECT_REMOVE_MENU_ID, title: 'Remove from project', contexts: CONTEXTS });
}

/** The project submenu, kept in step with the open projects; every change to the menu goes through one queue. */
export interface ProjectMenu {
  /** ProjectService onProjectsChanged: a changed list removes and re-creates the project items; the same list does nothing. */
  sync(projects: { id: string; title: string }[]): Promise<void>;
  /** runtime.onInstalled: installMenus (removeAll + every item), then the last known projects again. */
  install(): Promise<void>;
}

export function createProjectMenu(api: MenuApi): ProjectMenu {
  let shown: string | undefined;
  let last: { id: string; title: string }[] | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const queue = (fn: () => Promise<void>): Promise<void> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  const apply = async (projects: { id: string; title: string }[]): Promise<void> => {
    const sig = JSON.stringify(projects.map((p) => [p.id, p.title]));
    if (sig === shown) return;
    shown = sig;
    await Promise.all([PROJECT_MENU_ID, PROJECT_REMOVE_MENU_ID].map((id) => api.remove(id).catch(() => {}))); // absent before onInstalled
    createProjectItems(api, projects);
  };
  return {
    sync: (projects) => queue(async () => { last = projects; await apply(projects); }),
    install: () => queue(async () => {
      await installMenus(api);
      shown = JSON.stringify([]); // installMenus created the project items without children
      if (last) await apply(last);
    }),
  };
}

export interface MenuTab { id?: number; url?: string; groupId?: number }

/** runtime.onInstalled: drop items from the previous version (duplicate ids would throw), then create every item. */
export async function installMenus(api: MenuApi): Promise<void> {
  await api.removeAll();
  for (const it of ITEMS) api.create({ id: it.id, title: it.title, contexts: CONTEXTS });
  createProjectItems(api, []);
}

/** Title and enabled state for the active tab: every item is disabled on exempt URLs (chrome://, file:, ...). */
export async function refreshMenus(api: MenuApi, tab: MenuTab | undefined, isLocked: (tabId: number) => boolean): Promise<void> {
  const enabled = tab?.id !== undefined && !isExemptUrl(tab.url);
  const locked = enabled && isLocked(tab!.id!);
  await Promise.all(ITEMS.map((it) => api.update(it.id, {
    enabled, ...(it.id === MENU_IDS.lock && { title: locked ? UNLOCK_TITLE : LOCK_TITLE }),
  }).catch(() => {}))); // items missing before onInstalled ran: nothing to update
}

export interface MenuClickDeps {
  /** Open the options page at this hash (a new tab). */
  openPage: (hash: string) => void | Promise<void>;
  safety: Pick<SafetyService, 'isLocked' | 'lock' | 'unlock'>;
  /** Re-read the menu state after a lock change. */
  refresh: () => void | Promise<void>;
  /** tc-project:<id> / tc-project-remove (M3 T15). */
  projects?: Pick<ProjectService, 'addTab' | 'removeTab' | 'saveGroup'>;
}

/**
 * contextMenus.onClicked: the rule items open NewRule with the link URL (on a link) or the page URL; tc-lock toggles
 * the tab's lock directly; tc-why opens the tab's explain view (R54); the project items add the tab to a project or
 * remove it (M3 T15); Save group as project (M4 T8) saves the tab's group and opens its home (an error opens the Projects page showing it); New project… opens the Projects page's form for the tab (M4 T6). Exempt pages and unknown items
 * do nothing.
 */
export async function onMenuClick(
  info: { menuItemId: string | number; linkUrl?: string; pageUrl?: string }, tab: MenuTab | undefined, deps: MenuClickDeps,
): Promise<void> {
  const id = String(info.menuItemId);
  const kind = KIND[id];
  if (kind) {
    const url = info.linkUrl ?? info.pageUrl ?? tab?.url;
    if (url && !isExemptUrl(url)) await deps.openPage(newRuleHash(url, kind));
    return;
  }
  if (tab?.id === undefined || isExemptUrl(tab.url)) return;
  if (id === MENU_IDS.lock) {
    if (deps.safety.isLocked(tab.id)) deps.safety.unlock(tab.id);
    else deps.safety.lock(tab.id);
    await deps.refresh();
  } else if (id === MENU_IDS.why) {
    await deps.openPage(explainHash(tab.id));
  } else if (id === MENU_IDS.saveGroup) {
    if (tab.groupId === undefined || tab.groupId < 0) { await deps.openPage(projectsErrorHash('This tab is not in a group.')); return; }
    try {
      const projectId = await deps.projects?.saveGroup(tab.groupId);
      if (projectId !== undefined) await deps.openPage(projectHomeHash(projectId));
    } catch (e) {
      await deps.openPage(projectsErrorHash(e instanceof Error ? e.message : String(e))); // the Projects page shows it
    }
  } else if (id.startsWith(PROJECT_CHILD_PREFIX)) {
    await deps.projects?.addTab(tab.id, id.slice(PROJECT_CHILD_PREFIX.length));
  } else if (id === PROJECT_NEW_MENU_ID) {
    await deps.openPage(newProjectHash(tab.id));
  } else if (id === PROJECT_REMOVE_MENU_ID) {
    await deps.projects?.removeTab(tab.id);
  }
}
