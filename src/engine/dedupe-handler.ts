import { compilePattern, PatternError } from '../core/match/pattern';
import { findDuplicate, tabUrl } from '../core/dedupe/find';
import { evaluateGroupRules } from '../core/group/evaluate';
import { groupView } from '../core/config/group-view';
import { isExemptUrl, normalizeUrl } from '../core/url/normalize';
import type { Config, TabSnap } from '../core/types';
import type { BrowserPort } from '../platform/browser-port';

export interface RecentlyClosedEntry {
  url: string; title: string; groupTitle?: string; windowId: number; reason: string; ruleId?: string; at: number;
}
export interface LogEntry { tabId?: number; ruleId?: string; action: string; detail: string; at: number }

export interface DedupeDeps {
  recentlyClosed: { add(e: RecentlyClosedEntry): string };
  log: { add(e: LogEntry): void };
  ask: (newTab: TabSnap, existing: TabSnap) => Promise<void>;
  isPaused: () => boolean;
  isLocked: (tabId: number) => boolean;
  /** Awaited before the pause/lock checks (e.g. SafetyService.ready) so state loaded after a worker wake is honoured. */
  beforeDecide?: () => Promise<void>;
  /** Called (fire-and-forget) after an automatic close, with the focused existing tab; used for the undo toast. */
  onClosed?: (entryId: string, entry: RecentlyClosedEntry, focused: TabSnap) => void;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /**
   * chrome.storage.session-like store. It is cleared on browser restart, so a missing SESSION_MARKER at worker start
   * means the browser (or extension) just started and restored tabs may be arriving. Omitted = no startup grace.
   */
  session?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
}

export const SESSION_MARKER = 'tabchef.sessionStarted';

export type CandidateSource = 'pending' | 'committed';

/** A tab created less than this long ago counts as new. */
export const NEW_TAB_AGE_MS = 10_000;
/** After browser startup, all candidates are ignored and no tab created in the window counts as new (session restore). */
export const STARTUP_GRACE_MS = 10_000;
/** An armed (undo) exemption that no tab consumed expires after this long. */
export const PENDING_EXEMPT_TTL_MS = 15_000;

/**
 * Detects duplicates as tabs navigate and, in 'always-switch' mode, closes the NEW tab and focuses the existing one.
 * Never closes the existing tab. A tab is "new" only if it was created < 10 s ago or has never committed a
 * non-exempt URL (e.g. a new-tab page the user types into). Navigations inside an established tab are never deduped.
 * Handling is serialized so each run snapshots after earlier closes have landed.
 */
