// ProjectSync (M4 T14, slice 4.3): keeps the user's kept projects (D2) in a visible `Tabchef` bookmark folder under
// Other bookmarks (D3), which Chrome Sync carries to their other devices. Each sync reads the folders
// (bookmark-folders.ts), merges every project three-way against its base snapshot (planSync, inside the ProjectService
// queue, which also stores the local changes) and writes the folders that differ.
//
// Runs only while the per-device toggle (storage.local `projects.sync`, M4-R24) is on and the optional `bookmarks`
// permission is granted (`refresh` re-checks both). Bookmark and store changes are debounced (Chrome Sync's event
// order is unknown, so no sync depends on it); bookmark events during its own writes are ignored, and any other echo
// costs one sync that writes nothing. The bookmark listener is registered after awaits (in `refresh`), so a remote
// bookmark change does not wake the worker: sync catches up on the next wake, when worker start calls `refresh()`.
import { ROOT_TITLE, type SyncedProject } from '../core/projects/bookmark-format';
import { planSync } from '../core/projects/sync-plan';
import type { BookmarkPort } from '../platform/browser-port';
import { readFolders, writeFolders } from './bookmark-folders';
import type { KeyValueArea } from './connections/secret-store';
import type { ProjectService } from './projects';

/** Base snapshots (id → the last synced copy, M4-R19): the deletion marker for the folder in SYNC_ROOT_KEY. Kept while the toggle is off. */
export const SYNC_BASE_KEY = 'projects.syncBase';
/** The per-device toggle (M4-R24). */
export const SYNC_TOGGLE_KEY = 'projects.sync';
/**
 * The node id of the `Tabchef` folder the base snapshots were made against (M4-R40), set with the base: another first
 * `Tabchef` folder is another lineage, whose contents are not the remote state of this base.
 */
export const SYNC_ROOT_KEY = 'projects.syncRoot';
/** The last sync's time and result, and the sync notes, for the Projects page. */
export const SYNC_STATUS_KEY = 'projects.syncStatus';
/** The sync notes kept (M4-R46): the newest ones. */
const MAX_NOTICES = 20;

