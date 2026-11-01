import { browser } from 'wxt/browser';
import { isExemptUrl } from '../core/url/normalize';
import type { RecentlyClosed, RecentlyClosedInput } from '../core/safety/recently-closed';
import type { TabSnap } from '../core/types';
import type { BrowserPort } from '../platform/browser-port';
import type { AskApi } from './ask';
import { UNDO_NOTIFICATION_PREFIX, undoText } from './messages';

export const RESUME_ALARM = 'resume';
export const LOCKS_KEY = 'locks';
/** storage.session marker (value: worker-init time). Absent => the browser just started. */
export const LOCKS_ATTACH_KEY = 'tabchef.locksAttachStarted';
/** After a browser start, stored locks may re-attach to tabs for this long. */
export const LOCKS_ATTACH_WINDOW_MS = 60_000;
export const PAUSE_UNTIL_KEY = 'pauseUntil';
export const PAUSE_RESTART_KEY = 'pauseRestart';
const MINUTES = { '15m': 15, '1h': 60 } as const;

/** `tabId` is only meaningful within the browser session (restoring live locks after a worker restart). */
export interface LockRecord { url: string; windowId: number; tabId?: number }
export type PauseDuration = '15m' | '1h' | 'restart';

export interface SafetyDeps {
  recentlyClosed: Pick<RecentlyClosed, 'take' | 'list' | 'ready'>;
  log: { add(e: { tabId?: number; ruleId?: string; action: string; detail: string; at: number }): void };
  /** Ask the reconciler to run (it regroups an undone tab). */
  schedule: (reason: string) => void;
  /** Exempt a just-restored tab from dedupe (DedupeHandler.exemptOnce). */
  exemptOnce: (tabId: number) => void;
  /** Arm a dedupe exemption for a tab about to be created (DedupeHandler.armExemption); returns a disarm. */
  armExemption: (url: string, windowId?: number) => () => void;
  api: Pick<AskApi, 'executeScript' | 'sendMessage' | 'createNotification'>;
  bannerFile: string;
  now?: () => number;
}

const hostPattern = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.hostname}/*` : undefined;
  } catch {
    return undefined;
  }
};

/** Pause, tab locks, form-edit flags, protection checks, undo of automatic closes and the undo toast. */
export class SafetyService {
  private readonly now: () => number;
  // Synchronous mirrors, loaded at startup and updated on change (callers need sync answers).
  private pausedUntil = 0;
  private pausedUntilRestart = false;
  private readonly locked = new Set<number>();
  private readonly liveLocks = new Map<number, LockRecord>();
  /** Persisted locks not (yet) matched to a live tab; attachable only until `attachUntil`. */
  private detached: LockRecord[] = [];
  /** Locks of tabs closed with their window: stored for the next browser start, never attached this session. */
  private parked: LockRecord[] = [];
  private attachUntil = 0;
  private readonly formEdited = new Map<number, string | undefined>();
  private chain: Promise<void> = Promise.resolve();
  /** tabs events that arrived before init finished; replayed in order once it has. */
  private initialized = false;
  private readonly seenBeforeReady: { id: number; url: string; windowId: number }[] = [];
  private readonly undoing = new Set<string>();
  readonly ready: Promise<void>;

