import type { Config, DedupeSettings, GroupRule, Snapshot, TabSnap } from '../core/types';
import { ruleTitleProblems, validateConfig } from '../core/config/schema';
import { groupRuleToRule, sanitizeRuleId, userKey } from '../core/config/migrate';
import { importAutoGroupTabs } from '../core/import/auto-group-tabs';
import { mergeDedupe } from '../core/import/merge';
import { importTabDeduper } from '../core/import/tab-deduper';
import { findDuplicateSets, tabUrl } from '../core/dedupe/find';
import type { RecentlyClosed, RecentlyClosedItem } from '../core/safety/recently-closed';
import type { WhyEntry, WhyLog } from '../core/safety/why-log';
import type { BrowserPort } from '../platform/browser-port';
import type { ConfigStore, Backup } from '../storage/config-store';
import { compileProgram, paramProblem } from '../core/lang/compile';
import type { Program, Recipe, RecipeRef, TabFacts } from '../core/lang/types';
import { emptyProgram, previewChange, type PreviewContext, type PreviewResult } from '../core/lang/preview';
import { explainTab, findShadowed, type ExplainEntry } from '../core/lang/explain';
import { effectiveNeeds, type Needs, type NeedStatus, type PermissionsManager } from './permissions';
import type { PendingAsk } from './ask';
import type { PageFacts, WatchSelector } from './page-facts';
import type { PauseDuration, SafetyService } from './safety';
import { dedupeDecision, openerOf } from './dedupe-handler';
import { readViews, type ViewData, type ViewsDeps, type ViewSummary } from './views';

/** Messages between the background worker and the dedupe banner content script. */
export type BannerShowMessage = {
  type: 'banner.show';
  payload:
    | { kind: 'duplicate'; existingTitle: string; groupTitle?: string; tabId: number; existingTabId: number }
    | { kind: 'undo'; entryId: string; text: string }
    | { kind: 'protected-close'; text: string };
};
export type BannerChoice = 'switch' | 'keep' | 'always-switch-site';
export type BannerChoiceMessage = { type: 'banner.choice'; choice: BannerChoice; tabId: number; existingTabId: number };
export type BannerMessage = BannerShowMessage | BannerChoiceMessage;

export function isBannerChoiceMessage(m: unknown): m is BannerChoiceMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.type === 'banner.choice' && typeof x.tabId === 'number' && typeof x.existingTabId === 'number'
    && (x.choice === 'switch' || x.choice === 'keep' || x.choice === 'always-switch-site');
}

/** Exact banner copy. */
export function bannerText(groupTitle: string | undefined): string {
  return `Already open in ${groupTitle || 'another tab'}.`;
}

/** The content script's reply to banner.show, sent after the banner is rendered. */
export type BannerAck = { ok: true };

/** Undo toast answer from the banner (no tabId: it refers to a recently-closed entry). */
export type UndoChoiceMessage = { type: 'banner.choice'; choice: 'undo'; entryId: string };
export function isUndoChoiceMessage(m: unknown): m is UndoChoiceMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.type === 'banner.choice' && x.choice === 'undo' && typeof x.entryId === 'string';
}

// ---- watch content script <-> worker (M2 T7, ruling R12: a content-script channel, never createHandler) ----

/** Watch -> worker on load, back/forward-cache restore and same-document navigation: asks for its config, re-reports formEdited (D34). */
export type WatchHelloMessage = { type: 'watch.hello'; formEdited: boolean };
/** The worker's answer to watch.hello: what to look for on this page (PageFacts.watchConfigFor). */
export type WatchConfigMessage = { type: 'watch.config'; needles: string[]; selectors: WatchSelector[] };
/** Watch -> worker when the facts change. `texts` holds only the matched needles, never the page text (privacy). */
export type PageFactsMessage = { type: 'page.facts'; texts: string[]; extracts: Record<string, string>; formEdited: boolean };

/** Bounds on what a page.facts message may carry (the watch never sends more; anything larger is not ours). */
export const MAX_FACT_ITEMS = 200;
export const MAX_FACT_TEXT = 500;
export const MAX_EXTRACT_VALUE = 256;

export function isWatchHello(m: unknown): m is WatchHelloMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.type === 'watch.hello' && typeof x.formEdited === 'boolean';
}

export function isPageFactsMessage(m: unknown): m is PageFactsMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  if (x.type !== 'page.facts' || typeof x.formEdited !== 'boolean' || !Array.isArray(x.texts)) return false;
  if (x.texts.length > MAX_FACT_ITEMS || !x.texts.every((t) => typeof t === 'string' && t.length <= MAX_FACT_TEXT)) return false;
  if (typeof x.extracts !== 'object' || x.extracts === null || Array.isArray(x.extracts)) return false;
  const vals = Object.entries(x.extracts as Record<string, unknown>);
  return vals.length <= MAX_FACT_ITEMS
    && vals.every(([k, v]) => k.length <= MAX_FACT_TEXT && typeof v === 'string' && v.length <= MAX_EXTRACT_VALUE);
}

/** Protected-close banner copy (D22): "Close this tab? [Close] [Keep]". Keep is the default: no answer keeps the tab. */
export const PROTECTED_CLOSE_TEXT = 'Close this tab?';

/**
 * Protected-close banner -> worker (D22, ruling R12): the answer for the sending tab. A content-script message on the
 * sender-checked createContentHandler channel; the existing banner.choice guards are untouched.
 */
export type CloseChoiceMessage = { type: 'banner.closeChoice'; choice: 'close' | 'keep' };
export function isCloseChoiceMessage(m: unknown): m is CloseChoiceMessage {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  return x.type === 'banner.closeChoice' && (x.choice === 'close' || x.choice === 'keep');
}

