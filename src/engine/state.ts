import { browser } from 'wxt/browser';

/** Persisted (JSON) form, stored in chrome.storage.session under `rt` so it survives service-worker restarts. */
export interface RuntimeState {
  leaveAlone: number[];
  managedTitles: string[];
  creationOrder: [string, number][];
  /** [tabId, expiresAt]: group changes Tabchef caused; each expires EXPECTATION_TTL_MS after it was recorded. */
  expectedGroupChanges: [number, number][];
  /** [tabId, groupId] for tabs last known to be in a managed group (drag-out detection across restarts). */
  managedTabs: [number, number][];
}

export const EXPECTATION_TTL_MS = 2000;

/** In-memory form used by the reconciler; the Sets/Map are passed to planGroups directly. */
export interface LiveState {
  leaveAlone: Set<number>;
  managedTitles: Set<string>;
  creationOrder: Map<string, number>;
  /** Multiset of [tabId, expiresAt]; a tab's next onUpdated(groupId) event before expiry is Tabchef's own. */
  expectedGroupChanges: [number, number][];
  managedTabs: Map<number, number>;
}

export const RT_KEY = 'rt';

export function toLive(rt: Partial<RuntimeState> | undefined): LiveState {
  return {
    leaveAlone: new Set(rt?.leaveAlone ?? []),
    managedTitles: new Set(rt?.managedTitles ?? []),
    creationOrder: new Map(rt?.creationOrder ?? []),
    expectedGroupChanges: (rt?.expectedGroupChanges ?? []).map(([id, at]) => [id, at] as [number, number]),
    managedTabs: new Map(rt?.managedTabs ?? []),
  };
}

export function toRuntime(s: LiveState): RuntimeState {
  return {
    leaveAlone: [...s.leaveAlone],
    managedTitles: [...s.managedTitles],
    creationOrder: [...s.creationOrder],
    expectedGroupChanges: s.expectedGroupChanges.map(([id, at]) => [id, at] as [number, number]),
    managedTabs: [...s.managedTabs],
  };
}

export async function loadState(): Promise<LiveState> {
  const got = await browser.storage.session.get(RT_KEY);
  return toLive(got[RT_KEY] as Partial<RuntimeState> | undefined);
}

export async function saveState(s: LiveState): Promise<void> {
  await browser.storage.session.set({ [RT_KEY]: toRuntime(s) });
}
