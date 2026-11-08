// Recipe-declared popup views (M2 T17). Read-only: computes what views.list / view.data report; the view actions
// (view.close / view.keep) live in messages.ts and act through the existing engine paths.
//
// - kind 'duplicates': the M1 duplicate sets and pending asks (computed by the handler, passed in as `dupes`).
// - kind 'list': the tabs whose evaluateTab(...).views includes the view id (showInView, ruling R26), plus
//   CloseExecutor.suggestions() for the Finished recipe's `finished` view, filtered by `show` over {tab.*, extract.*},
//   then grouped (`groupBy`) and sorted (`sort`). Dry-run rules put no tab in a view (R48: they fall through).
//   M3 T13: `show` / `groupBy` / `sort` also read `source.<name>` (the tab's source data of the first feeding rule
//   that has an entry; missing = unknown, so an unknown or data-less PR never matches `==`) and `params.<name>` (the
//   view's recipe params). Rows carry that source data and `stale` (the state pill and the stale marker).
// - kind 'projects' (M3 T17): the popup's Projects tab, which reads projects.list itself; its data is only the kind,
//   and its count is the open projects (`projectCount`). They are not items to act on, so the toolbar badge and the
//   popup header total leave them out.
// - Which views: every enabled recipe's views (paused ones too, faded with their reason, R45), the first declaration
//   of an id winning; plus the built-in Duplicates view while global dedupe is active (R58) and the built-in Finished
//   view while close suggestions exist, whichever rule made them (R59), or while a recipe whose projects can be done is
//   on (#195).
// - #195: the Finished view also lists the done projects (ProjectService.doneProjects: Done by fresh data at the last
//   listing, prompt not answered Keep) as `projects`, counted with its rows (the badge and the popup header total too).
import { tabUrl } from '../core/dedupe/find';
import { evalShow } from '../core/lang/cond';
import { compileProgram } from '../core/lang/compile';
import { liveProgram } from '../core/lang/dry-run';
import { evaluateTab, type EvalResult } from '../core/lang/evaluate';
import { alternativesOf, hostOf } from '../core/lang/needs';
import type { Program, Recipe, TabFacts, View } from '../core/lang/types';
import type { DoneProject } from '../core/projects/types';
import type { Config, Snapshot, TabSnap } from '../core/types';
import { normalizeUrl } from '../core/url/normalize';
import type { PendingAsk } from './ask';
import type { CloseSuggestion } from './close-executor';
import type { DupeSetView } from './messages';
import type { NeedStatus, PermissionsManager } from './permissions';

export type DeclaredView = View & { recipeId: string };

/** One row of a list view. `suggested`: a CloseExecutor suggestion (Finished), which `keep` dismisses. */
export interface ViewRow {
  tabId: number; windowId: number; title: string; url: string; favIconUrl?: string; pinned: boolean;
  /** The `groupBy` value ('' when the field is missing); absent without groupBy. */
  group?: string;
  /** Why the tab is listed (the suggesting rule's name) and that rule's key. */
  reason?: string; ruleKey?: string;
  suggested?: true;
  /** M3 T13: the feeding rule's source data (picked fields, e.g. `state`, `mergedAt`); absent when it has none. */
  source?: Record<string, unknown>;
  /** The source data could not be refreshed (connection error, page fallback): shown with a stale marker. */
  stale?: true;
}

/**
 * Every rule feeding a view is paused and some of them can run on a connection (M3 T13): the locked state. `text`
 * is e.g. "Needs GitHub access"; the popup offers Connect <label> (options #/connections) and Allow <hosts>, which
 * requests `origins` and `permissions` (what the paused rules miss) in the click handler.
 */
export interface ViewLock {
  text: string; connections: { id: string; label: string }[]; hosts: string[]; origins: string[]; permissions: string[];
}

/** A view as views.list reports it. `paused`: the view's recipe, or every rule feeding it, waits for a permission
 * (faded, R45); `notice`: only some feeding rules do (the view still fills). Both are "Paused: needs access to …". */
export interface ViewSummary {
  id: string; tab: string; kind: View['kind']; actions: View['actions']; count: number; paused?: string; notice?: string;
  locked?: ViewLock;
}

export type ViewData =
  | { kind: 'duplicates'; sets: DupeSetView[]; pending: PendingAsk[] }
  /**
   * `projects` (#195): the Finished view's done projects, each with the card prompt's actions. `syncOn` (#157): project
   * sync is on (projects.sync.status `enabled`), set by view.data alongside `projects`, so their Keep is named on first
   * render.
   */
  | { kind: 'list'; rows: ViewRow[]; projects?: DoneProject[]; syncOn?: true }
  | { kind: 'projects' };