/** Undo toast copy. */
export function undoText(e: { title: string; url: string; reason: string }): string {
  return `Closed "${e.title || e.url}" (${e.reason}).`;
}

export const UNDO_NOTIFICATION_PREFIX = 'undo:';

// ---- UI <-> engine request API (popup / options / side panel -> background) ----

export type Request =
  | { type: 'config.get' }
  | { type: 'config.set'; config: unknown; baseRev?: string }
  | { type: 'config.backups' }
  | { type: 'config.restore'; at: number }
  | { type: 'config.status' }
  | { type: 'tabs.list' }
  | { type: 'dupes.list' }
  | { type: 'dupes.closeExtras'; key: string }
  | { type: 'dupes.closeAll' }
  | { type: 'dupes.resolve'; newTabId: number; existingTabId: number; choice: 'switch' | 'keep' }
  | { type: 'recent.list' }
  | { type: 'recent.undo'; id: string }
  | { type: 'why.forTab'; tabId: number }
  | { type: 'why.all' }
  | { type: 'safety.pause'; d: PauseDuration }
  | { type: 'safety.resume' }
  | { type: 'safety.status' }
  | { type: 'tab.lock'; tabId: number }
  | { type: 'tab.unlock'; tabId: number }
  | { type: 'tab.focus'; tabId: number }
  | { type: 'import.preview'; source: ImportSource; data: unknown }
  | { type: 'import.apply'; source: ImportSource; data: unknown; baseRev: string }
  | { type: 'recipes.list' }
  /**
   * R5 flow (Recipes page, T15): requestNeeds first in the click's user gesture, then preview.change, then on Apply
   * recipes.enable. `params`, when given, is stored with `enabled` in the same update; like setParams it REPLACES the
   * whole params object (omitted params fall back to their defaults), so the UI always sends the complete object.
   */
  | { type: 'recipes.enable'; id: string; params?: Record<string, unknown>; baseRev?: string }
  | { type: 'recipes.disable'; id: string; baseRev?: string }
  /** Replaces the recipe's whole params object (not a merge): send every param, not only the changed ones (T8). */
  | { type: 'recipes.setParams'; id: string; params: Record<string, unknown>; baseRev?: string }
  /**
   * What saving `config` would do to the open tabs (M2 T13): the UI sends it before config.set / recipes.enable and
   * shows PreviewDialog when it has effects. `only` (a rule key) tests that one rule alone against the open tabs
   * ("test against my open tabs"): enabled, live, against a Program with no rules.
   */
  | { type: 'preview.change'; config: unknown; only?: string }
  /** The conflict view (M2 T14): the rules relevant to one open tab, what each won and to whom it lost. Read-only. */
  | { type: 'explain.tab'; tabId: number }
  /** Rules that likely never win (M2 T14, heuristic): of the stored config, or of the draft `config` when given. */
  | { type: 'rules.shadowed'; config?: unknown }
  /** The popup's recipe views (M2 T17) with counts and paused status, in display order. Read-only. */
  | { type: 'views.list' }
  /** One view's rows (`list`) or duplicate sets and pending asks (`duplicates`). Read-only. */
  | { type: 'view.data'; viewId: string }
  /** Closes one row tab of a list view with a close / close-all action (user-initiated: also under dry run, R50). */
  | { type: 'view.close'; viewId: string; tabId: number }
  /** Dismisses a Finished suggestion: CloseExecutor.exempt, so the tab is not suggested again at that URL. */
  | { type: 'view.keep'; viewId: string; tabId: number };

/** explain.tab's answer: the tab and its relevant rules in priority order (src/core/lang/explain.ts). */
export interface ExplainView {
  tab: { id: number; title: string; url: string; groupTitle?: string };
  /** The tab has page facts (pageText / selector extracts); without them, rules that need them are "needs page facts". */
  hasPageFacts: boolean;
  rules: ExplainEntry[];
}
/** A shadowed rule (`key`), the earlier rule that catches its tabs (`shadowedBy`) and that rule's name (R19). */
export interface ShadowedRule { key: string; shadowedBy: string; name: string }

/**
 * One recipe as listed to the UI: its ref, header, effective needs (host needs add `scripting`) and their status.
 * `rules` has the same per rule key (`<recipeId>/<ruleId>`) for rules with their own needs (T10): an unmet one is
 * that rule's "Paused: needs access to <host>" (R45) while the recipe itself stays ok.
 */
export interface RecipeListItem {
  id: string; source: RecipeRef['source']; enabled: boolean; params: Record<string, unknown>;
  name: string; description: string; paramDefs: NonNullable<Recipe['params']>; needs: Needs; status: NeedStatus;
  rules: Record<string, { needs: Needs; status: NeedStatus }>;
}

export type ImportSource = 'auto-group-tabs' | 'tab-deduper';
export interface ImportPreview { rules: GroupRule[]; dedupe: Partial<DedupeSettings>; warnings: string[]; changes: string[] }
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; errors?: string[] };

