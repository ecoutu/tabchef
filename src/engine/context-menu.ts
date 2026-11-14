import { isExemptUrl } from '../core/url/normalize';
import { explainHash, newProjectHash, newRuleHash, projectHomeHash, projectsErrorHash, type NewRuleKind } from '../core/links';
import type { ProjectService } from './projects';
import type { SafetyService } from './safety';

// The page / link / toolbar-icon context menu (M2 T16). Chrome keeps the items across worker restarts, but its stored
// copy can lose some (#220), so each worker start probes the items (ProjectMenu.repair, #223) and, only when one is
// missing, re-creates them: every item with the last known projects, or only the lost ones when those are not known
// yet. runtime.onInstalled re-creates every item. A failed rebuild is retried by the next sync. background.ts registers
// contextMenus.onClicked at the top level and refreshes the items' title and enabled state on tab activation, URL
// changes of the active tab, lock changes and after a repair or sync re-creates items.
// M3 T15: "Add to project" (`tc-project`) has one child per listed project that takes tabs (`tc-project:<projectId>`,
// ProjectService.menuItems), rebuilt by createProjectMenu when that list changes; "Remove from project" (`tc-project-remove`) follows it.
// The list shown is kept in storage.session, so a worker start re-creates nothing while the list stays the same.
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
/** Add to project and Remove from project: re-created on each change of the project list. */
const PROJECT_TOP_IDS = [PROJECT_MENU_ID, PROJECT_REMOVE_MENU_ID];
/** The items that don't depend on the project list: the eight minus the project ones. */
const FIXED_IDS = ITEMS.map((it) => it.id);
/** storage.session key: the project list the menu shows, so the next worker start knows it (#223). */
const SHOWN_KEY = 'contextMenuProjects';

/** The chrome.contextMenus calls used (a subset, so tests can fake it). */
export interface MenuApi {
  removeAll(): Promise<void>;
  create(p: { id: string; title: string; contexts: [MenuContext, ...MenuContext[]]; parentId?: string; enabled?: boolean }): void;
  update(id: string, p: { title?: string; enabled?: boolean }): Promise<void>;
  remove(id: string): Promise<void>;
}
const CONTEXTS: [MenuContext, ...MenuContext[]] = [MENU_CONTEXTS[0], ...MENU_CONTEXTS.slice(1)];

