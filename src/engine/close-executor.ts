// CloseExecutor (M2 T9): runs the `close` action. `mode: 'suggest'` lists the tab in suggestions() (the Finished view);
// `mode: 'auto'` schedules a delayed close, persisted in storage.session (`pendingCloses`) and armed with setTimeout
// (<= 25 s) or chrome.alarms (`close:<tabId>`) otherwise, so it survives a worker restart (rearm).
//
// Fire-time order (ruling R13, Review Focus #1):
//  1. pause-all (safety.isPaused) or the rule / its recipe is paused (PermissionsManager) -> keep pending (rearm on resume)
//  2. the tab is gone, its normalized URL changed or the rule no longer wins -> drop
//  3. (dry-run rules never win here: they fall through, R48; see below)
//  4. anchor (T11 seam) or undo-exempt (R24) -> skip
//  5. isProtected or isActiveFocused -> protected-close banner if eligible, else a suggestion; never close
//  6. form state unobservable (no watch at that URL) -> close only if the tab was not active since its commit
// An entry is deleted (and the deletion stored) before the tab is closed or bannered, so it never fires twice.
//
// Dry run (M2 T12, rulings R10 / R48): the live close is decided as if dry-run rules did not exist, so the next live
// close rule wins. A dry-run close rule that would have won (every rule under global dry run) is logged once per page
// as `would-close` (flagged dryRun) when the tab is evaluated, and never scheduled.
// Global dry run (R50) blocks only these engine-initiated closes: a protected-close banner answer still closes.
import { evaluateTab, type CloseResult } from '../core/lang/evaluate';
import { liveProgram } from '../core/lang/dry-run';
import type { Program } from '../core/lang/types';
import type { RecentlyClosed, RecentlyClosedInput } from '../core/safety/recently-closed';
import type { WhyEntry } from '../core/safety/why-log';
import type { Snapshot, TabSnap } from '../core/types';
import { normalizeUrl } from '../core/url/normalize';
import type { BrowserPort } from '../platform/browser-port';
import type { PageFacts } from './page-facts';
import type { SafetyService } from './safety';

export const PENDING_CLOSES_KEY = 'pendingCloses';
export const CLOSE_SUGGESTIONS_KEY = 'closeSuggestions';
export const CLOSE_EXEMPT_KEY = 'closeExempt';
export const CLOSE_ALARM_PREFIX = 'close:';
/** Delays up to this use setTimeout; longer ones chrome.alarms (ruling R15: Chrome 116–119 round those up to 60 s). */
export const TIMER_MAX_MS = 25_000;

export interface PendingClose {
  tabId: number; url: string; ruleKey: string; fireAt: number;
  /** When the tab's current document committed (or this worker first saw it). */
  committedAt: number;
  /** The tab was active at some point since `committedAt`. */
  activated: boolean;
}
export interface CloseSuggestion { tabId: number; ruleKey: string; reason: string }
interface StoredSuggestion extends CloseSuggestion { url: string }

/**
 * Ruling R51: after a config change, re-evaluate every open tab, so enabling a close rule also applies to tabs that
 * are already open (what preview.change reports). `syncPermissions` (PermissionsManager.onChanged) runs first, so the
 * paused set, and with it the ProgramCache key, is current. Re-evaluating a pending entry of the same rule keeps its
 * fire time (evaluateIn); the R13 fire-time checks are unchanged.
 */
export async function afterConfigChange(syncPermissions: () => Promise<void>, closes: Pick<CloseExecutor, 'evaluateAll'>): Promise<void> {
  await syncPermissions();
  await closes.evaluateAll();
}