/** Identifies a stored config's content (FNV-1a over its JSON); used for optimistic concurrency. */
export function configRev(c: Config): string {
  const j = JSON.stringify(c);
  let h = 0x811c9dc5;
  for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}-${j.length}`;
}

/** Broadcast to extension pages when the stored config changes. */
export type ConfigChangedMessage = { type: 'config.changed'; rev: string };
export function isConfigChangedMessage(m: unknown): m is ConfigChangedMessage {
  return typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'config.changed' && typeof (m as Record<string, unknown>).rev === 'string';
}

export interface DupeSet { key: string; tabs: TabSnap[] }
/** A dupe set as listed to the UI: `closable` = extras the close button would actually close. */
export interface DupeSetView extends DupeSet { closable: number }
export interface SafetyStatus { paused: boolean; locked: number[] }
export interface ConfigStatus { syncing: boolean; warning?: string }

export interface ResponseData {
  'config.get': { config: Config; rev: string };
  'config.set': null;
  'config.backups': Backup[];
  'config.restore': null;
  'config.status': ConfigStatus;
  'tabs.list': TabSnap[];
  'dupes.list': { sets: DupeSetView[]; pending: PendingAsk[] };
  'dupes.closeExtras': number;
  'dupes.closeAll': number;
  'dupes.resolve': null;
  'recent.list': RecentlyClosedItem[];
  'recent.undo': null;
  'why.forTab': WhyEntry[];
  'why.all': WhyEntry[];
  'safety.pause': null;
  'safety.resume': null;
  'safety.status': SafetyStatus;
  'tab.lock': null;
  'tab.unlock': null;
  'tab.focus': null;
  'import.preview': ImportPreview;
  'import.apply': { rules: number };
  'recipes.list': { recipes: RecipeListItem[]; rev: string };
  'recipes.enable': null;
  'recipes.disable': null;
  'recipes.setParams': null;
  'preview.change': PreviewResult;
  'explain.tab': ExplainView;
  'rules.shadowed': ShadowedRule[];
  'views.list': ViewSummary[];
  'view.data': ViewData;
  'view.close': null;
  'view.keep': null;
}
export type ResponseFor<R extends Request> = Response<ResponseData[R['type']]>;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const NO_ARGS = new Set(['config.get', 'config.backups', 'config.status', 'tabs.list', 'dupes.list', 'dupes.closeAll', 'recent.list', 'why.all',
  'safety.resume', 'safety.status', 'recipes.list', 'views.list']);
const optRev = (x: Record<string, unknown>) => x.baseRev === undefined || str(x.baseRev);
const isParams = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isImportSource = (v: unknown): v is ImportSource => v === 'auto-group-tabs' || v === 'tab-deduper';

async function runImport(source: ImportSource, data: unknown, current: Config): Promise<ImportPreview> {
  if ((JSON.stringify(data) ?? '').length > MAX_IMPORT_BYTES) throw new Error('Import data too large (max 5 MB)');
  const raw = source === 'auto-group-tabs' ? { dedupe: {}, ...(await importAutoGroupTabs(data)) } : { rules: [] as GroupRule[], ...importTabDeduper(data) };
  const skipped: string[] = [];
  const rules = raw.rules.filter((x) => {
    const problems = ruleTitleProblems(groupRuleToRule(x));
    if (problems.length) skipped.push(`Rule "${x.group.title}" skipped: ${problems.map((m) => `title ${m}`).join('; ')}.`);
    return problems.length === 0;
  });
  const r = { ...raw, rules };
  const titles = new Set(current.rules.flatMap((x) => x.actions.flatMap((a) => ('group' in a ? [a.group.title] : []))));
  const warnings = [...r.warnings, ...skipped, ...r.rules.filter((x) => titles.has(x.group.title)).map((x) => `Already have a rule titled "${x.group.title}"`)];
  return { ...r, warnings, changes: mergeDedupe(current.dedupe, r.dedupe).changes };
}

/** Structural check of an untrusted message. */
export function isRequest(m: unknown): m is Request {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  if (!str(x.type)) return false;
  if (NO_ARGS.has(x.type)) return true;
  switch (x.type) {
    case 'config.set': return typeof x.config === 'object' && x.config !== null && (x.baseRev === undefined || str(x.baseRev));
    case 'config.restore': return num(x.at);
    case 'dupes.closeExtras': return str(x.key);
    case 'dupes.resolve': return num(x.newTabId) && num(x.existingTabId) && (x.choice === 'switch' || x.choice === 'keep');
    case 'recent.undo': return str(x.id);
    case 'why.forTab': case 'tab.lock': case 'tab.unlock': case 'tab.focus': return num(x.tabId);
    case 'import.preview': return isImportSource(x.source);
    case 'import.apply': return isImportSource(x.source) && 'data' in x && str(x.baseRev);
    case 'safety.pause': return x.d === '15m' || x.d === '1h' || x.d === 'restart';
    case 'recipes.enable': return str(x.id) && (x.params === undefined || isParams(x.params)) && optRev(x);
    case 'recipes.disable': return str(x.id) && optRev(x);
    case 'recipes.setParams': return str(x.id) && isParams(x.params) && optRev(x);
    case 'preview.change': return typeof x.config === 'object' && x.config !== null && (x.only === undefined || str(x.only));
    case 'explain.tab': return num(x.tabId);
    case 'rules.shadowed': return x.config === undefined || (typeof x.config === 'object' && x.config !== null);
    case 'view.data': return str(x.viewId);
    case 'view.close': case 'view.keep': return str(x.viewId) && num(x.tabId);
    default: return false;
  }
}

export interface HandlerDeps {
  runtimeId: string;
  /** e.g. `chrome-extension://<id>` */
  extensionOrigin: string;
  store: Pick<ConfigStore, 'get' | 'set' | 'update' | 'backups' | 'restore' | 'status'>;
  port: BrowserPort;
  /** Effective dedupe settings: the compiled Program's `dedupe` (config + recipe urlTransforms, ruling R4). */
  getSettings: () => Promise<DedupeSettings>;
  /**
   * The Program the engine runs (ProgramCache.get). With it, duplicate sets (dupes.*, the badge, the Duplicates view)
   * honor per-rule dedupe overrides as the engine does (R25, M2 T17); without it only the global settings apply.
   */
  getProgram?: () => Promise<Program>;
  /** views.list / view.* (M2 T17). Without it they fail. The list and data are read-only. */
  views?: ViewsDeps;
  safety: Pick<SafetyService, 'pause' | 'resume' | 'isPaused' | 'lock' | 'unlock' | 'isLocked' | 'lockedTabIds' | 'undo'>;
  /** Anchor tabs (M2 T11) are never closed by dupes.close* (R11). Default: none. */
  isAnchor?: (tabId: number) => boolean;
  recentlyClosed: Pick<RecentlyClosed, 'list' | 'add' | 'ready'>;
  whyLog: Pick<WhyLog, 'all' | 'forTab' | 'add' | 'ready'>;
  ask: { listPending: () => Promise<PendingAsk[]>; resolvePending: (n: number, e: number, c: 'switch' | 'keep') => Promise<void> };
  /** recipes.* requests: built-in recipe bodies and the PermissionsManager. Without it they fail. */
  recipes?: { builtins: Record<string, Recipe>; permissions: Pick<PermissionsManager, 'check'> };
  /** preview.change (M2 T13). Without it the request fails. Read-only: nothing here may change engine state. */
  preview?: {
    builtins: Record<string, Recipe>;
    /** The Program the engine runs now (ProgramCache.get): the preview's "before". */
    getProgram: () => Promise<Program>;
    /** Reconciler.planContext: copies of the planner's leave-alone tabs, managed titles, group order and dismissed anchors. */
    planContext: (snap: Snapshot, p: Program) => Promise<PreviewContext>;
    /** Per-tab facts the snapshot lacks (page facts). Default: none. */
    facts?: (tabId: number) => Partial<TabFacts>;
    /** Needs that are not granted pause their recipe / rule in the draft, as ProgramCache does. Default: all granted. */
    permissions?: Pick<PermissionsManager, 'check'>;
  };
  /** explain.tab and rules.shadowed (M2 T14). Without it they fail. Read-only: nothing here may change engine state. */
  explain?: {
    builtins: Record<string, Recipe>;
    /** Per-tab facts the snapshot lacks (page facts). Default: none. */
    facts?: (tabId: number) => Partial<TabFacts>;
    /** Needs that are not granted pause their recipe / rule (R45): shown with the reason. Default: all granted. */
    permissions?: Pick<PermissionsManager, 'check'>;
  };
  now?: () => number;
}

