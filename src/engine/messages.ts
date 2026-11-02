import type { Config, DedupeSettings, GroupRule, TabSnap } from '../core/types';
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
import type { Program, Recipe, RecipeRef } from '../core/lang/types';
import { effectiveNeeds, type Needs, type NeedStatus, type PermissionsManager } from './permissions';
import type { PendingAsk } from './ask';
import type { PageFacts, WatchSelector } from './page-facts';
import type { PauseDuration, SafetyService } from './safety';

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
  // The UI calls requestNeeds (src/ui/permissions.ts) first, in the click's user gesture, then recipes.enable.
  | { type: 'recipes.enable'; id: string; baseRev?: string }
  | { type: 'recipes.disable'; id: string; baseRev?: string }
  | { type: 'recipes.setParams'; id: string; params: Record<string, unknown>; baseRev?: string };

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
}
export type ResponseFor<R extends Request> = Response<ResponseData[R['type']]>;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const NO_ARGS = new Set(['config.get', 'config.backups', 'config.status', 'tabs.list', 'dupes.list', 'dupes.closeAll', 'recent.list', 'why.all',
  'safety.resume', 'safety.status', 'recipes.list']);
const optRev = (x: Record<string, unknown>) => x.baseRev === undefined || str(x.baseRev);

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
    case 'recipes.enable': case 'recipes.disable': return str(x.id) && optRev(x);
    case 'recipes.setParams':
      return str(x.id) && typeof x.params === 'object' && x.params !== null && !Array.isArray(x.params) && optRev(x);
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
  safety: Pick<SafetyService, 'pause' | 'resume' | 'isPaused' | 'lock' | 'unlock' | 'isLocked' | 'lockedTabIds' | 'undo'>;
  recentlyClosed: Pick<RecentlyClosed, 'list' | 'add' | 'ready'>;
  whyLog: Pick<WhyLog, 'all' | 'forTab' | 'add' | 'ready'>;
  ask: { listPending: () => Promise<PendingAsk[]>; resolvePending: (n: number, e: number, c: 'switch' | 'keep') => Promise<void> };
  /** recipes.* requests: built-in recipe bodies and the PermissionsManager. Without it they fail. */
  recipes?: { builtins: Record<string, Recipe>; permissions: Pick<PermissionsManager, 'check'> };
  now?: () => number;
}

export interface MessageSender { id?: string; url?: string; tab?: { id?: number; url?: string }; frameId?: number }

/** True for the extension's own pages (popup, options, side panel); false for content scripts and other extensions. */
export function isExtensionPage(sender: MessageSender, d: Pick<HandlerDeps, 'runtimeId' | 'extensionOrigin'>): boolean {
  if (sender.id !== d.runtimeId) return false;
  if (!sender.tab) return true;
  return typeof sender.url === 'string' && (sender.url === d.extensionOrigin || sender.url.startsWith(`${d.extensionOrigin}/`));
}

type BadgeDeps = Pick<HandlerDeps, 'port' | 'getSettings' | 'ask'> & { isLocked: (tabId: number) => boolean };

/** Closable duplicate extras (tabs after the oldest, excluding pinned and locked) plus pending asks. */
export async function badgeCount(deps: BadgeDeps): Promise<number> {
  const [snap, settings, pending] = await Promise.all([deps.port.snapshot(), deps.getSettings(), deps.ask.listPending()]);
  const extras = findDuplicateSets(snap.tabs, settings).reduce((n, s) => n + s.tabs.slice(1).filter((t) => !t.pinned && !deps.isLocked(t.id)).length, 0);
  return extras + pending.length;
}

export async function refreshBadge(deps: BadgeDeps): Promise<void> {
  const n = await badgeCount(deps);
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

  /** Closes everything but the oldest tab; pinned and locked tabs are never closed. */
  async function closeSet(set: DupeSet): Promise<number> {
    let closed = 0;
    for (const t of set.tabs.slice(1)) {
      if (t.pinned || deps.safety.isLocked(t.id)) continue;
      const url = tabUrl(t);
      await deps.port.closeTab(t.id);
      deps.recentlyClosed.add({ url, title: t.title, windowId: t.windowId, reason: 'duplicate', at: now() });
      deps.whyLog.add({ tabId: t.id, action: 'dupes-close', detail: `Closed duplicate of tab ${set.tabs[0]!.id} from the popup`, at: now() });
      closed++;
    }
    return closed;
  }

  async function sets(): Promise<DupeSet[]> {
    const [snap, settings] = await Promise.all([deps.port.snapshot(), deps.getSettings()]);
    return findDuplicateSets(snap.tabs, settings);
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
    switch (req.type) {
      case 'recipes.enable': {
        const { needs, errors } = compileRecipe(cfg, req.id, d.builtins);
        if (errors.length) return fail('invalid recipe', errors);
        // R5: only recipe-level needs gate the enable; an unmet rule-level need pauses that rule after enabling.
        if (!(await d.permissions.check(needs)).ok) return fail('missing permissions');
        return updateRecipe(req.id, req.baseRev, (r) => ({ ...r, enabled: true }));
      }
      case 'recipes.disable': return updateRecipe(req.id, req.baseRev, (r) => ({ ...r, enabled: false }));
      case 'recipes.setParams': {
        const defs = bodyOf(ref)?.params ?? {};
        const errors: string[] = [];
        for (const [name, v] of Object.entries(req.params)) {
          const def = Object.hasOwn(defs, name) ? defs[name] : undefined;
          const m = def ? paramProblem(def, v) : undefined;
          if (!def) errors.push(`unknown param: ${name}`);
          else if (m) errors.push(`param ${name}: ${m}`);
        }
        if (errors.length) return fail('invalid params', errors);
        // Values valid alone may still fail where they land (e.g. braces in a template, R37).
        const compiled = compileRecipe(cfg, req.id, d.builtins, { params: req.params });
        if (compiled.errors.length) return fail('invalid params', compiled.errors);
        return updateRecipe(req.id, req.baseRev, (r) => ({ ...r, params: { ...req.params } }));
      }
    }
  }

  async function run(req: Request): Promise<Response> {
    switch (req.type) {
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
      case 'dupes.list': {
        const views = (await sets()).map((s): DupeSetView => ({
          ...s, closable: s.tabs.slice(1).filter((t) => !t.pinned && !deps.safety.isLocked(t.id)).length,
        }));
        return ok({ sets: views, pending: await deps.ask.listPending() });
      }
      case 'dupes.closeExtras': {
        const set = (await sets()).find((s) => s.key === req.key);
        const n = set ? await closeSet(set) : 0;
        await refreshBadge({ ...deps, isLocked: (id) => deps.safety.isLocked(id) });
        return ok(n);
      }
      case 'dupes.closeAll': {
        let n = 0;
        for (const s of await sets()) n += await closeSet(s);
        await refreshBadge({ ...deps, isLocked: (id) => deps.safety.isLocked(id) });
        return ok(n);
      }
      case 'dupes.resolve':
        await deps.ask.resolvePending(req.newTabId, req.existingTabId, req.choice);
        await refreshBadge({ ...deps, isLocked: (id) => deps.safety.isLocked(id) });
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