export interface SyncResult { merged: number; conflicts: string[]; ignored: string[] }
/** A one-time sync report (M4-R46), listed until the user dismisses it. */
export interface SyncNotice { at: number; text: string }
export interface SyncStatus {
  /** The toggle is on and the bookmarks permission granted: syncing. */
  enabled: boolean;
  /** The toggle (`projects.sync`) is on. With `enabled` false: paused, the bookmarks permission was taken away. */
  wanted: boolean;
  lastSyncAt?: number;
  /** `error`: the last sync failed (nothing after the failing step was written). `ignored`: only the repeating items. */
  lastResult?: SyncResult | { error: string };
  /**
   * M4-R46: one-time reports (an edit kept after a delete, the missing-folder line, the M4-R40 switch line), oldest
   * first, kept through later syncs, failed ones and restarts until `dismiss`; the same text again is listed once, with
   * its new time. Absent when empty.
   */
  notices?: SyncNotice[];
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
const isNotice = (x: unknown): x is SyncNotice => isRecord(x) && typeof x.at === 'number' && typeof x.text === 'string';

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
    const wanted = await this.toggle();
    const enabled = wanted && (await this.granted());
    const s = (await this.deps.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY];
    return { enabled, wanted, ...(isRecord(s) && s) };
  }

  /**
   * Clears the sync notes the page showed (`projects.sync.dismiss`, M4-R46/R47): those dated `upTo` (the newest one it
   * showed) or earlier. Runs on the sync chain, after any running sync, so that sync cannot write back a note just
   * dismissed; a note added since the page read the status (a text reported again gets a new time) stays.
   */
  async dismiss(upTo: number): Promise<SyncStatus> {
    const run = this.chain.then(async () => {
      const s = (await this.deps.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY];
      if (!isRecord(s) || s.notices === undefined) return;
      const rest = { ...s };
      const left = Array.isArray(s.notices) ? s.notices.filter(isNotice).filter((n) => n.at > upTo) : [];
      if (left.length > 0) rest.notices = left;
      else delete rest.notices;
      await this.deps.local.set({ [SYNC_STATUS_KEY]: rest });
    });
    this.chain = run.catch(() => {});
    await run;
    return this.status();
  }

  /** Stores a sync's status: its result, and the notes kept so far plus `add` (M4-R46). */
  private async report(lastResult: SyncStatus['lastResult'], add: string[]): Promise<void> {
    const s = (await this.deps.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY];
    const kept = isRecord(s) && Array.isArray(s.notices) ? s.notices.filter(isNotice) : [];
    const at = this.now();
    const texts = new Set(add);
    const notices = [...kept.filter((n) => !texts.has(n.text)), ...[...texts].map((text) => ({ at, text }))].slice(-MAX_NOTICES);
    await this.deps.local.set({ [SYNC_STATUS_KEY]: { lastSyncAt: at, lastResult, ...(notices.length > 0 && { notices }) } });
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
      const got = await this.deps.local.get([SYNC_BASE_KEY, SYNC_ROOT_KEY]);
      const raw = got[SYNC_BASE_KEY];
      const stored = (isRecord(raw) ? raw : {}) as Record<string, SyncedProject>;
      const based = Object.keys(stored).length > 0;
      let folders = await readFolders(this.deps.bookmarks, stored);
      // M4-R40: a different first Tabchef folder than the one the base was made against (Chrome signed in or out with
      // account bookmarks, another account, a re-download, a second folder now first, the folder re-created elsewhere).
      // Its contents are not the remote state of the base, so this sync runs as a first sync: no base at all (nothing
      // deleted, no base-driven pick, no M4-R35 hold, a failed write keeps no base), a union with the newest updatedAt
      // deciding fields. The new folder is then recorded.
      // M4-R45: no Tabchef folder at all while projects were synced (Chrome signed out, the folder moved or deleted) is a
      // change of folder too: its absence never deletes local projects, they are written again into a new folder (whose
      // id is recorded), and the sync starts from no base. Invariant: every entry in projects.syncBase stands for a
      // project that, during the sync that stored or last kept it, was read in or written to the folder recorded in
      // projects.syncRoot. Only a sync that keeps that folder carries an entry forward unwritten: the M4-R19 marker for a
      // delete made there, held by M4-R35. So a project this sync does not write (a failed write, an unreadable saved
      // list, over 8 KB) keeps no base, and the next sync writes it as new instead of reading a remote delete.
      const switched = based && folders.rootId !== undefined && folders.rootId !== got[SYNC_ROOT_KEY];
      const base = switched || (based && folders.rootId === undefined) ? {} : stored;
      if (switched) folders = await readFolders(this.deps.bookmarks, base);
      const rootMissing = folders.rootId === undefined && based;
      const plan = await this.deps.projects.syncApply((stored, open, unsynced) => planSync({ stored, open, unsynced, remote: folders.remote, base, rootMissing, unreadable: folders.unreadable }));
      this.writing = true;
      this.changedWhileWriting = false;
      let out: Awaited<ReturnType<typeof writeFolders>>;
      try {
        out = await writeFolders(this.deps.bookmarks, folders, plan.write, plan.base, plan.fresh);
      } finally {
        this.writing = false;
        // Our own echo or a remote change mid-write: one more (debounced) sync tells them apart.
        if (this.changedWhileWriting) this.schedule();
      }
      // A folder that failed to write keeps its old base, so the next sync tries again (after a switch or a missing
      // folder: no base).
      const next = { ...plan.base };
      for (const id of out.failed.keys()) {
        if (base[id]) next[id] = base[id];
        else delete next[id];
      }
      await this.deps.local.set({ [SYNC_BASE_KEY]: next, [SYNC_ROOT_KEY]: out.rootId ?? null });
      // One-time reports (M4-R46): the sync that makes them also removes their cause, so they go to the notes, kept until
      // dismissed; `ignored` keeps the items every sync reports again while their cause holds.
      const missing = rootMissing ? [`The ${ROOT_TITLE} bookmark folder was missing: no project was removed here, and the kept ones were written again.`]
        : switched ? [`Chrome now uses a different ${ROOT_TITLE} bookmark folder (you signed in or out of Chrome, or switched accounts). Nothing was removed: the projects here and that folder's were combined, so projects or saved tabs removed since this device last synced with that folder may have come back.`]
          : [];
      const result: SyncResult = { merged: plan.merged, conflicts: plan.conflicts, ignored: [...folders.ignored, ...plan.ignored, ...out.failed.values(), ...out.errors] };
      await this.report(result, [...missing, ...plan.conflicts]);
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await this.report({ error }, []).catch(() => {}); // the notes stay
      throw e;
    }
  }
}