export interface ViewsDeps {
  builtins: Record<string, Recipe>;
  /** The Program the engine runs (ProgramCache.get). */
  getProgram: () => Promise<Program>;
  /**
   * Per-tab facts the snapshot lacks (page facts, source data). `url` is the snapshot tab's URL, so source data
   * looked up for the tab's previous page is not used (SourceService.factsFor's URL guard). Default: none.
   */
  facts?: (tabId: number, url?: string) => Partial<TabFacts>;
  /** Needs that are not granted pause their view (R45). Default: all granted. */
  permissions?: Pick<PermissionsManager, 'check'>;
  /** CloseExecutor: its persisted suggestions (storage.session `closeSuggestions`) and the undo exemption (keep). */
  closes?: { ready: Promise<void>; suggestions(): CloseSuggestion[]; exempt(tabId: number, url: string): Promise<void> };
  /** Connection ids and labels, for the locked state's copy (ConnectionManager defs). Default: the ids. */
  connections?: () => Promise<{ id: string; label: string }[]>;
  /** How many projects are open (ProjectService, as of its last pass): a projects view's count. Default: 0. */
  projectCount?: () => number;
  /** #195: the done projects the Finished view lists (ProjectService.doneProjects). Default: none. */
  doneProjects?: () => Promise<DoneProject[]>;
  /**
   * #195: start a fresh project listing (ProjectService.cards) without waiting for it; it updates doneProjects, and the
   * popup refreshes when that changes. Called by views.list while the Finished view is listed, never by the badge.
   */
  refreshDone?: () => void;
}

export interface ViewsInput {
  snap: Snapshot;
  /** The stored config: needed for R58 and for the paused status; without it neither is computed (toolbar badge). */
  config?: Config;
  now: number;
  /** Duplicates data (the handler's dupes.list); without it duplicates views are left out. */
  dupes?: () => Promise<{ sets: DupeSetView[]; pending: PendingAsk[] }>;
  /** Only this view id. */
  only?: string;
  /** Skip the paused status (the toolbar badge only needs counts). */
  noStatus?: boolean;
}

export interface ComputedView { view: DeclaredView; summary: ViewSummary; data: ViewData }

/** The same page as CloseExecutor sees it: equal dedupe-normalized URLs (tracking params, fragment, ...). */
export function samePage(a: string, b: string, p: Program): boolean {
  return (normalizeUrl(a, p.dedupe)?.key ?? a) === (normalizeUrl(b, p.dedupe)?.key ?? b);
}

/** The Finished recipe's view: it also lists CloseExecutor.suggestions() (T9→T17) and the done projects (#195). */
export const isSuggestionsView = (v: { recipeId: string; id: string }): boolean => v.recipeId === 'finished' && v.id === 'finished';

/**
 * #195: an enabled recipe's projects can be done: it declares a project and one of its rules reads a status category
 * (a source field `statusCategory`, as github-issue and the jira-ticket-* recipes do). The Finished view then lists them.
 */
export function canFinishProjects(p: Program): boolean {
  const withProjects = new Set((p.projects ?? []).map((d) => d.recipeId));
  return p.rules.some((r) => r.recipeId !== undefined && withProjects.has(r.recipeId)
    && r.rule.source !== undefined && Object.hasOwn(r.rule.source.fields, 'statusCategory'));
}

/**
 * The views the popup lists, in Program (recipe) order; R58's Duplicates view first. R59's Finished view (shown while
 * `hasSuggestions` even with the finished recipe disabled, and while canFinishProjects, #195) takes the finished
 * recipe's place in config.recipes, as when that recipe is on.
 */
export function declaredViews(
  p: Program, config: Config | undefined, builtins: Record<string, Recipe>, hasSuggestions = false,
): DeclaredView[] {
  const showFinished = hasSuggestions || canFinishProjects(p);
  const out: DeclaredView[] = [];
  const seen = new Set<string>();
  const builtinViews = (id: string) => (Object.hasOwn(builtins, id) ? builtins[id]?.views ?? [] : []);
  // View ids are global (showInView names an id only): the first declaration of an id wins, later ones are dropped.
  for (const v of p.views) if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
  if (showFinished && !out.some(isSuggestionsView)) {
    // The place the finished recipe's view has when it is on (its place in config.recipes), so the tab does not move
    // when the recipe is turned off; last without a config (the toolbar badge, where order does not matter).
    const rank = new Map((Array.isArray(config?.recipes) ? config.recipes : []).map((r, i) => [r.id, i] as const));
    const own = rank.get('finished');
    const at = own === undefined ? -1 : out.findIndex((v) => (rank.get(v.recipeId) ?? Infinity) > own);
    const add = builtinViews('finished').filter((v) => !seen.has(v.id)).map((v) => ({ ...v, recipeId: 'finished' }));
    for (const v of add) seen.add(v.id);
    out.splice(at < 0 ? out.length : at, 0, ...add);
  }
  if (config && config.dedupe.mode !== 'off') {
    const dup = builtinViews('duplicates').filter((v) => !seen.has(v.id));
    out.unshift(...dup.map((v) => ({ ...v, recipeId: 'duplicates' })));
  }
  return out;
}