export interface MessageSender { id?: string; url?: string; tab?: { id?: number; url?: string }; frameId?: number }

/** True for the extension's own pages (popup, options, side panel); false for content scripts and other extensions. */
export function isExtensionPage(sender: MessageSender, d: Pick<HandlerDeps, 'runtimeId' | 'extensionOrigin'>): boolean {
  if (sender.id !== d.runtimeId) return false;
  if (!sender.tab) return true;
  return typeof sender.url === 'string' && (sender.url === d.extensionOrigin || sender.url.startsWith(`${d.extensionOrigin}/`));
}

type BadgeDeps = Pick<HandlerDeps, 'port' | 'getSettings' | 'getProgram' | 'ask' | 'views' | 'now'> & {
  isLocked: (tabId: number) => boolean;
  /** The stored config: which views are shown (R58 / R60). */
  getConfig?: () => Promise<Config>;
};

/** Duplicate sets of the open tabs: each tab's winning dedupe override applied when the Program is known (R25). */
async function duplicateSets(deps: Pick<HandlerDeps, 'port' | 'getSettings' | 'getProgram' | 'now'>): Promise<DupeSet[]> {
  const snap = await deps.port.snapshot();
  if (!deps.getProgram) return findDuplicateSets(snap.tabs, await deps.getSettings());
  const p = await deps.getProgram();
  const at = (deps.now ?? Date.now)();
  // The same facts DedupeHandler decides a candidate with: the tab and its opener (dry-run rules fall through, R48).
  return findDuplicateSets(snap.tabs, p.dedupe, (t) => dedupeDecision(p, { tab: t, ...openerOf(snap, t) }, at).o);
}

/** Duplicate sets with their closable extras (pinned and `isLocked` tabs are never closed) and the pending asks. */
async function dupesDataOf(deps: BadgeDeps): Promise<{ sets: DupeSetView[]; pending: PendingAsk[] }> {
  const [sets, pending] = await Promise.all([duplicateSets(deps), deps.ask.listPending()]);
  return { sets: sets.map((s) => ({ ...s, closable: s.tabs.slice(1).filter((t) => !t.pinned && !deps.isLocked(t.id)).length })), pending };
}

/** Closable duplicate extras (tabs after the oldest, excluding pinned and locked) plus pending asks. */
export async function badgeCount(deps: BadgeDeps): Promise<number> {
  const { sets, pending } = await dupesDataOf(deps);
  return sets.reduce((n, s) => n + s.closable, 0) + pending.length;
}

/**
 * Toolbar badge (R20, R60): the sum of the counts of the views the popup shows, i.e. the popup header total. With the
 * built-in recipes that is M1 badgeCount (the Duplicates view, counted only while shown, R58) plus the Finished
 * suggestions (counted only while Finished is shown, R59). Each view counts a tab once. Without `views` (M1 wiring):
 * badgeCount alone.
 */
export async function refreshBadge(deps: BadgeDeps): Promise<void> {
  let n: number;
  if (!deps.views) n = await badgeCount(deps);
  else {
    const [snap, config] = await Promise.all([deps.port.snapshot(), deps.getConfig?.()]);
    const views = await readViews(deps.views, {
      snap, now: (deps.now ?? Date.now)(), dupes: () => dupesDataOf(deps), noStatus: true, ...(config && { config }),
    });
    n = views.reduce((sum, v) => sum + v.summary.count, 0);
  }
  await deps.port.setBadge(n > 0 ? String(n) : '');
}

/** Thrown inside a store update to abort it when the config changed since the UI read it. */
class Conflict extends Error {}

