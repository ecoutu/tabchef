import { compilePattern, PatternError } from '../core/match/pattern';
import { findDuplicate, tabUrl } from '../core/dedupe/find';
import { evaluateTab } from '../core/lang/evaluate';
import { isDryRunRule, liveProgram } from '../core/lang/dry-run';
import { isExemptUrl, normalizeUrl } from '../core/url/normalize';
import type { DedupeOverride, Snapshot, TabSnap } from '../core/types';
import type { Program, TabFacts } from '../core/lang/types';
import type { BrowserPort } from '../platform/browser-port';
import { SESSION_MARKER, STARTUP_GRACE_MS } from './dedupe-constants';

export interface RecentlyClosedEntry {
  url: string; title: string; groupTitle?: string; windowId: number; reason: string; ruleId?: string; at: number;
}
export interface LogEntry { tabId?: number; ruleId?: string; action: string; detail: string; at: number; dryRun?: true }

export interface DedupeDeps {
  recentlyClosed: { add(e: RecentlyClosedEntry): string };
  log: { add(e: LogEntry): void };
  ask: (newTab: TabSnap, existing: TabSnap) => Promise<void>;
  isPaused: () => boolean;
  isLocked: (tabId: number) => boolean;
  /** Anchor tabs (M2 T11) are never closed or asked about as the new tab; as the existing tab they are kept. Default: none. */
  isAnchor?: (tabId: number) => boolean;
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

export { SESSION_MARKER, STARTUP_GRACE_MS } from './dedupe-constants';

export type CandidateSource = 'pending' | 'committed';

/** A tab created less than this long ago counts as new. */
export const NEW_TAB_AGE_MS = 10_000;
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
  /** tabId -> `<rule>\n<key>` of the would-close already logged for it (dry run, M2 T12). */
  private readonly wouldLogged = new Map<number, string>();
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
    /** The shared compiled Program (background ProgramCache.get, ruling R4): `p.dedupe` is the effective settings. */
    private readonly getProgram: () => Promise<Program>,
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

