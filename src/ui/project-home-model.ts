// The Project home page (M4 T4): ProjectHomeData (projects.home) shaped for ProjectHome.svelte, in D4's order: header
// (title, status, PR counts), open tabs by group in tab-bar order, linked PRs not open, then the read-only settings.
import type { ProjectHomeData } from '../core/projects/types';
import type { GroupColor } from '../core/types';
import { buildProjectCards, staleText, type ProjectCard, type ShownPrState } from './projects-model';

export type HomeTab = ProjectCard['tabs'][number] & {
  /** The stale marker's tooltip (staleText): set only on a stale row. */
  staleTip?: string;
};

export interface ProjectHomeView {
  id: string;
  title: string;
  status?: NonNullable<ProjectCard['status']>;
  /** The ticket is Done by fresh data (M3-R90). */
  done: boolean;
  /** PR states over open tabs and linked PRs, in pill order; `unknown` is never counted (M3-R45). */
  prCounts: { state: ShownPrState; count: number }[];
  /** e.g. '2 open · 1 merged'; '' without PRs. */
  prSummary: string;
  /** The first tab in tab-bar order ("Open in tab bar" focuses it). */
  firstTabId?: number;
  groups: { title: string; color: GroupColor; windowId: number; tabs: HomeTab[] }[];
  linked: ProjectCard['linked'];
  /** Empty when its recipe is off. */
  settings: { label: string; value: string; help: string }[];
  recipeName: string;
  /** Its recipe is off: no settings, no Reopen, a note linking to the Recipes page. */
  recipeOff: boolean;
  /** M4 T9: tabs of it are open (Close group, Close and save); otherwise its saved tab list is shown, with Reopen. */
  open: boolean;
  keep: boolean;
  /** Its saved tab list (M4 T7): what Reopen opens. */
  savedTabs: { url: string; title: string; group?: string }[];
  archived: boolean;
  /** Open tabs a rule assigns an archived project's key to ("Archived: reopen?"). */
  held: number;
}

const PILL_ORDER: ShownPrState[] = ['open', 'draft', 'merged', 'closed'];
/** PR pills come from GitHub source data only (PrState). */
const STALE = staleText('GitHub');
const UNGROUPED = 'Not in a group';

type Settings = NonNullable<ProjectHomeData['settings']>;
const CONTAINER: Record<Settings['container'], string> = { group: 'A tab group', window: 'Its own window' };
const JOIN: Record<Settings['join'][number], string> = {
  rules: 'rules', opener: 'tabs it opens', window: 'new tabs in its window', manual: 'added by hand',
};
const ELSEWHERE: Record<Settings['onOpenElsewhere'], string> = {
  'move-and-follow': 'Move the tab into the project and follow it',
  'move-silently': 'Move the tab into the project and stay where you are',
  leave: 'Leave the tab where it opened',
};
const SWITCH: Record<Settings['onSwitchAway'], string> = {
  unload: 'Collapse and unload its tabs', minimize: 'Minimize its window', 'close-and-save': 'Close its tabs and save them',
};
function placement(p: Settings['placement'][number]): string {
  if (p.startsWith('home:')) return `the shared window "${p.slice('home:'.length)}"`;
  return ({ existing: 'the window it is already in', current: 'the current window', new: 'a new window' } as Record<string, string>)[p] ?? p;
}
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function settings(s: Settings): ProjectHomeView['settings'] {
  return [
    { label: 'Container', value: CONTAINER[s.container], help: 'Where the project\'s tabs live: in one tab group, or in a window of their own.' },
    { label: 'Placement', value: capital(s.placement.map(placement).join(', then ')), help: 'Where the tabs of a new project go. The first choice that applies is used.' },
    { label: 'Joins by', value: capital(s.join.map((j) => JOIN[j]).join(', ')), help: 'How a tab becomes part of this project: by the recipe\'s rules, by being opened from one of its tabs, by opening in its window, or by you adding it.' },
    { label: 'Opened elsewhere', value: ELSEWHERE[s.onOpenElsewhere], help: 'What happens when a tab of this project opens in another window.' },
    { label: 'Switching away', value: SWITCH[s.onSwitchAway], help: 'What happens to this project\'s tabs when you switch to another project. Unloading closes nothing.' },
  ];
}

/** One PR, whichever of its pages (conversation, /files, a duplicate tab) shows it; any other URL counts as itself. */
function prKey(url: string): string {
  try {
    const u = new URL(url);
    const [owner, repo, kind, num] = u.pathname.split('/').slice(1);
    if (u.host === 'github.com' && owner && repo && kind === 'pull' && num && /^\d+$/.test(num)) return `pr:${owner}/${repo}#${num}`.toLowerCase();
  } catch { /* not a URL: counted as itself */ }
  return url;
}

export function buildProjectHome(d: ProjectHomeData): ProjectHomeView {
  const card = buildProjectCards([d])[0]!;
  const tabOf = new Map(card.tabs.map((t) => [t.tabId, t]));
  const groups = d.groups.map((g) => ({
    title: g.title || UNGROUPED, color: g.color, windowId: g.windowId,
    tabs: g.tabIds.flatMap((id): HomeTab[] => {
      const t = tabOf.get(id);
      return t ? [{ ...t, ...(t.stale && { staleTip: STALE }) }] : [];
    }),
  }));
  // One state per PR (open tabs first, then linked): a PR's /files tab or a duplicate tab is not another PR.
  const byPr = new Map<string, ShownPrState | undefined>();
  for (const [url, state] of [...card.tabs.map((t) => [t.url, t.pill] as const), ...card.linked.map((l) => [l.url, l.state] as const)]) {
    const k = prKey(url);
    if (!byPr.has(k)) byPr.set(k, state);
  }
  const states = [...byPr.values()];
  const prCounts = PILL_ORDER.map((state) => ({ state, count: states.filter((s) => s === state).length })).filter((c) => c.count > 0);
  const firstTabId = groups.flatMap((g) => g.tabs)[0]?.tabId;
  return {
    id: card.id, title: card.title, ...(card.status && { status: card.status }), done: d.done,
    prCounts, prSummary: prCounts.map((c) => `${c.count} ${c.state}`).join(' · '),
    ...(firstTabId !== undefined && { firstTabId }),
    groups, linked: card.linked, settings: d.settings ? settings(d.settings) : [], recipeName: d.recipeName,
    recipeOff: d.recipeOff === true,
    open: d.tabs.length > 0, keep: d.keep === true,
    savedTabs: (d.saved?.tabs ?? []).map((t) => ({ url: t.url, title: t.title, ...(t.group !== undefined && { group: t.group }) })),
    archived: d.archivedAt !== undefined, held: d.held ?? 0,
  };
}