const fail = (error: string, errors?: string[]): Response => (errors ? { ok: false, error, errors } : { ok: false, error });
const ok = <T>(data: T): Response<T> => ({ ok: true, data });

/** Debounce with a max wait so continuous activity still fires. */
export function createDebounce(fn: () => void, waitMs: number, maxWaitMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  return () => {
    const t = Date.now();
    if (timer === undefined) first = t;
    else clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(); }, Math.max(0, Math.min(waitMs, first + maxWaitMs - t)));
  };
}

export interface OnMessageDeps {
  runtimeId: string;
  handleRequest: (req: unknown, sender: MessageSender) => Promise<Response>;
  /** Handles banner messages from content scripts; returns true when the message was one of them. */
  handleBanner: (msg: unknown, sender: MessageSender) => boolean;
  /** Content-script requests that need an answer (createContentHandler); undefined when the message is not one. */
  handleContent?: (msg: unknown, sender: MessageSender) => Promise<unknown> | undefined;
}

/**
 * runtime.onMessage listener: banner messages stay fire-and-forget, content-script requests (watch) are answered by
 * handleContent, everything else by handleRequest (extension pages only), all via sendResponse.
 */
export function createOnMessage(d: OnMessageDeps) {
  return (msg: unknown, sender: MessageSender, sendResponse: (r: unknown) => void): boolean | undefined => {
    if (sender.id !== d.runtimeId) return undefined;
    if (d.handleBanner(msg, sender)) return undefined;
    const content = d.handleContent?.(msg, sender);
    if (content) {
      content.then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    d.handleRequest(msg, sender).then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  };
}

export function createHandler(deps: HandlerDeps): (req: unknown, sender: MessageSender) => Promise<Response> {
  const now = deps.now ?? Date.now;
  /** Never closed from the popup: locked and anchor tabs (pinned are checked per tab). */
  const kept = (id: number): boolean => deps.safety.isLocked(id) || (deps.isAnchor?.(id) ?? false);

  /** Closes everything but the oldest tab; pinned, locked and anchor tabs are never closed. */
  async function closeSet(set: DupeSet): Promise<number> {
    let closed = 0;
    for (const t of set.tabs.slice(1)) {
      if (t.pinned || kept(t.id)) continue;
      const url = tabUrl(t);
      await deps.port.closeTab(t.id);
      deps.recentlyClosed.add({ url, title: t.title, windowId: t.windowId, reason: 'duplicate', at: now() });
      deps.whyLog.add({ tabId: t.id, action: 'dupes-close', detail: `Closed duplicate of tab ${set.tabs[0]!.id} from the popup`, at: now() });
      closed++;
    }
    return closed;
  }

  function sets(): Promise<DupeSet[]> {
    return duplicateSets(deps);
  }

  /** Badge deps for refreshes after an action: kept = locked or anchor, and the stored config (R60). */
  const badgeDeps: BadgeDeps = { ...deps, isLocked: kept, getConfig: () => deps.store.get() };

  function dupesData(): Promise<{ sets: DupeSetView[]; pending: PendingAsk[] }> {
    return dupesDataOf(badgeDeps);
  }

  /** views.list / view.* : the listed views (or only `only`), computed from the snapshot, Program and stored config. */
  async function listViews(d: ViewsDeps, only?: string) {
    const [snap, config] = await Promise.all([deps.port.snapshot(), deps.store.get()]);
    return { snap, views: await readViews(d, { snap, config, now: now(), dupes: dupesData, ...(only !== undefined && { only }) }) };
  }

  /** view.close / view.keep: user-initiated (R50: they apply under global dry run too), only on a row of that view. */
  async function runViewAction(req: Extract<Request, { type: 'view.close' | 'view.keep' }>, d: ViewsDeps): Promise<Response> {
    const { snap, views } = await listViews(d, req.viewId);
    const v = views[0];
    if (!v) return fail('unknown view');
    const allowed = req.type === 'view.keep' ? v.summary.actions.includes('keep') : v.summary.actions.some((a) => a === 'close' || a === 'close-all');
    if (!allowed) return fail('action not allowed');
    const row = v.data.kind === 'list' ? v.data.rows.find((r) => r.tabId === req.tabId) : undefined;
    const tab = snap.tabs.find((t) => t.id === req.tabId);
    if (!row || !tab) return fail('not in view');
    if (req.type === 'view.keep') {
      if (!row.suggested || !d.closes) return fail('not in view');
      await d.closes.exempt(tab.id, row.url);
    } else {
      if (tab.pinned) return fail('tab is pinned');
      if (kept(tab.id)) return fail('tab is locked');
      const at = now();
      const groupTitle = tab.groupId !== -1 ? snap.groups.find((g) => g.id === tab.groupId)?.title : undefined;
      await deps.port.closeTab(tab.id);
      deps.recentlyClosed.add({
        url: row.url, title: tab.title, windowId: tab.windowId, reason: row.reason ?? v.view.tab, at,
        ...(row.ruleKey !== undefined && { ruleId: row.ruleKey }), ...(groupTitle !== undefined && { groupTitle }),
      });
      deps.whyLog.add({
        tabId: tab.id, action: 'view-close', detail: `Closed from the popup's ${v.view.tab} view`, at,
        ...(row.ruleKey !== undefined && { ruleId: row.ruleKey }),
      });
    }
    await refreshBadge(badgeDeps);
    return ok(null);
  }

  /** The recipe `id` compiled as if enabled with `over` applied: its needs, its rules' own needs and its compile errors. */
  function compileRecipe(cfg: Config, id: string, builtins: Record<string, Recipe>, over: Partial<RecipeRef> = {}) {
    const recipes = cfg.recipes.map((r) => (r.id === id ? { ...r, enabled: true, ...over } : r));
    const { program, errors } = compileProgram({ ...cfg, recipes }, builtins);
    const own = errors.filter((e) => e.key === id || e.key.startsWith(`${id}/`)).map((e) => `${e.key}: ${e.error}`);
    const rules = Object.entries(program.needs).filter(([k]) => k.startsWith(`${id}/`));
    return { needs: program.needs[id] ?? { origins: [], permissions: [] }, rules, errors: own };
  }

  /** Changes one recipe ref in a single store update (conflict when `baseRev` is stale or the ref is gone). */
  async function updateRecipe(id: string, baseRev: string | undefined, fn: (r: RecipeRef) => RecipeRef): Promise<Response> {
    try {
      await deps.store.update((cur) => {
        if (baseRev !== undefined && configRev(cur) !== baseRev) throw new Conflict();
        if (!cur.recipes.some((r) => r.id === id)) throw new Conflict();
        return { ...cur, recipes: cur.recipes.map((r) => (r.id === id ? fn(r) : r)) };
      });
    } catch (e) {
      if (e instanceof Conflict) return fail('conflict');
      throw e;
    }
    return ok(null);
  }

  async function runRecipes(req: Extract<Request, { type: `recipes.${string}` }>, d: NonNullable<HandlerDeps['recipes']>): Promise<Response> {
    const cfg = await deps.store.get();
    const bodyOf = (r: RecipeRef): Recipe | undefined => (r.source === 'builtin' ? (Object.hasOwn(d.builtins, r.id) ? d.builtins[r.id] : undefined) : r.body);
    if (req.type === 'recipes.list') {
      const recipes: RecipeListItem[] = [];
      for (const r of cfg.recipes) {
        const body = bodyOf(r);
        const { needs, rules } = compileRecipe(cfg, r.id, d.builtins);
        const ruleItems: RecipeListItem['rules'] = {};
        for (const [k, n] of rules) ruleItems[k] = { needs: effectiveNeeds(n), status: await d.permissions.check(n) };
        recipes.push({
          id: r.id, source: r.source, enabled: r.enabled, params: r.params, name: body?.name ?? r.id, description: body?.description ?? '',
          paramDefs: body?.params ?? {}, needs: effectiveNeeds(needs), status: await d.permissions.check(needs), rules: ruleItems,
        });
      }
      return ok({ recipes, rev: configRev(cfg) });
    }
    const ref = cfg.recipes.find((r) => r.id === req.id);
    if (!ref) return fail('unknown recipe');
    /** Each given param against its ParamDef (unknown names too); values that fail only where they land are compile errors. */
    const paramErrors = (r: RecipeRef, params: Record<string, unknown>): string[] => {
      const defs = bodyOf(r)?.params ?? {};
      const errors: string[] = [];
      for (const [name, v] of Object.entries(params)) {
        const def = Object.hasOwn(defs, name) ? defs[name] : undefined;
        const m = def ? paramProblem(def, v) : undefined;
        if (!def) errors.push(`unknown param: ${name}`);
        else if (m) errors.push(`param ${name}: ${m}`);
      }
      return errors;
    };
    switch (req.type) {
      case 'recipes.enable': {
        if (req.params !== undefined) {
          const errors = paramErrors(ref, req.params);
          if (errors.length) return fail('invalid params', errors);
        }
        const over = req.params !== undefined ? { params: req.params } : {};
        const { needs, errors } = compileRecipe(cfg, req.id, d.builtins, over);
        if (errors.length) return fail(req.params !== undefined ? 'invalid params' : 'invalid recipe', errors);
        // R5: only recipe-level needs gate the enable; an unmet rule-level need pauses that rule after enabling.
        if (!(await d.permissions.check(needs)).ok) return fail('missing permissions');
        return updateRecipe(req.id, req.baseRev, (r) => ({ ...r, enabled: true, ...(req.params !== undefined && { params: { ...req.params } }) }));
      }
      case 'recipes.disable': return updateRecipe(req.id, req.baseRev, (r) => ({ ...r, enabled: false }));
      case 'recipes.setParams': {
        const errors = paramErrors(ref, req.params);
        if (errors.length) return fail('invalid params', errors);
        // Values valid alone may still fail where they land (e.g. braces in a template, R37).
        const compiled = compileRecipe(cfg, req.id, d.builtins, { params: req.params });
        if (compiled.errors.length) return fail('invalid params', compiled.errors);
        return updateRecipe(req.id, req.baseRev, (r) => ({ ...r, params: { ...req.params } }));
      }
    }
  }

  /**
   * `cfg` compiled as the engine would run it: needs that are not granted pause their recipe / rule (ProgramCache's
   * paused set; for a recipe being enabled, requestNeeds has already run in the click).
   */
  async function compileDraft(cfg: Config, d: NonNullable<HandlerDeps['preview']>): Promise<Program> {
    const first = compileProgram(cfg, d.builtins).program;
    const paused = new Set<string>();
    if (d.permissions) for (const [k, n] of Object.entries(first.needs)) if (!(await d.permissions.check(n)).ok) paused.add(k);
    return paused.size ? compileProgram(cfg, d.builtins, { paused }).program : first;
  }

  async function runPreview(req: Extract<Request, { type: 'preview.change' }>, d: NonNullable<HandlerDeps['preview']>): Promise<Response> {
    const v = validateConfig(req.config);
    if (!v.ok) return fail('invalid config', v.errors);
    const [snap, current] = await Promise.all([deps.port.snapshot(), d.getProgram()]);
    const ctx = await d.planContext(snap, current);
    const facts = d.facts ?? (() => ({}));
    if (req.only === undefined) return ok(previewChange(snap, current, await compileDraft(v.config, d), facts, ctx, now()));
    // Test one rule: enabled and live (R30 labels belong to Save previews), alone against no rules. No managed titles:
    // only the rule's own groups count as managed, so other rules' groups are not torn down in "before".
    const only = req.only;
    const cfg: Config = { ...v.config, dryRun: false, rules: v.config.rules.map((r) => (userKey(r.id) === only ? { ...r, enabled: true, dryRun: false } : r)) };
    const p = await compileDraft(cfg, d);
    const rules = p.rules.filter((r) => r.key === only).map((r) => ({ ...r, dryRun: false }));
    if (rules.length === 0) return fail('unknown rule');
    const after: Program = { ...p, rules };
    return ok(previewChange(snap, emptyProgram(after), after, facts, { ...ctx, managedTitles: new Set() }, now()));
  }

  /**
   * explain.tab: the stored config compiled with no paused set (paused rules stay listed, with their reason, R45) and
   * dry-run rules included (R48); explainTab decides who won. Reads the snapshot and the config only.
   */
  async function runExplain(tabId: number, d: NonNullable<HandlerDeps['explain']>): Promise<Response> {
    const snap = await deps.port.snapshot();
    const tab = snap.tabs.find((t) => t.id === tabId);
    if (!tab) return fail('tab not found');
    const p = compileProgram(await deps.store.get(), d.builtins).program;
    const paused: Record<string, string> = {};
    if (d.permissions) {
      for (const [k, n] of Object.entries(p.needs)) {
        const st = await d.permissions.check(n);
        if (!st.ok) paused[k] = st.reason ?? 'Paused';
      }
    }
    const opener = tab.openerTabId !== undefined ? snap.tabs.find((t) => t.id === tab.openerTabId) : undefined;
    const groupTitle = tab.groupId !== -1 ? snap.groups.find((g) => g.id === tab.groupId)?.title : undefined;
    const extra = d.facts?.(tabId) ?? {};
    const facts: TabFacts = { ...extra, tab, ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }) };
    const view: ExplainView = {
      tab: { id: tab.id, title: tab.title, url: tab.pendingUrl || tab.url, ...(groupTitle !== undefined && { groupTitle }) },
      hasPageFacts: facts.page !== undefined,
      rules: explainTab(p, facts, now(), paused),
    };
    return ok(view);
  }

  async function runShadowed(config: unknown, d: NonNullable<HandlerDeps['explain']>): Promise<Response> {
    let cfg: Config;
    if (config === undefined) cfg = await deps.store.get();
    else {
      const v = validateConfig(config);
      if (!v.ok) return fail('invalid config', v.errors);
      cfg = v.config;
    }
    const p = compileProgram(cfg, d.builtins).program;
    const names = new Map(p.rules.map((r) => [r.key, r.rule.name]));
    return ok(findShadowed(p).map((x): ShadowedRule => ({ ...x, name: names.get(x.shadowedBy) ?? x.shadowedBy })));
  }

  async function run(req: Request): Promise<Response> {
    switch (req.type) {
      case 'explain.tab': return deps.explain ? runExplain(req.tabId, deps.explain) : fail('explain unavailable');
      case 'rules.shadowed': return deps.explain ? runShadowed(req.config, deps.explain) : fail('explain unavailable');
      case 'preview.change': return deps.preview ? runPreview(req, deps.preview) : fail('preview unavailable');
      case 'recipes.list': case 'recipes.enable': case 'recipes.disable': case 'recipes.setParams':
        return deps.recipes ? runRecipes(req, deps.recipes) : fail('recipes unavailable');
      case 'config.get': { const config = await deps.store.get(); return ok({ config, rev: configRev(config) }); }
      case 'config.set': {
        const r = validateConfig(req.config);
        if (!r.ok) return fail('invalid config', r.errors);
        const { baseRev } = req;
        if (baseRev === undefined) {
          await deps.store.set(r.config);
          return ok(null);
        }
        // Check and write in one store update: nothing can land between them.
        try {
          await deps.store.update((cur) => {
            if (configRev(cur) !== baseRev) throw new Conflict();
            return r.config;
          });
        } catch (e) {
          if (e instanceof Conflict) return fail('conflict');
          throw e;
        }
        return ok(null);
      }
      case 'import.preview': return ok(await runImport(req.source, req.data, await deps.store.get()));
      case 'import.apply': {
        const current = await deps.store.get();
        const imp = await runImport(req.source, req.data, current);
        if (imp.rules.length === 0 && Object.keys(imp.dedupe).length === 0) return fail('nothing to import', imp.warnings);
        if (req.baseRev !== configRev(current)) return fail('conflict');
        let added = 0;
        let invalid: string[] | undefined;
        try {
          await deps.store.update((cur) => {
            if (configRev(cur) !== req.baseRev) throw new Conflict();
            // Imported ids are mapped to the v2 id pattern, unique among the user rules; keys append to order.
            const ids = new Set(cur.rules.map((r) => r.id));
            const rules = imp.rules.map((r) => groupRuleToRule(r, sanitizeRuleId(r.id, ids)));
            const next: Config = {
              ...cur, rules: [...cur.rules, ...rules], order: [...new Set([...cur.order, ...rules.map((r) => userKey(r.id))])],
              dedupe: mergeDedupe(cur.dedupe, imp.dedupe).merged,
            };
            const v = validateConfig(next);
            if (!v.ok) { invalid = v.errors; throw new Conflict(); }
            added = rules.length;
            return next;
          });
        } catch (e) {
          if (!(e instanceof Conflict)) throw e;
          return invalid ? fail('invalid config', invalid) : fail('conflict');
        }
        return ok({ rules: added });
      }
      case 'config.backups': return ok(await deps.store.backups());
      case 'config.restore': await deps.store.restore(req.at); return ok(null);
      case 'config.status': return ok(await deps.store.status());
      case 'tabs.list': return ok((await deps.port.snapshot()).tabs);
      case 'dupes.list': return ok(await dupesData());
      case 'views.list': return deps.views ? ok((await listViews(deps.views)).views.map((v) => v.summary)) : fail('views unavailable');
      case 'view.data': {
        if (!deps.views) return fail('views unavailable');
        const v = (await listViews(deps.views, req.viewId)).views[0];
        return v ? ok(v.data) : fail('unknown view');
      }
      case 'view.close': case 'view.keep': return deps.views ? runViewAction(req, deps.views) : fail('views unavailable');
      case 'dupes.closeExtras': {
        const set = (await sets()).find((s) => s.key === req.key);
        const n = set ? await closeSet(set) : 0;
        await refreshBadge(badgeDeps);
        return ok(n);
      }
      case 'dupes.closeAll': {
        let n = 0;
        for (const s of await sets()) n += await closeSet(s);
        await refreshBadge(badgeDeps);
        return ok(n);
      }
      case 'dupes.resolve':
        await deps.ask.resolvePending(req.newTabId, req.existingTabId, req.choice);
        await refreshBadge(badgeDeps);
        return ok(null);
      case 'recent.list': await deps.recentlyClosed.ready; return ok(deps.recentlyClosed.list());
      case 'recent.undo': await deps.safety.undo(req.id); return ok(null);
      case 'why.forTab': await deps.whyLog.ready; return ok(deps.whyLog.forTab(req.tabId));
      case 'why.all': await deps.whyLog.ready; return ok(deps.whyLog.all());
      case 'safety.pause': deps.safety.pause(req.d); return ok(null);
      case 'safety.resume': deps.safety.resume(); return ok(null);
      case 'safety.status': return ok({ paused: deps.safety.isPaused(), locked: deps.safety.lockedTabIds() });
      case 'tab.lock': deps.safety.lock(req.tabId); return ok(null);
      case 'tab.unlock': deps.safety.unlock(req.tabId); return ok(null);
      case 'tab.focus': {
        const t = (await deps.port.snapshot()).tabs.find((x) => x.id === req.tabId);
        if (!t) return fail('tab not found');
        await deps.port.focusTab(t.id, t.windowId);
        return ok(null);
      }
    }
  }

  return async (req, sender) => {
    if (!isExtensionPage(sender, deps)) return fail('forbidden');
    if (!isRequest(req)) return fail('unknown request');
    try {
      return await run(req);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

export interface ContentDeps {
  runtimeId: string;
  /** e.g. `chrome-extension://<id>` */
  extensionOrigin: string;
  getProgram: () => Promise<Program>;
  pageFacts: Pick<PageFacts, 'set' | 'onCommitted' | 'watchConfigFor'>;
  safety: Pick<SafetyService, 'markFormEdited' | 'clearFormEdited'>;
  /** Reconciler.schedule. */
  schedule: (reason: string) => void;
  /** New facts for a tab (CloseExecutor.onFacts, M2 T9). */
  onFacts?: (tabId: number) => void;
  /** The protected-close banner's answer for the sending tab (CloseExecutor.onCloseChoice, D22). */
  onCloseChoice?: (tabId: number, choice: CloseChoiceMessage['choice']) => void;
}

/** A content script in a real tab's top frame: never an extension page (those use createHandler). */
export function isTabContentScript(sender: MessageSender, d: Pick<ContentDeps, 'runtimeId' | 'extensionOrigin'>): boolean {
  if (sender.id !== d.runtimeId || typeof sender.tab?.id !== 'number') return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  return !isExtensionPage(sender, d);
}

/**
 * The worker side of the watch content script (ruling R12): `watch.hello` is answered with the pulled watch config,
 * `page.facts` stores the facts and re-plans. Also the protected-close banner's `banner.closeChoice` (D22). Returns
 * undefined for any other message.
 */
export function createContentHandler(d: ContentDeps): (msg: unknown, sender: MessageSender) => Promise<unknown> | undefined {
  const forbidden = { ok: false, error: 'forbidden' };
  return (msg, sender) => {
    if (isCloseChoiceMessage(msg)) {
      if (!isTabContentScript(sender, d)) return Promise.resolve(forbidden);
      d.onCloseChoice?.(sender.tab!.id!, msg.choice);
      return Promise.resolve({ ok: true });
    }
    const hello = isWatchHello(msg);
    if (!hello && !isPageFactsMessage(msg)) return undefined;
    if (!isTabContentScript(sender, d)) return Promise.resolve(forbidden);
    const tabId = sender.tab!.id!;
    if (hello) {
      const m = msg as WatchHelloMessage;
      // A hello starts a new page state (load, back/forward-cache restore, same-document navigation, which fires no
      // onCommitted): drop the facts of the previous one and hold until the fresh report that follows the answer.
      d.pageFacts.onCommitted(tabId);
      // The frame's URL at send time: after pushState the tab's URL may not have caught up yet.
      const url = sender.url ?? sender.tab?.url ?? '';
      if (m.formEdited) d.safety.markFormEdited(tabId, sender.tab?.url);
      return d.getProgram().then((p): WatchConfigMessage => ({ type: 'watch.config', ...d.pageFacts.watchConfigFor(url, p) }));
    }
    const m = msg as PageFactsMessage;
    d.pageFacts.set(tabId, { texts: [...m.texts], extracts: { ...m.extracts }, formEdited: m.formEdited });
    if (m.formEdited) d.safety.markFormEdited(tabId, sender.tab?.url);
    else d.safety.clearFormEdited(tabId);
    d.schedule('pageFacts');
    d.onFacts?.(tabId);
    return Promise.resolve({ ok: true });
  };
}
