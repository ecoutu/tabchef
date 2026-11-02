import type { Config, DedupeSettings, GroupRule, Snapshot, TabSnap } from '../core/types';
import { neverCloseReason } from '../core/safety/never-close';
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
import { applyCollapse, suggestCollapse, type CollapseSuggestion } from '../core/lang/collapse';
import type { Program, Recipe, RecipeRef, Rule, TabFacts } from '../core/lang/types';
import { emptyProgram, previewChange, type PreviewContext, type PreviewResult } from '../core/lang/preview';
import type { PlanContext } from '../core/group/plan';
import { explainTab, findShadowed, type ExplainEntry } from '../core/lang/explain';
import { effectiveNeeds, type LevelStatus, type Needs, type NeedStatus, type PermissionsManager } from './permissions';
import type { PendingAsk } from './ask';
import type { EarlyReport, PageFacts, WatchSelector } from './page-facts';
import type { PauseDuration, SafetyService } from './safety';
import type { ProjectService } from './projects';
import type { SourceService } from './sources';
import type { ProjectCardData } from '../core/projects/types';
import { dedupeDecision, openerOf } from './dedupe-handler';
import { readViews, samePage, type ViewData, type ViewsDeps, type ViewSummary } from './views';
import { builtinConnectionDefs } from '../core/connections/builtin';
import { redact } from '../core/connections/redact';
import type { ConnectionDef, ConnectionStatus } from '../core/connections/types';
// Types only: the banner content script imports this module and must never bundle engine/connections (secrets).
import type { ConnectionManager } from './connections/manager';
import type { DevicePollResult, GitHubDeviceAuth } from './connections/github-auth';
import type { SetTokenResult } from './connections/token-auth';

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

/**
 * A page.facts message as the worker stores it (I2): undefined unless it is one with a boolean formEdited; otherwise
 * `texts` or `extracts` that break the bounds (or are malformed) are dropped as a whole, and formEdited is kept, so
 * one oversized field never loses the form-edit safety fact.
 */
export function pageFactsOf(m: unknown): PageFactsMessage | undefined {
  if (typeof m !== 'object' || m === null) return undefined;
  const x = m as Record<string, unknown>;
  if (x.type !== 'page.facts' || typeof x.formEdited !== 'boolean') return undefined;
  const texts = isPageFactsMessage({ ...x, extracts: {} }) ? (x.texts as string[]) : [];
  const extracts = isPageFactsMessage({ ...x, texts: [] }) ? (x.extracts as Record<string, string>) : {};
  return { type: 'page.facts', texts, extracts, formEdited: x.formEdited };
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
  /** `collapse`: as import.apply's; the preview's `config` is then the config import.apply would store with it (M1/R68). */
  | { type: 'import.preview'; source: ImportSource; data: unknown; collapse?: number[] }
  /** `collapse`: indices into the preview's `collapse` suggestions to apply (re-derived here from the same input). */
  | { type: 'import.apply'; source: ImportSource; data: unknown; baseRev: string; collapse?: number[] }
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
  /**
   * Closes one row tab of a list view with a close / close-all action (user-initiated: also under dry run, R50).
   * `url`: the row's URL as the popup showed it; refused when the tab has since navigated (R61).
   */
  | { type: 'view.close'; viewId: string; tabId: number; url?: string }
  /**
   * close-all (M3 T13, M3-R76): closes each listed row tab as above; a tab that is never closed (pinned, locked,
   * anchor) or has unsaved form edits (M3-R78), gone, navigated or no longer in the view is skipped and counted.
   * Answers `{closed, skipped}`.
   */
  | { type: 'view.close'; viewId: string; tabs: { tabId: number; url?: string }[] }
  /** Dismisses a Finished suggestion: CloseExecutor.exempt, so the tab is not suggested again at that URL. `url` as above. */
  | { type: 'view.keep'; viewId: string; tabId: number; url?: string }
  // ---- Connections page (M3 T7). No response ever carries a token or the device_code. ----
  /** Every connection (GitHub's built-in def until it is saved) and its status: metadata only. */
  | { type: 'connections.list' }
  /** Starts GitHub's device flow. The page requests def.hosts in the click handler first, then polls on `interval`. */
  | { type: 'connections.github.start' }
  /** One poll of the pending device flow (the open Connections page drives polling). */
  | { type: 'connections.github.poll' }
  /** Validates and stores a personal access token. `jira` (site, email, token kind, expiry) lands with Task 6. */
  | { type: 'connections.setToken'; id: 'github' | 'jira'; token: string }
  /** A test call through the ConnectionManager (GitHub: GET /user). */
  | { type: 'connections.test'; id: string }
  /** Clears the secrets and runtime status; the def stays, not-configured. */
  | { type: 'connections.disconnect'; id: string }
  // ---- Projects (M3 T15) ----
  /** ProjectCardData[] of the open projects. */
  | { type: 'projects.list' }
  | { type: 'projects.addTab'; tabId: number; projectId: string }
  | { type: 'projects.removeTab'; tabId: number }
  /** `url` must be one of the project's linked PRs; answers `{ tabId }`. */
  | { type: 'projects.openLinked'; projectId: string; url: string }
  /** Answers `{ closed, skipped, ids }`: `ids` are the recently-closed entries (the popup's Undo). */
  | { type: 'projects.closeGroup'; projectId: string }
  // ---- Sources (M3 T17) ----
  /** The Projects tab opened: SourceService.refresh('popup') (throttled, M3-R83); answers once it is done. */
  | { type: 'sources.refresh' };

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
  /** M3 T12: the recipe's declared capability levels (compiled as if enabled), when it declares any. */
  levels?: LevelStatus[];
}