type MenuProject = { id: string; title: string };
/** The storage.session calls used: the project list shown survives worker restarts, not a browser restart. */
export interface MenuSession {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
const isMenuProjects = (v: unknown): v is MenuProject[] =>
  Array.isArray(v) && v.every((p: Partial<MenuProject> | null) => typeof p?.id === 'string' && typeof p.title === 'string');

/** The fixed items: the rule, Lock, Why and Save group items. */
function createFixedItems(api: MenuApi): void {
  for (const it of ITEMS) api.create({ id: it.id, title: it.title, contexts: CONTEXTS });
}

const createNewProjectItem = (api: MenuApi) =>
  api.create({ id: PROJECT_NEW_MENU_ID, parentId: PROJECT_MENU_ID, title: 'New project…', contexts: CONTEXTS });
const createRemoveItem = (api: MenuApi) =>
  api.create({ id: PROJECT_REMOVE_MENU_ID, title: 'Remove from project', contexts: CONTEXTS });
/** Add to project with one child per listed project, then New project…. */
function createAddItem(api: MenuApi, projects: MenuProject[]): void {
  api.create({ id: PROJECT_MENU_ID, title: 'Add to project', contexts: CONTEXTS, enabled: true });
  for (const p of projects) api.create({ id: `${PROJECT_CHILD_PREFIX}${p.id}`, parentId: PROJECT_MENU_ID, title: p.title, contexts: CONTEXTS });
  createNewProjectItem(api);
}
/** The project items: the parent with one child per listed project and New project…, then Remove. */
function createProjectItems(api: MenuApi, projects: MenuProject[]): void {
  createAddItem(api, projects);
  createRemoveItem(api);
}

/** The project submenu, kept in step with ProjectService.menuItems; every change to the menu goes through one queue. */
export interface ProjectMenu {
  /**
   * ProjectService.menuItems: a changed list removes and re-creates the project items; the same list does nothing,
   * also on the first sync of a worker start when storage.session holds that list. After a failed rebuild of every
   * item (repair or install), it rebuilds every item instead. Resolves true when it re-created items (they come back
   * enabled), so the caller refreshes the titles and enabled state; false when unchanged.
   */
  sync(projects: MenuProject[]): Promise<boolean>;
  /** runtime.onInstalled: installMenus (removeAll + every item) with the last known projects. */
  install(): Promise<void>;
  /**
   * Worker start (#223): probes every item (contextMenus.update with no change rejects for a missing one), the
   * project children too when the projects are known. When nothing is missing, it does nothing. Otherwise it
   * re-creates every item with the last known projects; with none known yet (before this browser session's first
   * sync), it re-creates only what was lost: the fixed items if one of them is, and each lost project item, keeping
   * the Add to project children Chrome still has (before the first pass ProjectService.menuItems lists only kept
   * projects). Resolves true when it re-created items (refresh them, as after sync).
   */
  repair(): Promise<boolean>;
}

export interface ProjectMenuDeps {
  /** storage.session, where the project list shown is kept across worker restarts (none: not kept). */
  session?: MenuSession;
  /** Logs a failure the menu recovers from (default: console.warn). */
  warn?: (what: string, e: unknown) => void;
}

export function createProjectMenu(api: MenuApi, deps: ProjectMenuDeps = {}): ProjectMenu {
  const { session, warn = (what, e) => console.warn(`[tabchef] ${what} failed`, e) } = deps;
  const sigOf = (projects: MenuProject[]) => JSON.stringify(projects.map((p) => [p.id, p.title]));
  /** The project list shown (its signature), as of this worker or the stored one; undefined: unknown. */
  let shown: string | undefined;
  let last: MenuProject[] | undefined;
  /** A rebuild of every item failed: the next sync retries it, even for the same list. */
  let rebuild = false;
  /** Reads the list the previous worker showed before anything else runs; unreadable or malformed: unknown. */
  const restore = async () => {
    const stored = await session?.get(SHOWN_KEY).then((r) => r[SHOWN_KEY], (e: unknown) => { warn('context menu projects read', e); });
    if (isMenuProjects(stored)) { last = stored; shown = sigOf(stored); }
  };
  let chain: Promise<unknown> = restore();
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  /** Shows the projects (`all`: every item too); true when it re-created items, false when the list is unchanged. */
  const apply = async (projects: MenuProject[], all: boolean): Promise<boolean> => {
    const sig = sigOf(projects);
    const full = all || rebuild;
    if (!full && sig === shown) return false;
    if (full) {
      rebuild = true; // cleared once installMenus succeeds
      await installMenus(api, projects);
      rebuild = false;
    } else {
      await Promise.all(PROJECT_TOP_IDS.map((id) => api.remove(id).catch(() => {}))); // absent: nothing to remove
      createProjectItems(api, projects);
    }
    shown = sig;
    // A failed write only costs the next worker start one re-creation of the project items.
    await session?.set({ [SHOWN_KEY]: projects.map(({ id, title }) => ({ id, title })) }).catch((e: unknown) => warn('context menu projects write', e));
    return true;
  };
  /** The probed items whose update rejects: missing from Chrome's menu. */
  const missing = async (): Promise<string[]> => {
    const ids = [...FIXED_IDS, ...PROJECT_TOP_IDS, PROJECT_NEW_MENU_ID, ...(last ?? []).map((p) => `${PROJECT_CHILD_PREFIX}${p.id}`)];
    const found = await Promise.all(ids.map((id) => api.update(id, {}).then(() => true, () => false)));
    return ids.filter((_, i) => !found[i]);
  };
  return {
    sync: (projects) => queue(async () => { last = projects; return apply(projects, false); }),
    install: () => queue(async () => { await apply(last ?? [], true); }),
    repair: () => queue(async () => {
      const lost = new Set(await missing());
      if (lost.size === 0) return false;
      if (last) return apply(last, true);
      // The projects are unknown: re-create only what was lost. The fixed items go together. Add to project keeps the
      // children Chrome kept unless it is lost itself; then it gets New project… only. The first sync, with `shown`
      // still unknown, re-creates the project items with the full list.
      if (FIXED_IDS.some((id) => lost.has(id))) {
        await Promise.all(FIXED_IDS.map((id) => api.remove(id).catch(() => {}))); // absent: nothing to remove
        createFixedItems(api);
      }
      if (lost.has(PROJECT_MENU_ID)) createAddItem(api, []);
      else if (lost.has(PROJECT_NEW_MENU_ID)) createNewProjectItem(api);
      if (lost.has(PROJECT_REMOVE_MENU_ID)) createRemoveItem(api);
      return true;
    }),
  };
}

export interface MenuTab { id?: number; url?: string; groupId?: number }

/** Drop every item (from the previous version or Chrome's stored copy: duplicate ids would throw), then create them all. */
export async function installMenus(api: MenuApi, projects: MenuProject[] = []): Promise<void> {
  await api.removeAll();
  createFixedItems(api);
  createProjectItems(api, projects);
}

/** Title and enabled state for the active tab: every item is disabled on exempt URLs (chrome://, file:, ...). */
export async function refreshMenus(api: MenuApi, tab: MenuTab | undefined, isLocked: (tabId: number) => boolean): Promise<void> {
  const enabled = tab?.id !== undefined && !isExemptUrl(tab.url);
  const locked = enabled && isLocked(tab!.id!);
  await Promise.all(ITEMS.map((it) => api.update(it.id, {
    enabled, ...(it.id === MENU_IDS.lock && { title: locked ? UNLOCK_TITLE : LOCK_TITLE }),
  }).catch(() => {}))); // a missing item (ProjectMenu.repair re-creates it at a worker start): nothing to update
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