function factsOf(snap: Snapshot, tab: TabSnap, extra: Partial<TabFacts>): TabFacts {
  const opener = tab.openerTabId !== undefined ? snap.tabs.find((t) => t.id === tab.openerTabId) : undefined;
  const groupTitle = tab.groupId !== -1 ? snap.groups.find((g) => g.id === tab.groupId)?.title : undefined;
  return { ...extra, tab, ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }) };
}

/**
 * `tab.<prop>` (primitive TabSnap fields; `tab.url` is the pending URL when there is one), `extract.<name>`, and (M3)
 * `source.<name>` and `params.<name>`.
 */
function fieldOf(
  tab: TabSnap, extract: Record<string, string>, source: Record<string, unknown> = {}, params: Record<string, unknown> = {},
): (name: string) => unknown {
  const ownVal = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
  return (name) => {
    if (name.startsWith('source.')) return ownVal(source, name.slice(7));
    if (name.startsWith('params.')) return ownVal(params, name.slice(7));
    if (name === 'tab.url') return tabUrl(tab);
    if (name.startsWith('tab.')) {
      const k = name.slice(4);
      const v = Object.hasOwn(tab, k) ? (tab as unknown as Record<string, unknown>)[k] : undefined;
      return typeof v === 'object' ? undefined : v;
    }
    if (name.startsWith('extract.')) {
      const k = name.slice(8);
      return Object.hasOwn(extract, k) ? extract[k] : undefined;
    }
    return undefined;
  };
}

function cmp(a: unknown, b: unknown): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1; // missing values last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

type SourceFacts = NonNullable<TabFacts['source']>;
type SourceOf = (t: TabSnap) => SourceFacts | undefined;

/** The tab's source entry of the first of `keys` that has one (the view's feeding rules). */
function entryOf(src: SourceFacts | undefined, keys: string[]): { data?: Record<string, unknown>; stale?: boolean } | undefined {
  if (!src) return undefined;
  for (const k of keys) if (Object.hasOwn(src, k) && src[k]) return src[k];
  return undefined;
}

function listRows(
  v: DeclaredView, snap: Snapshot, p: Program, evalOf: (t: TabSnap) => EvalResult, suggestions: Map<number, CloseSuggestion>,
  sourceOf: SourceOf,
): ViewRow[] {
  const rows: { row: ViewRow; sortKey: unknown; order: number }[] = [];
  const keys = feedingRules(v, p);
  const params = p.params?.[v.recipeId] ?? {};
  snap.tabs.forEach((tab, order) => {
    const ev = evalOf(tab);
    // A suggestion is for one page (R61): once the tab navigated it is stale, even before the executor clears it.
    const s = isSuggestionsView(v) ? suggestions.get(tab.id) : undefined;
    const sug = s && samePage(s.url, tabUrl(tab), p) ? s : undefined;
    if (!sug && !ev.views.includes(v.id)) return;
    const entry = entryOf(sourceOf(tab), keys);
    const data = entry?.data && Object.keys(entry.data).length ? entry.data : undefined;
    const field = fieldOf(tab, ev.viewVars?.[v.id] ?? {}, data, params);
    if (v.show && !evalShow(v.show, field)) return;
    const row: ViewRow = {
      tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tabUrl(tab), pinned: tab.pinned,
      ...(tab.favIconUrl && { favIconUrl: tab.favIconUrl }),
      ...(v.groupBy !== undefined && { group: String(field(v.groupBy) ?? '') }),
      ...(sug && { reason: sug.reason, ruleKey: sug.ruleKey, suggested: true as const }),
      ...(data && { source: { ...data } }), ...(data && entry?.stale && { stale: true as const }),
    };
    rows.push({ row, sortKey: v.sort ? field(v.sort.field) : undefined, order });
  });
  const dir = v.sort?.dir === 'desc' ? -1 : 1;
  rows.sort((a, b) => (v.groupBy !== undefined ? cmp(a.row.group, b.row.group) : 0)
    || (v.sort ? (a.sortKey === undefined || b.sortKey === undefined ? cmp(a.sortKey, b.sortKey) : dir * cmp(a.sortKey, b.sortKey)) : 0)
    || a.order - b.order);
  return rows.map((x) => x.row);
}

/** Rule keys that put tabs in `v`: its declared `rules`, else its recipe's showInView rules (and close rules for Finished). */
function feedingRules(v: DeclaredView, full: Program): string[] {
  if (v.rules?.length) return v.rules.map((id) => `${v.recipeId}/${id}`);
  return full.rules.filter((r) => r.recipeId === v.recipeId && r.rule.actions.some((a) =>
    ('showInView' in a && a.showInView.view === v.id) || ('close' in a && isSuggestionsView(v)))).map((r) => r.key);
}

