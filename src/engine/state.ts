import { browser } from 'wxt/browser';
import type { StickyMap } from '../core/projects/resolve';
import type { GroupColor } from '../core/types';

/** Persisted (JSON) form, stored in chrome.storage.session under `rt` so it survives service-worker restarts. */
export interface RuntimeState {
  leaveAlone: number[];
  managedTitles: string[];
  creationOrder: [string, number][];
  /** [tabId, expiresAt]: group changes Tabchef caused; each expires EXPECTATION_TTL_MS after it was recorded. */
  expectedGroupChanges: [number, number][];
  /** [tabId, groupId] for tabs last known to be in a managed group (drag-out detection across restarts). */
  managedTabs: [number, number][];
  /** [groupId, props]: groups Tabchef created but has not titled yet (the title call failed); re-titled next flush. */
  pendingTitles?: [number, PendingTitle][];
  /** [tabId, url without #fragment] of leave-alone tabs: a fragment-only change is not a navigation. */
  leaveAloneUrls?: [number, string][];
  /** [groupId, consecutive non-drag failures] of pendingTitles entries; dropped after MAX_RETITLE_FAILURES. */
  retitleFailures?: [number, number][];
  /** ["<windowId>|<title>", consecutive flushes absent]: creation numbers are dropped only after 2 (tombstones). */
  creationAbsent?: [string, number][];
  /** [title, consecutive flushes no group had it]: a managed title is dropped after ABSENT_LIMIT (as creationAbsent). */
  managedTitlesAbsent?: [string, number][];
  /** Tabs Tabchef opened (or moved) into a group it created as that group's anchors (M2 T11). */
  anchors?: AnchorEntry[];
  /** `"<windowId>|<title>"` of groups whose anchor the user closed: not reopened until the group is removed (T11). */
  anchorsDismissed?: string[];
  /** [groupId, "<windowId>|<title>"]: the group a dismissal was made in, so a rename moves the dismissal along. */
  anchorsDismissedGroups?: [number, string][];
  /**
   * Sticky project membership (M3 T15, M3-R42/R66): tabs that joined a project by rules, at the normalized URL they
   * had then, with the assigning rule, so a loading tab keeps its project and its rule's priority.
   */
  projectTabs?: ProjectTab[];
}

/** `sig`: the assigning rule's signature (StickyMap); older builds ignore it, and entries they stored lack it. */
export interface ProjectTab { tabId: number; projectId: string; url: string; ruleKey?: string; index?: number; sig?: string }

/** `groupId`: the group it was recorded for (missing in records stored before it was tracked). */
export interface AnchorEntry { tabId: number; windowId: number; title: string; url: string; groupId?: number }

export interface PendingTitle { title: string; color: GroupColor; collapsed?: boolean }

export const EXPECTATION_TTL_MS = 2000;

/** In-memory form used by the reconciler; the Sets/Map are passed to planGroups directly. */
export interface LiveState {
  leaveAlone: Set<number>;
  managedTitles: Set<string>;
  creationOrder: Map<string, number>;
  /** Multiset of [tabId, expiresAt]; a tab's next onUpdated(groupId) event before expiry is Tabchef's own. */
  expectedGroupChanges: [number, number][];
  managedTabs: Map<number, number>;
  pendingTitles: Map<number, PendingTitle>;
  leaveAloneUrls: Map<number, string>;
  retitleFailures: Map<number, number>;
  creationAbsent: Map<string, number>;
  managedTitlesAbsent: Map<string, number>;
  anchors: AnchorEntry[];
  anchorsDismissed: Set<string>;
  anchorsDismissedGroups: Map<number, string>;
  projectTabs: StickyMap;
}

export const RT_KEY = 'rt';

export function toLive(rt: Partial<RuntimeState> | undefined): LiveState {
  return {
    leaveAlone: new Set(rt?.leaveAlone ?? []),
    managedTitles: new Set(rt?.managedTitles ?? []),
    creationOrder: new Map(rt?.creationOrder ?? []),
    expectedGroupChanges: (rt?.expectedGroupChanges ?? []).map(([id, at]) => [id, at] as [number, number]),
    managedTabs: new Map(rt?.managedTabs ?? []),
    pendingTitles: new Map(rt?.pendingTitles ?? []),
    leaveAloneUrls: new Map(rt?.leaveAloneUrls ?? []),
    retitleFailures: new Map(rt?.retitleFailures ?? []),
    creationAbsent: new Map(rt?.creationAbsent ?? []),
    managedTitlesAbsent: new Map(rt?.managedTitlesAbsent ?? []),
    anchors: (rt?.anchors ?? []).map((a) => ({ ...a })),
    anchorsDismissed: new Set(rt?.anchorsDismissed ?? []),
    anchorsDismissedGroups: new Map(rt?.anchorsDismissedGroups ?? []),
    projectTabs: new Map((rt?.projectTabs ?? []).map(({ tabId, ...e }) => [tabId, { ...e }])),
  };
}

export function toRuntime(s: LiveState): RuntimeState {
  return {
    leaveAlone: [...s.leaveAlone],
    managedTitles: [...s.managedTitles],
    creationOrder: [...s.creationOrder],
    expectedGroupChanges: s.expectedGroupChanges.map(([id, at]) => [id, at] as [number, number]),
    managedTabs: [...s.managedTabs],
    pendingTitles: [...s.pendingTitles],
    leaveAloneUrls: [...s.leaveAloneUrls],
    retitleFailures: [...s.retitleFailures],
    creationAbsent: [...s.creationAbsent],
    managedTitlesAbsent: [...s.managedTitlesAbsent],
    anchors: s.anchors.map((a) => ({ ...a })),
    anchorsDismissed: [...s.anchorsDismissed],
    anchorsDismissedGroups: [...s.anchorsDismissedGroups],
    projectTabs: [...s.projectTabs].map(([tabId, e]) => ({ tabId, ...e })),
  };
}

export async function loadState(): Promise<LiveState> {
  const got = await browser.storage.session.get(RT_KEY);
  return toLive(got[RT_KEY] as Partial<RuntimeState> | undefined);
}

export async function saveState(s: LiveState): Promise<void> {
  await browser.storage.session.set({ [RT_KEY]: toRuntime(s) });
}