export interface CloseExecutorDeps {
  safety: Pick<SafetyService, 'isPaused' | 'isProtected' | 'isActiveFocused' | 'toast'>;
  recentlyClosed: Pick<RecentlyClosed, 'add' | 'take'>;
  log: { add(e: WhyEntry): void };
  facts: Pick<PageFacts, 'get'>;
  /** Show the protected-close banner in the tab; false when it cannot be shown (not eligible, no ack). */
  banner: (tabId: number, kind: 'protected-close', ruleKey: string) => Promise<boolean>;
  /** chrome.alarms seam (D40): `whenMs` is the absolute fire time. */
  alarms: { create(name: string, whenMs: number): Promise<unknown> | void; clear(name: string): Promise<unknown> | void };
  session: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
  /** A rule key or its recipe waits for a permission (PermissionsManager.paused). Default: never. */
  isRulePaused?: (ruleKey: string) => boolean;
  /** Anchor tabs are never auto-closed (R11; anchors are M2 T11). Default: none. */
  isAnchor?: (tabId: number) => boolean;
  /** The watch content script runs at `url`, so form edits there are known (PermissionsManager.covers). Default: no. */
  observesForm?: (url: string) => boolean;
  /**
   * Awaited before every step (background: SafetyService and PageFacts ready), so a restarted worker never decides on
   * unloaded locks or page facts (a lock would look absent, a pageText rule unmatched).
   */
  beforeRun?: () => Promise<void>;
  now?: () => number;
}

/** A stored entry; `committedAt` / `activated` may be missing (then treated as active since commit: never closed unseen). */
const isEntry = (v: unknown): v is Omit<PendingClose, 'committedAt' | 'activated'> & Partial<PendingClose> => {
  const x = v as Record<string, unknown> | null;
  return typeof x === 'object' && x !== null && typeof x.tabId === 'number' && typeof x.url === 'string'
    && typeof x.ruleKey === 'string' && typeof x.fireAt === 'number';
};
const isSuggestion = (v: unknown): v is StoredSuggestion => {
  const x = v as Record<string, unknown> | null;
  return typeof x === 'object' && x !== null && typeof x.tabId === 'number' && typeof x.url === 'string'
    && typeof x.ruleKey === 'string' && typeof x.reason === 'string';
};

/** The URL identity a close is tied to: the dedupe normalization (tracking params, fragment, ...) of the program. */
function normOf(url: string, p: Program): string {
  return normalizeUrl(url, p.dedupe)?.key ?? url;
}

export class CloseExecutor {
  private readonly now: () => number;
  private readonly pending = new Map<number, PendingClose>();
  private readonly suggested = new Map<number, StoredSuggestion>();
  /** Undone closes (R24): tab -> normalized URL; exempt while the tab stays there. */
  private readonly exempted = new Map<number, string>();
  /**
   * Tab -> {normalized URL, rule} already dealt with for its current page and not to be re-armed by re-evaluation:
   * a protected-close banner shown or answered. Cleared on navigation. Memory only.
   */
  private readonly settled = new Map<number, { url: string; ruleKey: string }>();
  /** Tab -> {normalized URL, dry-run rule} whose would-close was logged for its current page. Memory only. */
  private readonly wouldLogged = new Map<number, { url: string; ruleKey: string }>();
  /** Protected-close banners awaiting an answer: tab -> {normalized URL, rule}. Memory only (lost = Keep). */
  private readonly asking = new Map<number, { url: string; ruleKey: string }>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly commits = new Map<number, number>();
  private readonly activations = new Map<number, number>();
  private chain: Promise<void>;
  readonly ready: Promise<void>;

  constructor(
    private readonly port: BrowserPort,
    private readonly getProgram: () => Promise<Program>,
    private readonly deps: CloseExecutorDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.ready = this.load();
    this.chain = this.ready;
  }

  private async load(): Promise<void> {
    try {
      const [p, s, x] = await Promise.all([
        this.deps.session.get(PENDING_CLOSES_KEY), this.deps.session.get(CLOSE_SUGGESTIONS_KEY), this.deps.session.get(CLOSE_EXEMPT_KEY),
      ]);
      if (Array.isArray(p)) for (const e of p) if (isEntry(e)) this.pending.set(e.tabId, { committedAt: 0, activated: true, ...e });
      if (Array.isArray(s)) for (const e of s) if (isSuggestion(e)) this.suggested.set(e.tabId, e);
      if (Array.isArray(x)) for (const e of x) if (Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'string') this.exempted.set(e[0], e[1]);
    } catch {
      /* start empty */
    }
  }

