// Runtime registration of the watch content script (M2 T7). The seam the PermissionsManager (M2 T8) calls with the
// host permissions it holds; until then background.ts calls it with every granted host at worker start and on
// permission changes. Needs the optional `scripting` permission: without it the caller skips the sync.

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
}

/** The http(s) host match patterns among granted origins (the watch only runs on web pages). */
export function watchOrigins(origins: Iterable<string>): string[] {
  return [...new Set([...origins].filter((o) => /^(https?|\*):\/\//.test(o)))];
}

/** Registers, updates or unregisters the watch script so it runs exactly on `origins` (no call when unchanged). */
export async function syncWatchRegistration(api: WatchRegistrationApi, origins: string[]): Promise<void> {
  const matches = watchOrigins(origins);
  const current = (await api.getRegistered()).find((s) => s.id === WATCH_SCRIPT_ID);
  if (matches.length === 0) {
    if (current) await api.unregister([WATCH_SCRIPT_ID]);
    return;
  }
  const script: WatchScript = {
    id: WATCH_SCRIPT_ID, js: [WATCH_FILE], matches, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
  };
  if (!current) await api.register([script]);
  else if (JSON.stringify([...(current.matches ?? [])].sort()) !== JSON.stringify([...matches].sort())) await api.update([script]);
}