export class DedupeHandler {
  private readonly created = new Map<number, number>();
  /** Tabs known to have never committed a non-exempt URL. */
  private readonly fresh = new Set<number>();
  /** Tabs known to have committed a non-exempt URL (guards seed()). */
  private readonly established = new Set<number>();
  /** tabId -> normalized key already handled (closed or asked). */
  private readonly handled = new Map<number, string>();
  private readonly inFlight = new Set<string>();
  /** Restored tabs exempt from dedupe: tabId -> normalized key of the restored page (undefined until first seen). */
  private readonly exempt = new Map<number, string | undefined>();
  private pendingExempt: { url: string; windowId: number | undefined; expires: number }[] = [];
  /** Candidate tab ids queued or running in the chain. */
  private readonly queued = new Map<number, number>();
  private chain: Promise<void> = Promise.resolve();
  /** Startup grace window [graceStart, graceEnd). */
  private graceStart: number | undefined;
  private graceEnd: number | undefined;
  /** Resolves once the session marker has been read; candidates wait for it. */
  readonly ready: Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly port: BrowserPort,
    private readonly getConfig: () => Promise<Config>,
    private readonly deps: DedupeDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.ready = deps.session ? this.readSessionMarker(deps.session, this.now()) : Promise.resolve();
  }

  private async readSessionMarker(session: NonNullable<DedupeDeps['session']>, workerStart: number): Promise<void> {
    try {
      if ((await session.get(SESSION_MARKER)) !== undefined) return; // worker restart mid-session: no grace
      this.noteStartup(workerStart);
      await session.set(SESSION_MARKER, workerStart);
    } catch {
      this.noteStartup(workerStart); // unknown: assume the browser just started (safe direction)
    }
  }

  /** (Re)start the startup grace; also called from runtime.onStartup. Extends a grace already running. */
  noteStartup(at: number = this.now()): void {
    if (this.graceStart === undefined || this.graceEnd === undefined || at >= this.graceEnd) this.graceStart = at;
    else this.graceStart = Math.min(this.graceStart, at);
    this.graceEnd = Math.max(this.graceEnd ?? 0, at + STARTUP_GRACE_MS);
  }

  private inStartupGrace(): boolean {
    const t = this.now();
    return this.graceStart !== undefined && this.graceEnd !== undefined && t >= this.graceStart && t < this.graceEnd;
  }

  /** Evaluated lazily so it holds however the startup signals and onCreated events are ordered. */
  private createdInGrace(tabId: number): boolean {
    const at = this.created.get(tabId);
    return at !== undefined && this.graceStart !== undefined && this.graceEnd !== undefined
      && at >= this.graceStart && at < this.graceEnd;
  }

  /** Call from tabs.onCreated. Restored (discarded/unloaded) tabs and tabs created during the startup grace are not new. */
  recordCreated(tabId: number, info: { discarded?: boolean; status?: string } = {}): void {
    if (info.discarded || info.status === 'unloaded') return;
    this.created.set(tabId, this.now());
    if (!this.established.has(tabId)) this.fresh.add(tabId);
  }

  /** Call once when the worker starts: tabs currently on a new-tab page or about:blank count as fresh. */
  seed(tabs: TabSnap[]): void {
    for (const t of tabs) {
      if (this.established.has(t.id)) continue;
      if (isBlankPage(t.url) && (!t.pendingUrl || isBlankPage(t.pendingUrl))) this.fresh.add(t.id);
    }
  }

  /**
   * Exempt a restored (undone) tab from dedupe: until its URL changes, it is never closed or asked about.
   * Call right after creating the tab.
   */
  exemptOnce(tabId: number): void {
    this.exempt.set(tabId, undefined);
  }

  /**
   * Arm an exemption BEFORE creating the tab: Chrome fires onCreated/navigation events before tabs.create resolves.
   * The first candidate tab in that window (any window if undefined) whose URL key matches consumes it. Returns a disarm.
   */
  armExemption(url: string, windowId?: number): () => void {
    const p = { url, windowId, expires: this.now() + PENDING_EXEMPT_TTL_MS };
    this.pendingExempt.push(p);
    return () => {
      const i = this.pendingExempt.indexOf(p);
      if (i >= 0) this.pendingExempt.splice(i, 1);
    };
  }

  private consumePending(tabId: number, key: string, windowId: number, cfg: Config): boolean {
    const t = this.now();
    this.pendingExempt = this.pendingExempt.filter((p) => p.expires > t);
    const i = this.pendingExempt.findIndex((p) =>
      (p.windowId === undefined || p.windowId === windowId) && normalizeUrl(p.url, cfg.dedupe)?.key === key);
    if (i < 0) return false;
    this.pendingExempt.splice(i, 1);
    this.exempt.set(tabId, key);
    return true;
  }

  private exemptNow(tabId: number, key: string, windowId: number, cfg: Config): boolean {
    return this.isExempt(tabId, key) || this.consumePending(tabId, key, windowId, cfg);
  }

  /** The first non-exempt URL seen pins the exemption; a different URL later ends it. */
  private isExempt(tabId: number, key: string): boolean {
    if (!this.exempt.has(tabId)) return false;
    const k = this.exempt.get(tabId);
    if (k === undefined) {
      this.exempt.set(tabId, key);
      return true;
    }
    if (k === key) return true;
    this.exempt.delete(tabId);
    return false;
  }

  /** Call from tabs.onRemoved. */
  onRemoved(tabId: number): void {
    this.exempt.delete(tabId);
    this.created.delete(tabId);
    this.fresh.delete(tabId);
    this.established.delete(tabId);
    this.handled.delete(tabId);
  }

  /** Call from tabs.onReplaced: the added tab inherits the removed tab's age/freshness; memos are cleared. */
  onReplaced(addedId: number, removedId: number): void {
    const at = this.created.get(removedId);
    if (at !== undefined) this.created.set(addedId, at);
    if (this.fresh.has(removedId) && !this.established.has(addedId)) this.fresh.add(addedId);
    if (this.established.has(removedId)) {
      this.established.add(addedId);
      this.fresh.delete(addedId);
    }
    this.handled.delete(addedId);
    this.onRemoved(removedId);
  }

  private isYoung(tabId: number): boolean {
    const at = this.created.get(tabId);
    return at !== undefined && this.now() - at < NEW_TAB_AGE_MS && !this.createdInGrace(tabId);
  }

  private isFresh(tabId: number): boolean {
    return this.fresh.has(tabId) && !this.createdInGrace(tabId);
  }

  /** True if the tab may itself be a dedupe candidate right now. */
  private isCandidateLike(tabId: number): boolean {
    return this.isYoung(tabId) || this.isFresh(tabId) || this.queued.has(tabId);
  }

  async onCandidate(tabId: number, url: string, source: CandidateSource): Promise<void> {
    // Freshness is "before this navigation": capture it before the commit marks the tab established.
    const wasFresh = this.fresh.has(tabId);
    if (source === 'committed' && !isExemptUrl(url)) {
      this.fresh.delete(tabId);
      this.established.add(tabId);
    }
    if (isExemptUrl(url)) return;
    await this.ready;
    await this.deps.beforeDecide?.();
    if (this.inStartupGrace() || this.deps.isPaused()) return;
    const isNew = this.isYoung(tabId) || (wasFresh && !this.createdInGrace(tabId));
    if (!isNew || this.deps.isLocked(tabId)) return;
    const cfg = await this.getConfig();
    const key = normalizeUrl(url, cfg.dedupe)?.key;
    if (key === undefined || this.handled.get(tabId) === key) return;
    const flight = `${tabId}\n${key}`;
    if (this.inFlight.has(flight)) return;
    this.inFlight.add(flight);
    this.queued.set(tabId, (this.queued.get(tabId) ?? 0) + 1);
    const run = this.chain.then(() => this.handle(tabId, url, key, cfg));
    this.chain = run.catch(() => {});
    try {
      await run;
    } finally {
      this.inFlight.delete(flight);
      const n = (this.queued.get(tabId) ?? 1) - 1;
      if (n > 0) this.queued.set(tabId, n);
      else this.queued.delete(tabId);
    }
  }

  private async handle(tabId: number, url: string, key: string, cfg: Config): Promise<void> {
    if (this.handled.get(tabId) === key || this.isExempt(tabId, key)) return;
    const s = cfg.dedupe;
    const snap = await this.port.snapshot();
    const live = snap.tabs.find((t) => t.id === tabId);
    if (!live) return;
    if (this.exemptNow(tabId, key, live.windowId, cfg)) return;
    const newTab: TabSnap = { ...live, url };
    delete newTab.pendingUrl;
    const rules = groupView(cfg);
    const match = evaluateGroupRules(newTab, rules);
    const ruleId = match?.ruleId;
    const ruleMode = ruleId !== undefined ? rules.find((r) => r.id === ruleId)?.dedupe : undefined;
    const locked = new Set(snap.tabs.filter((t) => this.deps.isLocked(t.id)).map((t) => t.id));
    // Another new tab may be "existing" only if it is older (lower id): of two new duplicates, the newer one closes.
    const pool = snap.tabs.filter((t) => t.id < tabId || !this.isCandidateLike(t.id));
    const dup = findDuplicate(newTab, pool, s, ruleMode, locked);
    if (!dup) return;
    let mode = ruleMode ?? s.mode;
    if (mode === 'off') return;
    if (mode === 'ask' && matchesAny(url, s.alwaysSwitchSites ?? [])) mode = 'always-switch';
    if (mode === 'ask') {
      if (this.exemptNow(tabId, key, live.windowId, cfg)) return;
      this.handled.set(tabId, key);
      await this.deps.ask(newTab, dup.existing);
      return;
    }

    // Race guard: the user may have navigated, pinned or closed either tab since detection.
    const fresh = await this.port.snapshot();
    const cand = fresh.tabs.find((t) => t.id === tabId);
    const existing = fresh.tabs.find((t) => t.id === dup.existing.id);
    if (!cand || !existing || cand.pinned || this.deps.isLocked(tabId) || this.exemptNow(tabId, key, cand.windowId, cfg)) return;
    const keyOf = (u: string | undefined) => (u ? normalizeUrl(u, s)?.key : undefined);
    if (keyOf(cand.pendingUrl) !== key && keyOf(cand.url) !== key) return;
    if (keyOf(tabUrl(existing)) !== key) return;

    this.handled.set(tabId, key);
    const at = this.now();
    const groupTitle = fresh.groups.find((g) => g.id === cand.groupId)?.title;
    const entry: RecentlyClosedEntry = {
      url, title: cand.title, windowId: cand.windowId, reason: 'duplicate', at,
      ...(groupTitle !== undefined ? { groupTitle } : {}),
      ...(ruleId !== undefined ? { ruleId } : {}),
    };
    const entryId = this.deps.recentlyClosed.add(entry);
    await this.port.closeTab(tabId);
    await this.port.focusTab(existing.id, existing.windowId, s.followFragment ? withFragment(tabUrl(existing), dup.fragment) : undefined);
    this.deps.log.add({
      tabId, action: 'dedupe-close', detail: `Closed duplicate of tab ${existing.id} (${existing.title})`, at,
      ...(ruleId !== undefined ? { ruleId } : {}),
    });
    this.deps.onClosed?.(entryId, entry, existing);
  }
}

function matchesAny(url: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (compilePattern(p)(url)) return true;
    } catch (e) {
      if (!(e instanceof PatternError)) throw e;
    }
  }
  return false;
}

/** chrome://newtab/, chrome://new-tab-page/ or about:blank (not empty/unparseable URLs). */
function isBlankPage(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const u = new URL(url);
    return u.protocol === 'chrome:' && (u.hostname === 'newtab' || u.hostname === 'new-tab-page');
  } catch {
    return false;
  }
}

/** existingUrl with `#fragment`, or undefined when the fragment is empty or already the existing tab's fragment. */
export function withFragment(existingUrl: string, fragment: string): string | undefined {
  if (!fragment) return undefined;
  try {
    const u = new URL(existingUrl);
    if (u.hash.replace(/^#/, '') === fragment) return undefined;
    u.hash = fragment;
    return u.href;
  } catch {
    return undefined;
  }
}