  /** Serializes every state change (one worker), after the stored state loaded. Never rejects. */
  private run(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      await this.deps.beforeRun?.();
      await fn();
    }).catch((e: unknown) => { console.warn('[tabchef] close executor failed', e); });
    this.chain = next;
    return next;
  }

  private async save(): Promise<void> {
    await Promise.all([
      this.deps.session.set(PENDING_CLOSES_KEY, [...this.pending.values()]),
      this.deps.session.set(CLOSE_SUGGESTIONS_KEY, [...this.suggested.values()]),
      this.deps.session.set(CLOSE_EXEMPT_KEY, [...this.exempted]),
    ]);
  }

  /** Tabs the Finished view lists: closes the rule only suggests, or that protection turned into a suggestion. */
  suggestions(): CloseSuggestion[] {
    return [...this.suggested.values()].map(({ tabId, ruleKey, reason }) => ({ tabId, ruleKey, reason }));
  }

  /** Resolves when queued work has finished (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  // ---- triggers ----

  /**
   * Wire to webNavigation.onCommitted (frameId 0) before evaluate: activity is counted from here. A pending close of the
   * same page (a reload; tabs.onUpdated may have scheduled it just before the commit) restarts its activity baseline.
   */
  onCommitted(tabId: number): Promise<void> {
    const at = this.now();
    this.commits.set(tabId, at);
    return this.run(async () => {
      const e = this.pending.get(tabId);
      if (!e) return;
      const tab = (await this.port.snapshot()).tabs.find((t) => t.id === tabId);
      e.committedAt = at;
      e.activated = tab?.active ?? false;
      await this.save();
    });
  }

  /** Wire to tabs.onActivated. */
  onActivated(tabId: number): Promise<void> {
    this.activations.set(tabId, this.now());
    return this.run(async () => {
      const e = this.pending.get(tabId);
      if (!e || e.activated) return;
      e.activated = true;
      await this.save();
    });
  }

  /** On a committed navigation (and same-document URL change) of the tab. */
  evaluate(tabId: number): Promise<void> {
    return this.run(async () => {
      const [snap, p] = await Promise.all([this.port.snapshot(), this.getProgram()]);
      if (await this.evaluateIn(snap, p, tabId)) await this.save();
    });
  }

  /** New page facts for the tab (createContentHandler's onFacts hook, M2 T7). */
  onFacts(tabId: number): Promise<void> {
    return this.evaluate(tabId);
  }

  /** Every open tab (browser startup, and every config / Program change: afterConfigChange, R51). */
  evaluateAll(): Promise<void> {
    return this.run(async () => {
      const [snap, p] = await Promise.all([this.port.snapshot(), this.getProgram()]);
      let changed = false;
      for (const t of snap.tabs) changed = (await this.evaluateIn(snap, p, t.id)) || changed;
      if (changed) await this.save();
    });
  }

  /** Wire to tabs.onRemoved (and the replaced tab of tabs.onReplaced). */
  onTabRemoved(tabId: number): Promise<void> {
    this.commits.delete(tabId);
    this.activations.delete(tabId);
    return this.run(async () => {
      const had = this.pending.has(tabId) || this.suggested.has(tabId) || this.exempted.has(tabId);
      this.forget(tabId);
      if (had) await this.save();
    });
  }

  /** An undone close reopened `url` in `tabId` (SafetyService onUndone): exempt it until its URL changes (R24). */
  exempt(tabId: number, url: string): Promise<void> {
    return this.run(async () => {
      const p = await this.getProgram();
      this.cancel(tabId);
      this.suggested.delete(tabId);
      this.exempted.set(tabId, normOf(url, p));
      await this.save();
    });
  }

  /** Re-arm every stored pending close (worker start, resume, permission change). Overdue entries fire now. */
  rearm(): Promise<void> {
    return this.run(async () => {
      for (const e of this.pending.values()) this.arm(e);
    });
  }

  /** Wire to alarms.onAlarm; ignores names without the `close:` prefix. */
  onAlarm(name: string): Promise<void> {
    if (!name.startsWith(CLOSE_ALARM_PREFIX)) return Promise.resolve();
    const tabId = Number(name.slice(CLOSE_ALARM_PREFIX.length));
    return Number.isInteger(tabId) ? this.fire(tabId) : Promise.resolve();
  }

  /** The protected-close banner's answer (D22). Close only while the tab is still on the page the banner asked about. */
  onCloseChoice(tabId: number, choice: 'close' | 'keep'): Promise<void> {
    return this.run(async () => {
      const ask = this.asking.get(tabId);
      if (!ask) return; // answered already, or asked by a worker that has since restarted: Keep
      this.asking.delete(tabId);
      if (choice === 'keep') return;
      const [snap, p] = await Promise.all([this.port.snapshot(), this.getProgram()]);
      const tab = snap.tabs.find((t) => t.id === tabId);
      if (!tab || normOf(tab.url, p) !== ask.url) return;
      await this.close(snap, p, tab, ask.ruleKey, 'close-confirmed', 'Closed from the banner', false);
    });
  }

  // ---- internals ----

  /** Evaluate one tab; true when stored state changed. Runs inside `run`. */
  private async evaluateIn(snap: Snapshot, p: Program, tabId: number): Promise<boolean> {
    const tab = snap.tabs.find((t) => t.id === tabId);
    if (!tab) {
      const had = this.pending.has(tabId) || this.suggested.has(tabId) || this.exempted.has(tabId);
      this.forget(tabId);
      return had;
    }
    const url = normOf(tab.url, p);
    let changed = false;
    // The tab navigated away: whatever was tied to its old page no longer applies.
    const pend = this.pending.get(tabId);
    if (pend && normOf(pend.url, p) !== url) { this.cancel(tabId); changed = true; }
    if (this.suggested.has(tabId) && normOf(this.suggested.get(tabId)!.url, p) !== url) { this.suggested.delete(tabId); changed = true; }
    if (this.exempted.has(tabId) && this.exempted.get(tabId) !== url) { this.exempted.delete(tabId); changed = true; }
    if (this.settled.get(tabId)?.url !== url) this.settled.delete(tabId);
    if (this.asking.get(tabId)?.url !== url) this.asking.delete(tabId);
    if (this.wouldLogged.get(tabId)?.url !== url) this.wouldLogged.delete(tabId);
    if (this.exempted.has(tabId)) return changed;
    this.logDryRun(snap, p, tab, url);

    const kept = this.pending.get(tabId);
    // A paused rule is left out of the Program: its entry stays pending until resumed (R13).
    if (kept && this.rulePaused(kept.ruleKey)) return changed;
    const r = this.closeOf(snap, p, tab);
    const sug = this.suggested.get(tabId);
    if (!r) {
      if (kept) this.cancel(tabId);
      if (sug) this.suggested.delete(tabId);
      this.settled.delete(tabId);
      return changed || !!kept || !!sug;
    }
    if (kept?.ruleKey === r.key && r.mode === 'auto') return changed; // already scheduled: keep its fire time
    if (sug?.ruleKey === r.key || this.settled.get(tabId)?.ruleKey === r.key) return changed;
    if (kept) { this.cancel(tabId); changed = true; }
    if (sug) { this.suggested.delete(tabId); changed = true; }
    if (this.deps.isAnchor?.(tabId)) return changed;
    if (r.mode === 'suggest') {
      this.suggest(p, tab, r.key, `Suggested by "${this.nameOf(p, r.key)}"`);
      return true;
    }
    const now = this.now();
    // A commit this worker did not see (it restarted since, or the page loaded before it ran) leaves the tab's activity
    // unknown: count it as used since load (R46), as for stored entries without these fields. onCommitted resets it.
    const seen = this.commits.get(tabId);
    const committedAt = seen ?? now;
    const e: PendingClose = {
      tabId, url: tab.url, ruleKey: r.key, fireAt: now + r.afterMs, committedAt,
      activated: seen === undefined || tab.active || (this.activations.get(tabId) ?? -Infinity) >= committedAt,
    };
    this.pending.set(tabId, e);
    this.arm(e);
    return true;
  }

  /**
   * A winning dry-run close rule: logged once per page (normalized URL) and rule, never scheduled. Not for anchors
   * (never closed) or while everything is paused.
   */
  private logDryRun(snap: Snapshot, p: Program, tab: TabSnap, url: string): void {
    const r = this.closeOf(snap, p, tab, true);
    if (!r?.dryRun || this.deps.isAnchor?.(tab.id) || this.deps.safety.isPaused()) return;
    const memo = this.wouldLogged.get(tab.id);
    if (memo?.url === url && memo.ruleKey === r.key) return;
    this.wouldLogged.set(tab.id, { url, ruleKey: r.key });
    this.deps.log.add({
      tabId: tab.id, ruleId: r.key, action: 'would-close', dryRun: true, at: this.now(),
      detail: r.mode === 'suggest' ? 'Would suggest closing (dry run)' : 'Would close (dry run)',
    });
  }

  /** The winning close action: the live one (dry-run rules fall through, R48), or with `withDryRun` any rule's. */
  private closeOf(snap: Snapshot, p: Program, tab: TabSnap, withDryRun = false): CloseResult | undefined {
    const opener = tab.openerTabId !== undefined ? snap.tabs.find((t) => t.id === tab.openerTabId) : undefined;
    const groupTitle = tab.groupId !== -1 ? snap.groups.find((g) => g.id === tab.groupId)?.title : undefined;
    const page = this.deps.facts.get(tab.id);
    return evaluateTab(withDryRun ? p : liveProgram(p), {
      tab, ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }), ...(page && { page }),
    }, this.now()).close;
  }

  private rulePaused(key: string): boolean {
    const paused = this.deps.isRulePaused;
    if (!paused) return false;
    const slash = key.indexOf('/');
    return paused(key) || (slash > 0 && paused(key.slice(0, slash)));
  }

  private nameOf(p: Program, key: string): string {
    return p.rules.find((r) => r.key === key)?.rule.name || key;
  }

  private suggest(p: Program, tab: TabSnap, ruleKey: string, detail: string): void {
    this.suggested.set(tab.id, { tabId: tab.id, url: tab.url, ruleKey, reason: this.nameOf(p, ruleKey) });
    this.deps.log.add({ tabId: tab.id, ruleId: ruleKey, action: 'close-suggested', detail, at: this.now() });
  }

  /** Start the timer or alarm for `e` (replacing any); an overdue entry fires right after the current step. */
  private arm(e: PendingClose): void {
    this.clearTimer(e.tabId);
    const delay = e.fireAt - this.now();
    if (delay <= 0) {
      void this.fire(e.tabId);
    } else if (delay <= TIMER_MAX_MS) {
      this.timers.set(e.tabId, setTimeout(() => { this.timers.delete(e.tabId); void this.fire(e.tabId); }, delay));
    } else {
      void Promise.resolve(this.deps.alarms.create(`${CLOSE_ALARM_PREFIX}${e.tabId}`, e.fireAt)).catch(() => {});
    }
  }

  private clearTimer(tabId: number): void {
    const t = this.timers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(tabId);
  }

  /** Drop the pending close of the tab (timer and alarm). The caller saves. */
  private cancel(tabId: number): void {
    const e = this.pending.get(tabId);
    this.pending.delete(tabId);
    this.clearTimer(tabId);
    // Whether it was armed as an alarm (by this worker or an earlier one) is not tracked: clearing is cheap.
    if (e) void Promise.resolve(this.deps.alarms.clear(`${CLOSE_ALARM_PREFIX}${tabId}`)).catch(() => {});
  }

  private forget(tabId: number): void {
    this.cancel(tabId);
    this.suggested.delete(tabId);
    this.exempted.delete(tabId);
    this.settled.delete(tabId);
    this.asking.delete(tabId);
    this.wouldLogged.delete(tabId);
  }

  private fire(tabId: number): Promise<void> {
    return this.run(() => this.fireNow(tabId));
  }

  private async fireNow(tabId: number): Promise<void> {
    const e = this.pending.get(tabId);
    if (!e) return; // fired or cancelled already
    this.clearTimer(tabId);
    // 1. Paused: keep it pending, unarmed; resume / a permission grant rearms it.
    if (this.deps.safety.isPaused() || this.rulePaused(e.ruleKey)) return;
    const [snap, p] = await Promise.all([this.port.snapshot(), this.getProgram()]);
    const tab = snap.tabs.find((t) => t.id === tabId);
    // Deleted (and stored) before anything else happens to the tab: it never fires twice.
    this.pending.delete(tabId);
    await this.save();
    // 2. Gone, navigated or no longer the winning close rule.
    if (!tab) return;
    const url = normOf(tab.url, p);
    if (url !== normOf(e.url, p)) return;
    const r = this.closeOf(snap, p, tab);
    if (r?.key !== e.ruleKey) return;
    // 4. Anchor or undo-exempt.
    if (this.deps.isAnchor?.(tabId) || this.exempted.get(tabId) === url) return;
    if (r.mode === 'suggest') { // the rule changed to suggest since it was scheduled
      this.suggest(p, tab, r.key, `Suggested by "${this.nameOf(p, r.key)}"`);
      await this.save();
      return;
    }
    // 5./6. In use: ask in a banner where it can be shown, else list it as a suggestion. Never close.
    const why = this.inUse(snap, tab, e);
    if (why) {
      if (await this.deps.banner(tabId, 'protected-close', r.key).catch(() => false)) {
        this.asking.set(tabId, { url, ruleKey: r.key });
        this.settled.set(tabId, { url, ruleKey: r.key });
        this.deps.log.add({ tabId, ruleId: r.key, action: 'close-held', detail: `Not closed (${why}): asked in a banner`, at: this.now() });
      } else {
        this.suggest(p, tab, r.key, `Not closed (${why}): suggested instead`);
        await this.save();
      }
      return;
    }
    await this.close(snap, p, tab, r.key, 'auto-close', `Closed by "${this.nameOf(p, r.key)}"`, true);
  }

  /** Why the tab must not be closed now, or undefined. */
  private inUse(snap: Snapshot, tab: TabSnap, e: PendingClose): string | undefined {
    const s = this.deps.safety;
    if (s.isProtected(tab)) return 'protected';
    if (s.isActiveFocused(tab, snap.windows)) return 'active';
    if (!(this.deps.observesForm?.(tab.url) ?? false) && (e.activated || tab.active)) return 'used since it loaded; form state unknown';
    return undefined;
  }

  private async close(
    snap: Snapshot, p: Program, tab: TabSnap, ruleKey: string, action: string, detail: string, toast: boolean,
  ): Promise<void> {
    const groupTitle = tab.groupId !== -1 ? snap.groups.find((g) => g.id === tab.groupId)?.title : undefined;
    const entry: RecentlyClosedInput = {
      url: tab.url, title: tab.title, windowId: tab.windowId, reason: this.nameOf(p, ruleKey), ruleId: ruleKey, at: this.now(),
      ...(groupTitle !== undefined && { groupTitle }),
    };
    const id = this.deps.recentlyClosed.add(entry);
    try {
      await this.port.closeTab(tab.id);
    } catch (err) {
      this.deps.recentlyClosed.take(id);
      throw err;
    }
    this.forget(tab.id);
    await this.save();
    this.deps.log.add({ tabId: tab.id, ruleId: ruleKey, action, detail, at: entry.at });
    if (!toast) return;
    // The undo toast goes to the tab now active in the closed tab's window (D39 / R29); the toast falls back itself.
    const after = await this.port.snapshot().catch(() => undefined);
    const target = after?.tabs.find((t) => t.windowId === tab.windowId && t.active);
    this.deps.safety.toast(id, entry, target).catch(() => {});
  }
}