async function pauseOf(v: DeclaredView, full: Program, d: ViewsDeps): Promise<Pick<ViewSummary, 'paused' | 'notice' | 'locked'>> {
  const check = (n: Program['needs'][string]) => d.permissions!.check(n);
  const own = full.needs[v.recipeId];
  if (own) {
    const st = await check(own);
    if (!st.ok) return { paused: st.reason ?? 'Paused' };
  }
  const feeding = feedingRules(v, full);
  const reasons: string[] = [];
  const missing: NeedStatus['missing'][] = [];
  const conns = new Set<string>();
  for (const k of feeding) {
    const n = full.needs[k];
    if (!n) continue;
    const st = await check(n);
    if (st.ok) continue;
    reasons.push(st.reason ?? 'Paused');
    missing.push(st.missing);
    for (const a of alternativesOf(n)) for (const c of a.connections ?? []) conns.add(c);
  }
  if (reasons.length === 0) return {};
  // Fade only when every feeding rule is paused: Finished keeps filling from OAuth / redirect while meet-ended waits.
  const reason = [...new Set(reasons)].join('; ');
  if (reasons.length !== feeding.length) return { notice: reason };
  return { paused: reason, ...(conns.size > 0 && { locked: await lockOf([...conns], missing, d) }) };
}

/** The locked state of a view whose paused rules can run on one of `conns` (M3 T13). */
async function lockOf(conns: string[], missing: NeedStatus['missing'][], d: ViewsDeps): Promise<ViewLock> {
  const labels = new Map((await d.connections?.().catch(() => []) ?? []).map((c) => [c.id, c.label]));
  const connections = conns.map((id) => ({ id, label: labels.get(id) ?? id }));
  const origins = [...new Set(missing.flatMap((m) => m.origins))];
  return {
    text: `Needs ${connections.map((c) => c.label).join(' or ')} access`, connections,
    hosts: [...new Set(origins.map(hostOf))], origins, permissions: [...new Set(missing.flatMap((m) => m.permissions))],
  };
}

/** Every listed view (or only `input.only`) with its summary and data. Read-only. */
export async function readViews(d: ViewsDeps, input: ViewsInput): Promise<ComputedView[]> {
  const { snap, config, now } = input;
  const p = await d.getProgram();
  await d.closes?.ready;
  const suggestions = new Map((d.closes?.suggestions() ?? []).map((s) => [s.tabId, s]));
  const views = declaredViews(p, config, d.builtins, suggestions.size > 0)
    .filter((v) => (input.only === undefined || v.id === input.only) && (v.kind !== 'duplicates' || input.dupes));
  if (views.length === 0) return [];
  const live = liveProgram(p);
  const evals = new Map<number, EvalResult>();
  const extras = new Map<number, Partial<TabFacts>>();
  const extraOf = (t: TabSnap): Partial<TabFacts> => {
    let x = extras.get(t.id);
    if (!x) extras.set(t.id, (x = d.facts?.(t.id, t.pendingUrl || t.url) ?? {}));
    return x;
  };
  const evalOf = (t: TabSnap): EvalResult => {
    let ev = evals.get(t.id);
    if (!ev) evals.set(t.id, (ev = evaluateTab(live, factsOf(snap, t, extraOf(t)), now)));
    return ev;
  };
  const full = config && d.permissions && !input.noStatus ? compileProgram(config, d.builtins).program : undefined;
  const dupes = views.some((v) => v.kind === 'duplicates') ? await input.dupes!() : undefined;
  const done = d.doneProjects && views.some(isSuggestionsView) ? await d.doneProjects() : [];
  const out: ComputedView[] = [];
  for (const v of views) {
    const data: ViewData = v.kind === 'projects' ? { kind: 'projects' }
      : v.kind === 'duplicates' && dupes ? { kind: 'duplicates', ...dupes }
      : {
        kind: 'list', rows: listRows(v, snap, p, evalOf, suggestions, (t) => extraOf(t).source),
        ...(isSuggestionsView(v) && done.length > 0 && { projects: done }),
      };
    const count = data.kind === 'duplicates' ? data.sets.reduce((n, s) => n + s.closable, 0) + data.pending.length
      : data.kind === 'list' ? data.rows.length + (data.projects?.length ?? 0) : d.projectCount?.() ?? 0;
    const pause = full && d.permissions ? await pauseOf(v, full, d) : {};
    out.push({ view: v, data, summary: { id: v.id, tab: v.tab, kind: v.kind, actions: [...v.actions], count, ...pause } });
  }
  return out;
}
