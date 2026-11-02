import { isExemptUrl } from '../core/url/normalize';
import { explainHash, newRuleHash, type NewRuleKind } from '../ui/routes';
import type { SafetyService } from './safety';

// The page / link / toolbar-icon context menu (M2 T16). Items are created on runtime.onInstalled (they persist across
// worker restarts); background.ts registers contextMenus.onClicked at the top level and refreshes the items' title and
// enabled state on tab activation, URL changes of the active tab and lock changes.

export const MENU_IDS = { group: 'tc-group', close: 'tc-close', allowDup: 'tc-allowdup', lock: 'tc-lock', why: 'tc-why' } as const;
export const MENU_CONTEXTS = ['page', 'link', 'action'] as const;
type MenuContext = (typeof MENU_CONTEXTS)[number];

const LOCK_TITLE = 'Lock this tab';
const UNLOCK_TITLE = 'Unlock this tab';
const ITEMS: { id: string; title: string }[] = [
  { id: MENU_IDS.group, title: 'Group pages like this under…' },
  { id: MENU_IDS.close, title: 'Auto-close pages like this' },
  { id: MENU_IDS.allowDup, title: 'Never dedupe this site' },
  { id: MENU_IDS.lock, title: LOCK_TITLE },
  { id: MENU_IDS.why, title: 'Why is this tab here?' },
];
const KIND: Record<string, NewRuleKind> = { [MENU_IDS.group]: 'group', [MENU_IDS.close]: 'close', [MENU_IDS.allowDup]: 'allowDup' };

/** The chrome.contextMenus calls used (a subset, so tests can fake it). */
export interface MenuApi {
  removeAll(): Promise<void>;
  create(p: { id: string; title: string; contexts: [MenuContext, ...MenuContext[]] }): void;
  update(id: string, p: { title?: string; enabled?: boolean }): Promise<void>;
}

export interface MenuTab { id?: number; url?: string }

/** runtime.onInstalled: drop items from the previous version (duplicate ids would throw), then create every item. */
export async function installMenus(api: MenuApi): Promise<void> {
  await api.removeAll();
  for (const it of ITEMS) api.create({ id: it.id, title: it.title, contexts: [MENU_CONTEXTS[0], ...MENU_CONTEXTS.slice(1)] });
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
}

/**
 * contextMenus.onClicked: the rule items open NewRule with the link URL (on a link) or the page URL; tc-lock toggles
 * the tab's lock directly; tc-why opens the tab's explain view (R54). Exempt pages and unknown items do nothing.
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
  }
}