  constructor(private readonly port: BrowserPort, private readonly deps: SafetyDeps) {
    this.now = deps.now ?? Date.now;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const [local, session] = await Promise.all([
        browser.storage.local.get([PAUSE_UNTIL_KEY, LOCKS_KEY]),
        browser.storage.session.get(PAUSE_RESTART_KEY),
      ]);
      const until = local[PAUSE_UNTIL_KEY];
      if (typeof until === 'number') this.pausedUntil = Math.max(this.pausedUntil, until);
      if (session[PAUSE_RESTART_KEY] === true) this.pausedUntilRestart = true;
      const stored = Array.isArray(local[LOCKS_KEY]) ? (local[LOCKS_KEY] as LockRecord[]) : [];
      const started = (await browser.storage.session.get(LOCKS_ATTACH_KEY))[LOCKS_ATTACH_KEY];
      const t = this.now();
      if (typeof started !== 'number') await browser.storage.session.set({ [LOCKS_ATTACH_KEY]: t });
      this.attachUntil = (typeof started === 'number' ? started : t) + LOCKS_ATTACH_WINDOW_MS;
      if (t < this.attachUntil) {
        this.detached = stored; // browser start (or a worker restart inside its first minute): match by URL
        await this.attachLocks();
      } else {
        // Mid-session worker restart: tab ids are stable, so live locks restore by id alone (the tab may have navigated
        // while the worker slept). Records without a tab id are parked (window closed): kept for the next browser start.
        const tabs = (await this.port.snapshot()).tabs;
        for (const r of stored) {
          if (r.tabId === undefined) {
            this.parked.push({ url: r.url, windowId: r.windowId });
            continue;
          }
          const tab = tabs.find((x) => x.id === r.tabId);
          if (tab) this.attach(tab.id, { url: tab.url, windowId: tab.windowId, tabId: tab.id });
        }
        await this.saveLocks();
      }
    } catch {
      /* start with defaults */
    } finally {
      this.initialized = true;
      const seen = this.seenBeforeReady.splice(0);
      for (const t of seen) this.onTabSeen(t);
    }
  }

  /** Resolves when queued storage writes have landed. */
  idle(): Promise<void> {
    return this.chain;
  }

  private queue(fn: () => Promise<unknown>): void {
    this.chain = this.chain.then(fn).then(() => {}, () => {});
  }

  // ---- pause ----

  pause(d: PauseDuration): void {
    if (d === 'restart') {
      this.pausedUntilRestart = true;
      this.queue(() => browser.storage.session.set({ [PAUSE_RESTART_KEY]: true }));
    } else {
      const until = this.now() + MINUTES[d] * 60_000;
      this.pausedUntil = until;
      this.queue(async () => {
        await browser.storage.local.set({ [PAUSE_UNTIL_KEY]: until });
        await browser.alarms.create(RESUME_ALARM, { delayInMinutes: MINUTES[d] });
      });
    }
  }

  resume(): void {
    this.pausedUntil = 0;
    this.deps.schedule('resume');
    this.pausedUntilRestart = false;
    this.queue(async () => {
      await browser.storage.local.remove(PAUSE_UNTIL_KEY);
      await browser.storage.session.remove(PAUSE_RESTART_KEY);
      await browser.alarms.clear(RESUME_ALARM);
    });
  }

  isPaused(): boolean {
    if (this.pausedUntil > 0 && !this.pausedUntilRestart && this.now() >= this.pausedUntil) this.resume(); // expired by time
    return this.pausedUntilRestart || this.now() < this.pausedUntil;
  }

  /** Wire to alarms.onAlarm. */
  onAlarm(alarm: { name: string }): void {
    if (alarm.name === RESUME_ALARM) this.resume();
  }

  // ---- locks ----

  lock(tabId: number): void {
    this.locked.add(tabId);
    this.queue(async () => {
      const t = (await this.port.snapshot()).tabs.find((x) => x.id === tabId);
      if (t && this.locked.has(tabId)) this.liveLocks.set(tabId, { url: t.url, windowId: t.windowId, tabId });
      await this.saveLocks();
    });
  }

  unlock(tabId: number): void {
    this.locked.delete(tabId);
    this.liveLocks.delete(tabId);
    this.queue(() => this.saveLocks());
  }

  isLocked(tabId: number): boolean {
    return this.locked.has(tabId);
  }

  lockedTabIds(): number[] {
    return [...this.locked];
  }

  private saveLocks(): Promise<void> {
    this.expireDetached();
    return browser.storage.local.set({ [LOCKS_KEY]: [...this.liveLocks.values(), ...this.detached, ...this.parked] });
  }

  private expireDetached(): void {
    if (this.detached.length > 0 && this.now() >= this.attachUntil) this.detached = [];
  }

  /** Re-attach persisted locks to live tabs by URL; the window id only breaks ties (ids change across restarts). */
  private async attachLocks(): Promise<void> {
    if (this.detached.length === 0) return;
    const tabs = (await this.port.snapshot()).tabs;
    const rest: LockRecord[] = [];
    for (const rec of this.detached) {
      const cands = tabs.filter((t) => t.url === rec.url && !this.locked.has(t.id));
      const t = cands.find((x) => x.windowId === rec.windowId) ?? cands[0];
      if (t) this.attach(t.id, { url: t.url, windowId: t.windowId, tabId: t.id });
      else rest.push(rec);
    }
    this.detached = rest;
    await this.saveLocks();
  }

  private attach(tabId: number, rec: LockRecord): void {
    this.locked.add(tabId);
    this.liveLocks.set(tabId, rec);
  }

  /** Wire to tabs.onCreated and (with info.url) tabs.onUpdated. */
  onTabSeen(tab: { id: number; url: string; windowId: number }): void {
    if (this.formEdited.has(tab.id) && this.formEdited.get(tab.id) !== tab.url) this.formEdited.delete(tab.id);
    if (!this.initialized) {
      this.seenBeforeReady.push(tab);
      return;
    }
    const live = this.liveLocks.get(tab.id);
    if (live) {
      if (live.url !== tab.url) {
        this.liveLocks.set(tab.id, { url: tab.url, windowId: tab.windowId, tabId: tab.id });
        this.queue(() => this.saveLocks());
      }
      return;
    }
    if (this.locked.has(tab.id)) return;
    if (this.detached.length > 0 && this.now() >= this.attachUntil) {
      this.expireDetached();
      this.queue(() => this.saveLocks());
    }
    const cands = this.detached.filter((r) => r.url === tab.url);
    const rec = cands.find((r) => r.windowId === tab.windowId) ?? cands[0];
    if (!rec) return;
    this.detached.splice(this.detached.indexOf(rec), 1);
    this.attach(tab.id, { url: tab.url, windowId: tab.windowId, tabId: tab.id });
    this.queue(() => this.saveLocks());
  }

  /** Wire to tabs.onRemoved. A lock on a tab closed with its window stays stored for the next start. */
  onTabRemoved(tabId: number, windowClosing = false): void {
    this.formEdited.delete(tabId);
    const rec = this.liveLocks.get(tabId);
    this.locked.delete(tabId);
    this.liveLocks.delete(tabId);
    if (rec && windowClosing) this.parked.push({ url: rec.url, windowId: rec.windowId });
    if (rec) this.queue(() => this.saveLocks());
  }

  // ---- form edits ----

  /** Best effort: only pages where the banner content script is present report edits. Cleared when the URL changes. */
  markFormEdited(tabId: number, url?: string): void {
    this.formEdited.set(tabId, url);
  }

  isFormEdited(tabId: number): boolean {
    return this.formEdited.has(tabId);
  }

  isProtected(tab: TabSnap): boolean {
    return tab.pinned || this.isLocked(tab.id) || this.isFormEdited(tab.id) || tab.audible || isExemptUrl(tab.url);
  }

  // ---- undo ----

  /** Reopen a closed tab in its window (any normal window if that is gone); the reconciler then regroups it. */
  async undo(id: string): Promise<void> {
    if (this.undoing.has(id)) return; // reserved synchronously: a concurrent call is a no-op
    this.undoing.add(id);
    try {
      await this.undoOnce(id);
    } finally {
      this.undoing.delete(id);
    }
  }

  private async undoOnce(id: string): Promise<void> {
    await this.deps.recentlyClosed.ready; // a freshly woken worker may not have loaded the list yet
    const e = this.deps.recentlyClosed.list().find((x) => x.id === id);
    if (!e) return;
    const { windows } = await this.port.snapshot();
    const normal = windows.filter((w) => w.type === 'normal');
    const windowId = normal.find((w) => w.id === e.windowId)?.id ?? (normal.find((w) => w.focused) ?? normal[0])?.id;
    // Armed before the create: Chrome fires onCreated before tabs.create resolves, so a tabId-based exemption is too late.
    const disarm = this.deps.armExemption(e.url, windowId);
    let tabId: number;
    try {
      tabId = await this.port.createTab({ url: e.url, active: true, ...(windowId !== undefined ? { windowId } : {}) });
    } catch (err) {
      disarm();
      throw err; // the entry stays in the list
    }
    disarm();
    this.deps.exemptOnce(tabId);
    this.deps.recentlyClosed.take(id);
    this.deps.log.add({
      tabId, action: 'undo', detail: `Reopened "${e.title}"${e.groupTitle ? ` (was in ${e.groupTitle})` : ''}`, at: this.now(),
      ...(e.ruleId !== undefined ? { ruleId: e.ruleId } : {}),
    });
    this.deps.schedule('undo');
  }

  // ---- undo toast ----

  /**
   * Offer Undo after an automatic close: banner in the newly focused tab if eligible, else a notification, else nothing
   * (the entry is still in the popup's Recently closed list). Never throws.
   */
  async toast(entryId: string, entry: RecentlyClosedInput, focused: TabSnap): Promise<void> {
    const text = undoText(entry);
    try {
      if (await this.bannerEligible(focused)) {
        await this.deps.api.executeScript(focused.id, this.deps.bannerFile);
        const reply = await this.deps.api.sendMessage(focused.id, { type: 'banner.show', payload: { kind: 'undo', entryId, text } });
        if ((reply as { ok?: unknown } | undefined)?.ok === true) return;
      }
    } catch {
      /* fall through to the notification */
    }
    try {
      if (await this.port.hasPermission({ permissions: ['notifications'] })) {
        await this.deps.api.createNotification(`${UNDO_NOTIFICATION_PREFIX}${entryId}`, {
          title: 'Tab closed', message: text, buttons: [{ title: 'Undo' }],
        });
      }
    } catch {
      /* popup list only */
    }
  }

  private async bannerEligible(t: TabSnap): Promise<boolean> {
    if (t.discarded || t.frozen) return false;
    const origin = hostPattern(t.url);
    if (origin === undefined) return false;
    return (await this.port.hasPermission({ origins: [origin] })) && (await this.port.hasPermission({ permissions: ['scripting'] }));
  }
}
