// Projects tab cards (M3 T17): ProjectCardData (projects.list) shaped for the popup and the side panel.
import type { ProjectCardData } from '../core/projects/types';
import type { PrState } from '../core/sources/types';

/** A PR state shown as a pill: never `unknown` (M3-R45). */
export type ShownPrState = Exclude<PrState, 'unknown'>;
export type StatusTone = 'todo' | 'progress' | 'done';

export interface ProjectCard {
  id: string;
  title: string;
  /** The ticket title shown muted beside the title (projectSubtitle); absent when there is none or the title has it. */
  subtitle?: string;
  /** The ticket status; absent without one (the card shows the title alone, M3-R72). */
  status?: { label: string; tone: StatusTone };
  tabCount: number;
  tabs: { tabId: number; title: string; url: string; favIconUrl?: string; pill?: ShownPrState; stale?: boolean }[];
  /** Linked PRs not open in the project (greyed, "Open ↗"). */
  linked: { url: string; title: string; state?: ShownPrState }[];
  /** The ticket is Done by fresh data (ProjectCardData.done, M3-R90): "Ticket is done. Close this group?". */
  showClose: boolean;
}

const TONES: Record<NonNullable<ProjectCardData['status']>['category'], StatusTone> = { new: 'todo', indeterminate: 'progress', done: 'done' };
const shown = (s: PrState | undefined): ShownPrState | undefined => (s === undefined || s === 'unknown' ? undefined : s);
const lastActive = (c: ProjectCardData): number => Math.max(-1, ...c.tabs.map((t) => t.lastAccessed ?? -1));

/** The stale dot's tooltip: the row shows the last known state because `label` could not be reached. */
export const staleText = (label: string): string => `Last known state; ${label} unavailable`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The ticket title a project list shows, muted, beside a project's title (e.g. `ABC-123` · `Fix login`): its Jira
 * summary, else its first linked PR's title without the key it starts with (`ABC-123: Fix login`). None when the title
 * already shows it (a recipe title like `{key} · {summary}`), or for a manual project (a name, no summary, no prTitle).
 */
export function projectSubtitle(p: { key: string; title: string; summary?: string; prTitle?: string }): string | undefined {
  const lead = new RegExp(`^\\[?${escapeRe(p.key)}\\]?(?![\\w-])[\\s:|·–—-]*`, 'i');
  const s = p.summary?.trim() || p.prTitle?.trim().replace(lead, '').trim();
  return s && !p.title.includes(s) ? s : undefined;
}

/** One card per project, the most recently active project first. */
export function buildProjectCards(data: ProjectCardData[]): ProjectCard[] {
  return [...data].sort((a, b) => lastActive(b) - lastActive(a)).map((c): ProjectCard => {
    const open = new Set(c.tabs.map((t) => t.url));
    const subtitle = projectSubtitle(c);
    return {
      id: c.id, title: c.title, ...(subtitle && { subtitle }),
      ...(c.status && { status: { label: c.status.name, tone: TONES[c.status.category] } }),
      tabCount: c.tabs.length,
      tabs: c.tabs.map((t) => {
        const pill = shown(t.pill);
        return {
          tabId: t.tabId, title: t.title, url: t.url, ...(t.favIconUrl !== undefined && { favIconUrl: t.favIconUrl }),
          ...(pill && { pill }), ...(t.stale && { stale: true }),
        };
      }),
      linked: c.linked.filter((l) => !open.has(l.url)).map((l) => {
        const state = shown(l.state);
        return { url: l.url, title: l.title, ...(state && { state }) };
      }),
      showClose: c.done, // fresh Done only (M3-R90): a stale or stored Done still shows as the status, without the prompt
    };
  });
}