export type ImportSource = 'auto-group-tabs' | 'tab-deduper';
export interface ImportPreview {
  rules: GroupRule[]; dedupe: Partial<DedupeSettings>; warnings: string[]; changes: string[];
  /** M2 T19: optional "replace N similar rules with 1 templated rule" suggestions; import.apply applies chosen ones. */
  collapse: CollapseSuggestion[];
  /** The config import.apply would store now (with the request's `collapse`): the UI previews it first (M1/R68). */
  config: Config;
}
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string; errors?: string[] };

/** Identifies a stored config's content (FNV-1a over its JSON); used for optimistic concurrency. */
export function configRev(c: Config): string {
  const j = JSON.stringify(c);
  let h = 0x811c9dc5;
  for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}-${j.length}`;
}

/** Broadcast to extension pages when a connection's status changes (ConnectionManager.onStatusChange). Id only. */
export type ConnectionsChangedMessage = { type: 'connections.changed'; id: string };
export function isConnectionsChangedMessage(m: unknown): m is ConnectionsChangedMessage {
  return typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'connections.changed' && typeof (m as Record<string, unknown>).id === 'string';
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
  /** null for one tab; `{closed, skipped}` for `tabs` (close-all). */
  'view.close': null | { closed: number; skipped: number };
  'view.keep': null;
  'connections.list': { defs: ConnectionDef[]; status: ConnectionStatus[] };
  'connections.github.start': { userCode: string; verificationUri: string; expiresAt: number; interval: number };
  'connections.github.poll': DevicePollResult;
  'connections.setToken': ConnectionStatus;
  'connections.test': { login?: string };
  'connections.disconnect': null;
  'projects.list': ProjectCardData[];
  'projects.addTab': null;
  'projects.removeTab': null;
  'projects.openLinked': { tabId: number };
  'projects.closeGroup': { closed: number; skipped: number; ids: string[] };
  'sources.refresh': null;
}
export type ResponseFor<R extends Request> = Response<ResponseData[R['type']]>;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const NO_ARGS = new Set(['config.get', 'config.backups', 'config.status', 'tabs.list', 'dupes.list', 'dupes.closeAll', 'recent.list', 'why.all',
  'safety.resume', 'safety.status', 'recipes.list', 'views.list', 'connections.list', 'connections.github.start', 'connections.github.poll',
  'projects.list', 'sources.refresh']);
const optRev = (x: Record<string, unknown>) => x.baseRev === undefined || str(x.baseRev);
const isParams = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The connection ids requests may name: the built-ins (custom connections come later). */
const CONNECTION_IDS = new Set<unknown>(['github', 'jira']);
const isImportSource = (v: unknown): v is ImportSource => v === 'auto-group-tabs' || v === 'tab-deduper';
const isCollapse = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((i) => Number.isInteger(i) && (i as number) >= 0));

/**
 * Imported rules as v2 rules, with ids mapped to the v2 pattern and unique among `current`'s rules (as import.apply
 * stores them), and the collapse suggestions on them (D27). Deterministic in its input, so import.apply re-derives
 * exactly the suggestions the preview showed for the same baseRev; a client-sent rule is never used.
 */
function importedRules(rules: GroupRule[], current: Config, builtins: Record<string, Recipe> | undefined): { rules: Rule[]; collapse: CollapseSuggestion[] } {
  const ids = new Set(current.rules.map((r) => r.id));
  const out = rules.map((r) => groupRuleToRule(r, sanitizeRuleId(r.id, ids)));
  const tableNames = (t: unknown) => (typeof t === 'object' && t !== null ? Object.keys(t) : []);
  const tables = [
    ...tableNames(current.tables),
    ...(Array.isArray(current.recipes) ? current.recipes : []).flatMap((ref) => tableNames(ref?.body?.tables)),
    ...Object.values(builtins ?? {}).flatMap((b) => tableNames(b?.tables)),
  ];
  return { rules: out, collapse: suggestCollapse(out, { ids, tables }) };
}

type ImportBase = Omit<ImportPreview, 'config'>;

/**
 * The config import.apply stores for `imp` on top of `cur` with the chosen collapse suggestions (re-derived here, never
 * client-sent), with its validation errors; `unknownCollapse` when an index names no suggestion. Shared by
 * import.preview (whose `config` the UI previews) and import.apply, so both describe the same change.
 */
function importNext(imp: ImportBase, cur: Config, collapse: number[] | undefined, builtins: Record<string, Recipe> | undefined):
  { next: Config; added: number; invalid?: string[] } | { unknownCollapse: true } {
  // Imported ids are mapped to the v2 id pattern, unique among the user rules; keys append to order.
  // Chosen collapse suggestions (T19) are re-derived from the same input and replace their runs in place.
  const derived = importedRules(imp.rules, cur, builtins);
  const chosen = [...new Set(collapse ?? [])].sort((a, b) => a - b).map((i) => derived.collapse[i]);
  if (chosen.some((c) => c === undefined)) return { unknownCollapse: true };
  const { rules, tables } = applyCollapse(derived.rules, cur.tables ?? {}, chosen as CollapseSuggestion[]);
  const next: Config = {
    ...cur, rules: [...cur.rules, ...rules], order: [...new Set([...cur.order, ...rules.map((r) => userKey(r.id))])],
    ...(chosen.length > 0 && { tables }),
    dedupe: mergeDedupe(cur.dedupe, imp.dedupe).merged,
  };
  const v = validateConfig(next);
  return { next, added: rules.length, ...(!v.ok && { invalid: v.errors }) };
}

async function runImport(source: ImportSource, data: unknown, current: Config, builtins?: Record<string, Recipe>): Promise<ImportBase> {
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
  return { ...r, warnings, changes: mergeDedupe(current.dedupe, r.dedupe).changes, collapse: importedRules(r.rules, current, builtins).collapse };
}

/** The recently-closed reason of a close from a recipe view (`<recipeId>/<viewId>`); default: the view's tab name. */
const VIEW_CLOSE_REASONS: Record<string, string> = { 'merged-prs/merged': 'merged-pr' };

const isViewTab = (t: unknown): boolean => typeof t === 'object' && t !== null && num((t as Record<string, unknown>).tabId)
  && ((t as Record<string, unknown>).url === undefined || str((t as Record<string, unknown>).url));

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
    case 'import.preview': return isImportSource(x.source) && isCollapse(x.collapse);
    case 'import.apply': return isImportSource(x.source) && 'data' in x && str(x.baseRev) && isCollapse(x.collapse);
    case 'safety.pause': return x.d === '15m' || x.d === '1h' || x.d === 'restart';
    case 'recipes.enable': return str(x.id) && (x.params === undefined || isParams(x.params)) && optRev(x);
    case 'recipes.disable': return str(x.id) && optRev(x);
    case 'recipes.setParams': return str(x.id) && isParams(x.params) && optRev(x);
    case 'preview.change': return typeof x.config === 'object' && x.config !== null && (x.only === undefined || str(x.only));
    case 'explain.tab': return num(x.tabId);
    case 'rules.shadowed': return x.config === undefined || (typeof x.config === 'object' && x.config !== null);
    case 'view.data': return str(x.viewId);
    case 'view.close': return str(x.viewId) && (Array.isArray(x.tabs) ? x.tabs.length > 0 && x.tabs.every(isViewTab) : isViewTab(x));
    case 'view.keep': return str(x.viewId) && isViewTab(x);
    case 'connections.setToken': return (x.id === 'github' || x.id === 'jira') && str(x.token);
    case 'connections.test': case 'connections.disconnect': return CONNECTION_IDS.has(x.id as string);
    case 'projects.addTab': return num(x.tabId) && str(x.projectId);
    case 'projects.removeTab': return num(x.tabId);
    case 'projects.openLinked': return str(x.projectId) && str(x.url);
    case 'projects.closeGroup': return str(x.projectId);
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
  /**
   * Fire-time protection of view.close beyond pinned / locked / anchor (M3-R78): a tab with unsaved form edits
   * (SafetyService.isFormEdited) is refused (one tab) or skipped (close-all), unless its row is a close suggestion,
   * which asked the user to decide. Audible and exempt tabs are not refused: the user's Close is explicit. Default: none.
   */
  isFormEdited?: (tabId: number) => boolean;
  /**
   * Awaited before dupes.close* and view.close decide which tabs are kept (background: SafetyService and AnchorService
   * ready), so a popup message that wakes the worker never closes a stored-locked tab or an anchor (M3). Default: none.
   */
  beforeClose?: () => Promise<void>;
  recentlyClosed: Pick<RecentlyClosed, 'list' | 'add' | 'ready'>;
  whyLog: Pick<WhyLog, 'all' | 'forTab' | 'add' | 'ready'>;
  ask: { listPending: () => Promise<PendingAsk[]>; resolvePending: (n: number, e: number, c: 'switch' | 'keep') => Promise<void> };
  /** recipes.* requests: built-in recipe bodies and the PermissionsManager. Without it they fail. */
  recipes?: { builtins: Record<string, Recipe>; permissions: Pick<PermissionsManager, 'check' | 'levels'> };
  /** preview.change (M2 T13). Without it the request fails. Read-only: nothing here may change engine state. */
  preview?: {
    builtins: Record<string, Recipe>;
    /** The Program the engine runs now (ProgramCache.get): the preview's "before". */
    getProgram: () => Promise<Program>;
    /** Reconciler.planContext: copies of the planner's leave-alone tabs, managed titles, group order and dismissed anchors. */
    planContext: (snap: Snapshot, p: Program) => Promise<PreviewContext>;
    /**
     * Reconciler.previewOverrides: the project overrides one side of a preview plans with (M3 T15), so a draft that
     * enables, disables or reorders a project recipe is previewed with its own. Default: the current ones for both.
     */
    projectOverrides?: (snap: Snapshot, p: Program) => Promise<PlanContext['overrides']>;
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
  /** connections.* (M3 T7, the Connections page). Without it they fail. */
  connections?: ConnectionsDeps;
  /** projects.* (M3 T15). Without it they fail. */
  projects?: Pick<ProjectService, 'cards' | 'addTab' | 'removeTab' | 'openLinked' | 'closeGroup'>;
  /** sources.refresh (M3 T17). Without it the request fails. */
  sources?: Pick<SourceService, 'refresh'>;
  now?: () => number;
}

/** The background's shared connection instances (one ConnectionManager, SecretStore and GitHubDeviceAuth). */
export interface ConnectionsDeps {
  manager: Pick<ConnectionManager, 'defs' | 'status' | 'fetch' | 'disconnect'>;
  /** `cancel`: Disconnect abandons a pending device flow, so no later poll stores credentials. */
  github: Pick<GitHubDeviceAuth, 'start' | 'poll' | 'cancel'>;
  /** setGitHubToken with the shared manager, secret store, port and fetch (Task 5a). */
  setGitHubToken: (token: string) => Promise<SetTokenResult>;
  /** Every stored token: a last redact pass over every connections.* response (SecretStore.knownSecrets). */
  knownSecrets: () => Promise<string[]>;
}

/** The test call per connection kind: a cheap authenticated GET. Task 6 adds Jira. */
const TEST_PATHS: Partial<Record<ConnectionDef['kind'], string>> = { github: '/user' };
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,100}$/;
/** Shortest setToken candidate used as a redaction needle (as the manager's header values). */
const MIN_NEEDLE = 8;

/** A def as the UI sees it: the ConnectionDef fields only, so a stray field in storage never leaves the worker. */
function publicDef(d: ConnectionDef): ConnectionDef {
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const opt = <K extends 'revokeUrl' | 'login'>(k: K) => (typeof d[k] === 'string' ? { [k]: d[k] } : {});
  const j = d.jira;
  return {
    id: d.id, kind: d.kind, label: d.label, baseUrl: d.baseUrl, apiBaseUrl: d.apiBaseUrl, hosts: strs(d.hosts), auth: d.auth,
    scopes: strs(d.scopes), ...opt('revokeUrl'), ...opt('login'),
    ...(j && typeof j === 'object' && {
      jira: {
        site: j.site, tokenKind: j.tokenKind,
        ...(typeof j.email === 'string' && { email: j.email }),
        ...(typeof j.cloudId === 'string' && { cloudId: j.cloudId }),
        ...(typeof j.tokenExpiresAt === 'number' && { tokenExpiresAt: j.tokenExpiresAt }),
      },
    }),
  };
}

/** Redacts every string in `v` (deep) against the stored tokens: the last guard on what a connections.* answer carries. */
function scrub<T>(v: T, secrets: string[]): T {
  if (typeof v === 'string') return redact(v, secrets) as T;
  if (Array.isArray(v)) return v.map((x) => scrub(x, secrets)) as T;
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, secrets)])) as T;
  return v;
}

export interface MessageSender { id?: string; url?: string; tab?: { id?: number; url?: string; discarded?: boolean; frozen?: boolean }; frameId?: number; documentId?: string }

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
  return { sets: sets.map((s) => ({ ...s, closable: s.tabs.slice(1).filter((t) => !neverCloseReason(t, deps)).length })), pending };
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
    n = views.reduce((sum, v) => sum + (v.summary.kind === 'projects' ? 0 : v.summary.count), 0); // projects: not items to act on
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
  const never = (t: TabSnap) => neverCloseReason(t, { isLocked: (id) => deps.safety.isLocked(id), ...(deps.isAnchor && { isAnchor: deps.isAnchor }) });
  /** Built-in recipe bodies, when wired: their table names are avoided by import collapse suggestions (T19). */
  const importBuiltins = (): Record<string, Recipe> | undefined => deps.recipes?.builtins ?? deps.preview?.builtins ?? deps.explain?.builtins;

  /** Closes everything but the oldest tab; pinned, locked and anchor tabs are never closed. */
  async function closeSet(set: DupeSet): Promise<number> {
    let closed = 0;
    for (const t of set.tabs.slice(1)) {
      if (never(t)) continue;
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

  /**
   * view.close / view.keep: user-initiated (R50: they apply under global dry run too), only on a row of that view.
   * view.close with `tabs` is close-all (M3-R76): each tab goes through the same checks, and a refused one is skipped.
   */
  async function runViewAction(req: Extract<Request, { type: 'view.close' | 'view.keep' }>, d: ViewsDeps): Promise<Response> {
    await deps.beforeClose?.();
    const { snap, views } = await listViews(d, req.viewId);
    const v = views[0];
    if (!v) return fail('unknown view');
    const all = 'tabs' in req;
    const allowed = req.type === 'view.keep' ? v.summary.actions.includes('keep')
      : all ? v.summary.actions.includes('close-all') : v.summary.actions.some((a) => a === 'close' || a === 'close-all');
    if (!allowed) return fail('action not allowed');
    const p = await d.getProgram();
    /** One row's action; the refusal as an error, or undefined once done. */
    const actOn = async (tabId: number, url: string | undefined): Promise<string | undefined> => {
      const tab = snap.tabs.find((t) => t.id === tabId);
      // R61: act only on the page the row was for. A suggestion made for another page, or a row the popup showed at
      // another URL, means the tab navigated (its suggestion may not be cleared yet): refuse, never act on the new page.
      const stale = tab !== undefined && ((url !== undefined && !samePage(url, tabUrl(tab), p))
        || (v.view.recipeId === 'finished' && d.closes?.suggestions().some((x) => x.tabId === tab.id && !samePage(x.url, tabUrl(tab), p))));
      if (stale) return 'tab has navigated';
      const row = v.data.kind === 'list' ? v.data.rows.find((r) => r.tabId === tabId) : undefined;
      if (!row || !tab) return 'not in view';
      if (req.type === 'view.keep') {
        if (!row.suggested || !d.closes) return 'not in view';
        await d.closes.exempt(tab.id, row.url);
        return undefined;
      }
      const why = never(tab);
      if (why) return why === 'pinned' ? 'tab is pinned' : 'tab is locked';
      if (!row.suggested && deps.isFormEdited?.(tab.id)) return 'tab has unsaved form edits';
      const at = now();
      const groupTitle = tab.groupId !== -1 ? snap.groups.find((g) => g.id === tab.groupId)?.title : undefined;
      await deps.port.closeTab(tab.id);
      deps.recentlyClosed.add({
        url: row.url, title: tab.title, windowId: tab.windowId, reason: row.reason ?? VIEW_CLOSE_REASONS[`${v.view.recipeId}/${v.view.id}`] ?? v.view.tab, at,
        ...(row.ruleKey !== undefined && { ruleId: row.ruleKey }), ...(groupTitle !== undefined && { groupTitle }),
      });
      deps.whyLog.add({
        tabId: tab.id, action: 'view-close', detail: `Closed from the popup's ${v.view.tab} view`, at,
        ...(row.ruleKey !== undefined && { ruleId: row.ruleKey }),
      });
      return undefined;
    };
    if (!('tabs' in req)) {
      const err = await actOn(req.tabId, req.url);
      if (err) return fail(err);
      await refreshBadge(badgeDeps);
      return ok(null);
    }
    let closed = 0;
    let skipped = 0;
    for (const t of req.tabs) {
      let err: string | undefined;
      try {
        err = await actOn(t.tabId, t.url);
      } catch (e) {
        console.warn(`[tabchef] close-all: closing tab ${t.tabId} failed; skipped`, e); // e.g. the tab closed meanwhile
        err = 'close failed';
      }
      if (err) skipped++;
      else closed++;
    }
    await refreshBadge(badgeDeps);
    return ok({ closed, skipped });
  }

  /** The recipe `id` compiled as if enabled with `over` applied: its needs, its rules' own needs and its compile errors. */
  function compileRecipe(cfg: Config, id: string, builtins: Record<string, Recipe>, over: Partial<RecipeRef> = {}) {
    const recipes = cfg.recipes.map((r) => (r.id === id ? { ...r, enabled: true, ...over } : r));
    const { program, errors } = compileProgram({ ...cfg, recipes }, builtins);
    const own = errors.filter((e) => e.key === id || e.key.startsWith(`${id}/`)).map((e) => `${e.key}: ${e.error}`);
    const rules = Object.entries(program.needs).filter(([k]) => k.startsWith(`${id}/`));
    return { program, needs: program.needs[id] ?? { origins: [], permissions: [] }, rules, errors: own };
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
        const { program, needs, rules } = compileRecipe(cfg, r.id, d.builtins);
        const ruleItems: RecipeListItem['rules'] = {};
        for (const [k, n] of rules) ruleItems[k] = { needs: effectiveNeeds(n), status: await d.permissions.check(n) };
        const levels = await d.permissions.levels(program, r.id);
        recipes.push({
          id: r.id, source: r.source, enabled: r.enabled, params: r.params, name: body?.name ?? r.id, description: body?.description ?? '',
          paramDefs: body?.params ?? {}, needs: effectiveNeeds(needs), status: await d.permissions.check(needs), rules: ruleItems,
          ...(levels && { levels }),
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
    /** The context with each side's own project overrides. */
    const sides = async (before: Program, after: Program, base: PreviewContext): Promise<PreviewContext> => {
      if (!d.projectOverrides) return base;
      const [b, a] = await Promise.all([d.projectOverrides(snap, before), d.projectOverrides(snap, after)]);
      return { ...base, overrides: b, afterOverrides: a };
    };
    if (req.only === undefined) {
      const draft = await compileDraft(v.config, d);
      return ok(previewChange(snap, current, draft, facts, await sides(current, draft, ctx), now()));
    }
    // Test one rule: enabled and live (R30 labels belong to Save previews), alone against no rules. No managed titles:
    // only the rule's own groups count as managed, so other rules' groups are not torn down in "before".
    const only = req.only;
    const cfg: Config = { ...v.config, dryRun: false, rules: v.config.rules.map((r) => (userKey(r.id) === only ? { ...r, enabled: true, dryRun: false } : r)) };
    const p = await compileDraft(cfg, d);
    const rules = p.rules.filter((r) => r.key === only).map((r) => ({ ...r, dryRun: false }));
    if (rules.length === 0) return fail('unknown rule');
    const after: Program = { ...p, rules };
    const before = emptyProgram(after);
    return ok(previewChange(snap, before, after, facts, await sides(before, after, { ...ctx, managedTitles: new Set() }), now()));
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

  async function runConnections(req: Extract<Request, { type: `connections.${string}` }>, c: ConnectionsDeps): Promise<Response> {
    switch (req.type) {
      case 'connections.list': {
        const stored = await c.manager.defs();
        const github = builtinConnectionDefs().github;
        const defs = (stored.some((d) => d.id === github.id) ? stored : [github, ...stored]).map(publicDef);
        const status = (await Promise.all(defs.map((d) => c.manager.status(d.id)))).flat();
        return ok({ defs, status });
      }
      case 'connections.github.start': {
        const r = await c.github.start(builtinConnectionDefs().github);
        if (!r.ok) return fail(r.error);
        return ok({ userCode: r.userCode, verificationUri: r.verificationUri, expiresAt: r.expiresAt, interval: r.interval });
      }
      case 'connections.github.poll': {
        const r = await c.github.poll(builtinConnectionDefs().github);
        return ok({ state: r.state, ...(r.interval !== undefined && { interval: r.interval }), ...(r.message !== undefined && { message: r.message }) });
      }
      case 'connections.setToken': {
        if (req.id !== 'github') return fail('Jira connections are not available yet');
        const r = await c.setGitHubToken(req.token);
        return r.ok ? ok(r.status) : fail(r.error);
      }
      case 'connections.test': {
        const def = (await c.manager.defs()).find((d) => d.id === req.id);
        const path = def && TEST_PATHS[def.kind];
        if (!path) return fail(`Testing ${req.id} is not supported`);
        const r = await c.manager.fetch(req.id, { method: 'GET', path });
        if (!r.ok) return fail(r.message);
        const login = typeof r.data === 'object' && r.data !== null ? (r.data as Record<string, unknown>).login : undefined;
        return ok(typeof login === 'string' && GITHUB_LOGIN.test(login) ? { login } : {});
      }
      case 'connections.disconnect':
        // The device flow is GitHub's own state (not the manager's): cancel it first, so a poll from this or another
        // options tab cannot store fresh credentials right after the user disconnected.
        if (req.id === 'github') await c.github.cancel();
        await c.manager.disconnect(req.id);
        return ok(null);
    }
  }

  async function runProjects(req: Extract<Request, { type: `projects.${string}` }>, p: NonNullable<HandlerDeps['projects']>): Promise<Response> {
    switch (req.type) {
      case 'projects.list': return ok(await p.cards());
      case 'projects.addTab': await p.addTab(req.tabId, req.projectId); return ok(null);
      case 'projects.removeTab': await p.removeTab(req.tabId); return ok(null);
      case 'projects.openLinked': return ok({ tabId: await p.openLinked(req.projectId, req.url) });
      case 'projects.closeGroup': return ok(await p.closeGroup(req.projectId));
    }
  }

  async function run(req: Request): Promise<Response> {
    switch (req.type) {
      case 'connections.list': case 'connections.github.start': case 'connections.github.poll': case 'connections.setToken':
      case 'connections.test': case 'connections.disconnect': {
        const c = deps.connections;
        if (!c) return fail('connections unavailable');
        let r: Response;
        try {
          r = await runConnections(req, c);
        } catch (e) {
          r = fail(e instanceof Error ? e.message : String(e));
        }
        // The candidate token of a setToken is not stored yet when it fails: redact it too, unless it is too short to
        // be a token (a 1-character needle would mangle the error text; token shapes are redacted anyway).
        const candidate = req.type === 'connections.setToken' ? req.token.trim() : '';
        return scrub(r, [...(candidate.length >= MIN_NEEDLE ? [candidate] : []), ...(await c.knownSecrets())]);
      }
      case 'projects.list': case 'projects.addTab': case 'projects.removeTab': case 'projects.openLinked': case 'projects.closeGroup':
        return deps.projects ? runProjects(req, deps.projects) : fail('projects unavailable');
      case 'sources.refresh': {
        if (!deps.sources) return fail('sources unavailable');
        try {
          await deps.sources.refresh('popup');
          return ok(null);
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }
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
      case 'import.preview': {
        const current = await deps.store.get();
        const imp = await runImport(req.source, req.data, current, importBuiltins());
        const n = importNext(imp, current, req.collapse, importBuiltins());
        if ('unknownCollapse' in n) return fail('unknown collapse suggestion');
        return ok({ ...imp, config: n.next });
      }
      case 'import.apply': {
        const current = await deps.store.get();
        const imp = await runImport(req.source, req.data, current, importBuiltins());
        if (imp.rules.length === 0 && Object.keys(imp.dedupe).length === 0) return fail('nothing to import', imp.warnings);
        if (req.baseRev !== configRev(current)) return fail('conflict');
        let added = 0;
        let invalid: string[] | undefined;
        let unknownCollapse = false;
        try {
          await deps.store.update((cur) => {
            if (configRev(cur) !== req.baseRev) throw new Conflict();
            const n = importNext(imp, cur, req.collapse, importBuiltins());
            if ('unknownCollapse' in n) { unknownCollapse = true; throw new Conflict(); }
            if (n.invalid) { invalid = n.invalid; throw new Conflict(); }
            added = n.added;
            return n.next;
          });
        } catch (e) {
          if (!(e instanceof Conflict)) throw e;
          if (unknownCollapse) return fail('unknown collapse suggestion');
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
        await deps.beforeClose?.();
        const set = (await sets()).find((s) => s.key === req.key);
        const n = set ? await closeSet(set) : 0;
        await refreshBadge(badgeDeps);
        return ok(n);
      }
      case 'dupes.closeAll': {
        await deps.beforeClose?.();
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
  pageFacts: Pick<PageFacts, 'set' | 'onHello' | 'watchConfigFor' | 'isCurrentDocument' | 'isRetiredDocument' | 'buffer'>;
  safety: Pick<SafetyService, 'markFormEdited' | 'clearFormEdited'>;
  /** Reconciler.schedule. */
  schedule: (reason: string) => void;
  /** New facts for a tab (CloseExecutor.onFacts, M2 T9). */
  onFacts?: (tabId: number) => void;
  /** The protected-close banner's answer for the sending tab (CloseExecutor.onCloseChoice, D22). */
  onCloseChoice?: (tabId: number, choice: CloseChoiceMessage['choice']) => void;
}

/** What an accepted report changes besides the stored facts: form state, then (with facts) a re-plan and onFacts. */
function applyReport(d: Pick<ContentDeps, 'safety' | 'schedule' | 'onFacts'>, tabId: number, r: EarlyReport): void {
  if (r.formEdited) d.safety.markFormEdited(tabId, r.url);
  else if (r.facts) d.safety.clearFormEdited(tabId);
  if (!r.facts) return;
  d.schedule('pageFacts');
  d.onFacts?.(tabId);
}

/**
 * PageFactsDeps.onAdopt: a document's early report (its hello or page.facts arrived before its commit) adopted by
 * that commit is applied as if it had been accepted then. PageFacts has already stored its facts.
 */
export function adoptReport(d: Pick<ContentDeps, 'safety' | 'schedule' | 'onFacts'>, tabId: number, r: EarlyReport): void {
  applyReport(d, tabId, r);
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
  /** The tab's current document (or none is known), and not one a commit retired. */
  const isCurrent = (tabId: number, documentId: string | undefined): boolean =>
    d.pageFacts.isCurrentDocument(tabId, documentId) && !d.pageFacts.isRetiredDocument(tabId, documentId);
  return (msg, sender) => {
    if (isCloseChoiceMessage(msg)) {
      if (!isTabContentScript(sender, d)) return Promise.resolve(forbidden);
      d.onCloseChoice?.(sender.tab!.id!, msg.choice);
      return Promise.resolve({ ok: true });
    }
    const hello = isWatchHello(msg);
    const pf = hello ? undefined : pageFactsOf(msg);
    if (!hello && !pf) return undefined;
    if (!isTabContentScript(sender, d)) return Promise.resolve(forbidden);
    const tabId = sender.tab!.id!;
    // The frame's URL at send time: after pushState the tab's URL may not have caught up yet.
    const url = sender.url ?? sender.tab?.url ?? '';
    if (hello) {
      const m = msg as WatchHelloMessage;
      // Always answered with the config: the watch keeps it for its document's life (a bfcache-restored page's hello can
      // beat its own commit). Only commits change or retire the tab's document. A hello from the current document (or
      // where none is known) starts a new page state (load, back/forward-cache restore, same-document navigation,
      // which fires no onCommitted): drop the previous facts and hold until the fresh report that follows the answer.
      // A hello from any other document (retired, or not committed yet) leaves the current page's facts alone.
      // Its form state is kept for that document (PageFacts.buffer) and applied if it commits: Back to an edited page
      // can deliver the pageshow hello before the restore's commit.
      if (isCurrent(tabId, sender.documentId)) {
        d.pageFacts.onHello(tabId);
        if (m.formEdited) d.safety.markFormEdited(tabId, url);
      } else {
        d.pageFacts.buffer(tabId, sender.documentId!, { formEdited: m.formEdited, url });
      }
      return d.getProgram().then((p): WatchConfigMessage => ({ type: 'watch.config', ...d.pageFacts.watchConfigFor(url, p, sender.tab) }));
    }
    const m = pf!;
    const pageFacts = { texts: [...m.texts], extracts: { ...m.extracts }, formEdited: m.formEdited };
    // Sent by a document that is not the tab's current one: not this page's facts. Kept for that document in case it
    // commits after all (its report beat its commit); a previous document's report is never applied to this one.
    if (!isCurrent(tabId, sender.documentId)) {
      d.pageFacts.buffer(tabId, sender.documentId!, { facts: pageFacts, formEdited: m.formEdited, url });
      return Promise.resolve({ ok: false, error: 'stale document' });
    }
    d.pageFacts.set(tabId, pageFacts);
    applyReport(d, tabId, { facts: pageFacts, formEdited: m.formEdited, url });
    return Promise.resolve({ ok: true });
  };
}
