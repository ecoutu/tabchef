// Runtime registration of the watch content script (M2 T7). The PermissionsManager (M2 T8) is its one owner: it
// calls the WatchScripting adapter below with the granted origins its enabled recipes need. Needs the optional
// `scripting` permission: until it is granted chrome.scripting is undefined and every call is a no-op (constraint 8).

export const WATCH_SCRIPT_ID = 'tabchef-watch';
export const WATCH_FILE = 'content-scripts/watch.js';

export interface WatchScript {
  id: string; js: string[]; matches: string[]; runAt: 'document_idle'; allFrames: boolean; persistAcrossSessions: boolean;
}
/** The chrome.scripting calls used, narrowed to this script id. */
export interface WatchRegistrationApi {
  getRegistered(): Promise<{ id: string; matches?: string[] }[]>;
  register(s: WatchScript[]): Promise<void>;
  update(s: WatchScript[]): Promise<void>;
  unregister(ids: string[]): Promise<void>;
  /** Runs the watch file in an already-open tab (a registration only reaches documents loaded after it). */
  inject?(tabId: number): Promise<void>;
}

/**
 * What the PermissionsManager drives. `register` / `unregister` resolve to the origins registered before the call, or
 * false when the scripting API is unavailable (`scripting` not granted).
 */
export interface WatchScripting {
  /** Make the `tabchef-watch` registration cover exactly `origins` (replaced as a whole). */
  register(origins: string[]): Promise<string[] | false>;
  unregister(): Promise<string[] | false>;
  /** Inject the watch into these open tabs; per-tab failures (closed, restricted) are ignored. */
  inject?(tabIds: number[]): Promise<void>;
}

/** The http(s) host match patterns among granted origins (the watch only runs on web pages). */
export function watchOrigins(origins: Iterable<string>): string[] {
  return [...new Set([...origins].filter((o) => /^(https?|\*):\/\//.test(o)))];
}

/**
 * Registers, updates or unregisters the watch script so it runs exactly on `origins` (no call when unchanged).
 * Resolves to the matches registered before the call.
 */
export async function syncWatchRegistration(api: WatchRegistrationApi, origins: string[]): Promise<string[]> {
  const matches = watchOrigins(origins);
  const current = (await api.getRegistered()).find((s) => s.id === WATCH_SCRIPT_ID);
  const before = [...(current?.matches ?? [])];
  if (matches.length === 0) {
    if (current) await api.unregister([WATCH_SCRIPT_ID]);
    return before;
  }
  const script: WatchScript = {
    id: WATCH_SCRIPT_ID, js: [WATCH_FILE], matches, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
  };
  if (!current) await api.register([script]);
  else if (JSON.stringify([...before].sort()) !== JSON.stringify([...matches].sort())) await api.update([script]);
  return before;
}

/** WatchScripting over the scripting API, looked up per call: `getApi` returns undefined while `scripting` is not granted. */
export function createWatchScripting(getApi: () => WatchRegistrationApi | undefined): WatchScripting {
  return {
    async register(origins) {
      const api = getApi();
      return api ? syncWatchRegistration(api, origins) : false;
    },
    async unregister() {
      const api = getApi();
      return api ? syncWatchRegistration(api, []) : false;
    },
    async inject(tabIds) {
      const api = getApi();
      if (!api?.inject) return;
      await Promise.allSettled(tabIds.map((id) => api.inject!(id)));
    },
  };
}
