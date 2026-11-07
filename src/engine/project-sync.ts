// ProjectSync (M4 T14, slice 4.3): keeps the user's kept projects (D2) in a visible `Tabchef` bookmark folder under
// Other bookmarks (D3), which Chrome Sync carries to their other devices. Each sync reads the folders
// (bookmark-folders.ts), merges every project three-way against its base snapshot (planSync, inside the ProjectService
// queue, which also stores the local changes) and writes the folders that differ.
//
// Runs only while the per-device toggle (storage.local `projects.sync`, M4-R24) is on and the optional `bookmarks`
// permission is granted (`refresh` re-checks both). Bookmark and store changes are debounced (Chrome Sync's event
// order is unknown, so no sync depends on it); bookmark events during its own writes are ignored, and any other echo
// costs one sync that writes nothing.
import { ROOT_TITLE, type SyncedProject } from '../core/projects/bookmark-format';
import { planSync } from '../core/projects/sync-plan';
import type { BookmarkPort } from '../platform/browser-port';
import { readFolders, writeFolders } from './bookmark-folders';
import type { KeyValueArea } from './connections/secret-store';
import type { ProjectService } from './projects';

/** Base snapshots (id → the last synced copy, M4-R19): the deletion marker. Kept while the toggle is off. */
export const SYNC_BASE_KEY = 'projects.syncBase';
/** The per-device toggle (M4-R24). */
export const SYNC_TOGGLE_KEY = 'projects.sync';
/** The last sync's time and result, for the Projects page. */
export const SYNC_STATUS_KEY = 'projects.syncStatus';

export interface SyncResult { merged: number; conflicts: string[]; ignored: string[] }
export interface SyncStatus {
  /** The toggle is on and the bookmarks permission granted: syncing. */
  enabled: boolean;
  lastSyncAt?: number;
  /** `error`: the last sync failed (nothing after the failing step was written). */
  lastResult?: SyncResult | { error: string };
}

export interface ProjectSyncDeps {
  projects: Pick<ProjectService, 'syncApply'>;
  bookmarks: BookmarkPort;
  local: Pick<KeyValueArea, 'get' | 'set'>;
  /** Whether the optional `bookmarks` permission is granted. */
  granted: () => Promise<boolean>;
  now?: () => number;
  /** Quiet time before a sync (default 2 s); a sync waits at most 5 times that. */
  debounceMs?: number;
  /** A scheduled sync failed (it is in the status too). */
  warn?: (e: unknown) => void;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export class ProjectSync {
  private readonly now: () => number;
  private readonly wait: number;
  private chain: Promise<unknown> = Promise.resolve();
  private active = false;
  private writing = false;
  /** A bookmark change arrived while writing: maybe ours, maybe a remote one; one more sync once the write ends. */
  private changedWhileWriting = false;
  private off?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private first = 0;

  constructor(private readonly deps: ProjectSyncDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.debounceMs ?? 2000;
  }

  private async toggle(): Promise<boolean> {
    return (await this.deps.local.get(SYNC_TOGGLE_KEY))[SYNC_TOGGLE_KEY] === true;
  }

  private async granted(): Promise<boolean> {
    return this.deps.granted().catch(() => false);
  }

  /** Starts (listens to bookmark changes, schedules a sync) or stops by the toggle and the permission. Worker start, permission changes. */
  async refresh(): Promise<boolean> {
    const on = (await this.toggle()) && (await this.granted());
    if (on && !this.active) {
      this.active = true;
      this.off = this.deps.bookmarks.onChanged(() => {
        if (this.writing) this.changedWhileWriting = true;
        else this.schedule();
      });
      this.schedule();
    } else if (!on && this.active) {
      this.active = false;
      this.off?.();
      this.off = undefined;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return on;
  }

  /** The toggle (`projects.sync.set`). Turning it on needs the bookmarks permission (the Projects page asks for it first). */
  async setEnabled(enabled: boolean): Promise<SyncStatus> {
    if (enabled && !(await this.granted())) throw new Error('Allow Tabchef to use your bookmarks first.');
    await this.deps.local.set({ [SYNC_TOGGLE_KEY]: enabled });
    await this.refresh();
    return this.status();
  }

  async status(): Promise<SyncStatus> {
    const enabled = (await this.toggle()) && (await this.granted());
    const s = (await this.deps.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY];
    return { enabled, ...(isRecord(s) && s) };
  }

  /** A stored-project or bookmark change: sync once things are quiet. Nothing while off. */
  schedule(): void {
    if (!this.active) return;
    const t = this.now();
    if (this.timer === undefined) this.first = t;
    else clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.syncNow().catch((e: unknown) => this.deps.warn?.(e));
    }, Math.max(0, Math.min(this.wait, this.first + 5 * this.wait - t)));
  }

  /** One sync, after any running one. */
  syncNow(): Promise<SyncResult> {
    const run = this.chain.then(() => this.once());
    this.chain = run.catch(() => {});
    return run;
  }

  private async once(): Promise<SyncResult> {
    try {
      const raw = (await this.deps.local.get(SYNC_BASE_KEY))[SYNC_BASE_KEY];
      const base = (isRecord(raw) ? raw : {}) as Record<string, SyncedProject>;
      const folders = await readFolders(this.deps.bookmarks, base);
      // No Tabchef folder at all while projects were synced (Chrome signed out, the folder moved or deleted): its
      // absence never deletes local projects; they are written again instead.
      const rootMissing = folders.rootId === undefined && Object.keys(base).length > 0;
      const plan = await this.deps.projects.syncApply((stored, open) => planSync({ stored, open, remote: folders.remote, base, rootMissing }));
      this.writing = true;
      this.changedWhileWriting = false;
      let out: Awaited<ReturnType<typeof writeFolders>>;
      try {
        out = await writeFolders(this.deps.bookmarks, folders, plan.write, plan.base);
      } finally {
        this.writing = false;
        // Our own echo or a remote change mid-write: one more (debounced) sync tells them apart.
        if (this.changedWhileWriting) this.schedule();
      }
      // A folder that failed to write keeps its old base, so the next sync tries again.
      const next = { ...plan.base };
      for (const id of out.failed.keys()) {
        if (base[id]) next[id] = base[id];
        else delete next[id];
      }
      await this.deps.local.set({ [SYNC_BASE_KEY]: next });
      const missing = rootMissing ? [`The ${ROOT_TITLE} bookmark folder was missing: no project was removed here, and the kept ones were written again.`] : [];
      const result: SyncResult = { merged: plan.merged, conflicts: plan.conflicts, ignored: [...missing, ...folders.ignored, ...plan.ignored, ...out.failed.values(), ...out.errors] };
      await this.deps.local.set({ [SYNC_STATUS_KEY]: { lastSyncAt: this.now(), lastResult: result } });
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await this.deps.local.set({ [SYNC_STATUS_KEY]: { lastSyncAt: this.now(), lastResult: { error } } }).catch(() => {});
      throw e;
    }
  }
}