  /** Never closed as the new tab: locked and anchor tabs. */
  private kept(tabId: number): boolean {
    return this.deps.isLocked(tabId) || (this.deps.isAnchor?.(tabId) ?? false);
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

  private consumePending(tabId: number, key: string, windowId: number, p: Program): boolean {
    const t = this.now();
    this.pendingExempt = this.pendingExempt.filter((e) => e.expires > t);
    const i = this.pendingExempt.findIndex((e) =>
      (e.windowId === undefined || e.windowId === windowId) && normalizeUrl(e.url, p.dedupe)?.key === key);
    if (i < 0) return false;
    this.pendingExempt.splice(i, 1);
    this.exempt.set(tabId, key);
    return true;
  }

  private exemptNow(tabId: number, key: string, windowId: number, p: Program): boolean {
    return this.isExempt(tabId, key) || this.consumePending(tabId, key, windowId, p);
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
    this.wouldLogged.delete(tabId);
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
    if (!isNew || this.kept(tabId)) return;
    const program = await this.getProgram();
    const key = normalizeUrl(url, program.dedupe)?.key;
    if (key === undefined || this.handled.get(tabId) === key) return;
    const flight = `${tabId}\n${key}`;
    if (this.inFlight.has(flight)) return;
    this.inFlight.add(flight);
    this.queued.set(tabId, (this.queued.get(tabId) ?? 0) + 1);
    const run = this.chain.then(() => this.handle(tabId, url, key, program));
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

  /**
   * `key` (settings-only key of `url`) identifies the candidate for the handled/exempt memos; the duplicate itself is
   * decided with the winning rule's dedupe override (R25), whose key can differ (keepFragment).
   */
  private async handle(tabId: number, url: string, key: string, p: Program): Promise<void> {
    if (this.handled.get(tabId) === key || this.isExempt(tabId, key)) return;
    const s = p.dedupe;
    const snap = await this.port.snapshot();
    const live = snap.tabs.find((t) => t.id === tabId);
    if (!live) return;
    if (this.exemptNow(tabId, key, live.windowId, p)) return;
    const newTab: TabSnap = { ...live, url };
    delete newTab.pendingUrl;
    const facts: TabFacts = { tab: newTab, ...openerOf(snap, newTab) };
    const locked = new Set(snap.tabs.filter((t) => this.kept(t.id)).map((t) => t.id));
    // Another new tab may be "existing" only if it is older (lower id): of two new duplicates, the newer one closes.
    const pool = snap.tabs.filter((t) => t.id < tabId || !this.isCandidateLike(t.id));
    const outcome = (d: { o?: DedupeOverride }) => {
      const dup = findDuplicate(newTab, pool, s, d.o, locked);
      if (!dup) return undefined;
      const mode = d.o?.mode ?? s.mode;
      if (mode === 'off') return undefined;
      return { dup, mode: mode === 'ask' && matchesAny(url, s.alwaysSwitchSites ?? []) ? 'always-switch' : mode };
    };
    // Dry run (R10/R48): what a winning dry-run dedupe rule (or, globally, the whole Program) would do is only logged.
    const dry = dryDedupeDecision(p, facts, this.now());
    if (dry) {
      const would = outcome(dry);
      const memo = `${dry.ruleId ?? ''}\n${key}`;
      if (would && this.wouldLogged.get(tabId) !== memo) {
        this.wouldLogged.set(tabId, memo);
        const { existing } = would.dup;
        this.deps.log.add({
          tabId, action: 'would-close', at: this.now(), dryRun: true, ...(dry.ruleId !== undefined ? { ruleId: dry.ruleId } : {}),
          detail: would.mode === 'ask'
            ? `Would ask about closing duplicate of tab ${existing.id} (${existing.title}) (dry run)`
            : `Would close duplicate of tab ${existing.id} (${existing.title}) (dry run)`,
        });
      }
    }
    // Global dry run (R50): an engine-initiated close or ask is only logged. A user's banner choice (ask.ts switchTo),
    // popup close / close-all and undo still apply.
    if (p.dryRun) return;
    const { o, ruleId } = dedupeDecision(p, facts, this.now());
    const act = outcome({ ...(o && { o }) });
    if (!act) return;
    const { dup, mode } = act;
    if (mode === 'ask') {
      if (this.exemptNow(tabId, key, live.windowId, p)) return;
      this.handled.set(tabId, key);
      await this.deps.ask(newTab, dup.existing);
      return;
    }

    // Race guard: the user may have navigated, pinned or closed either tab since detection.
    const fresh = await this.port.snapshot();
    const cand = fresh.tabs.find((t) => t.id === tabId);
    const existing = fresh.tabs.find((t) => t.id === dup.existing.id);
    if (!cand || !existing || cand.pinned || this.kept(tabId) || this.exemptNow(tabId, key, cand.windowId, p)) return;
    const keyOf = (u: string | undefined) => (u ? normalizeUrl(u, s, o)?.key : undefined);
    const dupKey = keyOf(url);
    if (dupKey === undefined || (keyOf(cand.pendingUrl) !== dupKey && keyOf(cand.url) !== dupKey)) return;
    if (keyOf(tabUrl(existing)) !== dupKey) return;

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
    const follow = o?.followFragment ?? s.followFragment;
    await this.port.focusTab(existing.id, existing.windowId, follow ? withFragment(tabUrl(existing), dup.fragment) : undefined);
    this.deps.log.add({
      tabId, action: 'dedupe-close', detail: `Closed duplicate of tab ${existing.id} (${existing.title})`, at,
      ...(ruleId !== undefined ? { ruleId } : {}),
    });
    this.deps.onClosed?.(entryId, entry, existing);
  }
}

/** The per-rule override (R25) of `p`'s winning dedupe action, and the rule recorded with a close: that rule, else (as M1) the group rule. */
function decisionOf(p: Program, f: TabFacts, now: number): { o?: DedupeOverride; ruleId?: string } {
  const ev = evaluateTab(p, f, now);
  const d = ev.dedupe;
  const ruleId = d?.key ?? ev.group?.key;
  return { ...(d && { o: d }), ...(ruleId !== undefined && { ruleId }) };
}

/**
 * The live dedupe decision for tab facts `f`: dry-run rules fall through (R48), so neither the override nor the
 * recorded cause ever comes from a dry-run rule; the next live rule (else the global settings) decides.
 */
export function dedupeDecision(p: Program, f: TabFacts, now: number): { o?: DedupeOverride; ruleId?: string } {
  return decisionOf(liveProgram(p), f, now);
}

/**
 * The decision only logged as would-close (M2 T12): under global dry run the whole Program's; otherwise the winning
 * dedupe action's, when that rule is dry-run. Undefined when nothing is dry-run for this tab.
 */
export function dryDedupeDecision(p: Program, f: TabFacts, now: number): { o?: DedupeOverride; ruleId?: string } | undefined {
  if (p.dryRun) return decisionOf(p, f, now);
  const d = evaluateTab(p, f, now).dedupe;
  return d && isDryRunRule(p, d.key) ? { o: d, ruleId: d.key } : undefined;
}

/** `{ opener }` fact for evaluateTab when the tab's opener is in the snapshot. */
export function openerOf(snap: Snapshot, t: TabSnap): { opener?: TabSnap } {
  const opener = t.openerTabId !== undefined ? snap.tabs.find((x) => x.id === t.openerTabId) : undefined;
  return opener ? { opener } : {};
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
