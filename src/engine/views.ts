// Recipe-declared popup views (M2 T17). Read-only: computes what views.list / view.data report; the view actions
// (view.close / view.keep) live in messages.ts and act through the existing engine paths.
//
// - kind 'duplicates': the M1 duplicate sets and pending asks (computed by the handler, passed in as `dupes`).
// - kind 'list': the tabs whose evaluateTab(...).views includes the view id (showInView, ruling R26), plus
//   CloseExecutor.suggestions() for the Finished recipe's `finished` view, filtered by `show` over {tab.*, extract.*},
//   then grouped (`groupBy`) and sorted (`sort`). Dry-run rules put no tab in a view (R48: they fall through).
// - Which views: every enabled recipe's views (paused ones too, faded with their reason, R45), the first declaration
//   of an id winning; plus the built-in Duplicates view while global dedupe is active (R58).
import { tabUrl } from '../core/dedupe/find';
import { evalShow } from '../core/lang/cond';
import { compileProgram } from '../core/lang/compile';
import { liveProgram } from '../core/lang/dry-run';
import { evaluateTab, type EvalResult } from '../core/lang/evaluate';
import type { Program, Recipe, TabFacts, View } from '../core/lang/types';
import type { Config, Snapshot, TabSnap } from '../core/types';
import type { PendingAsk } from './ask';
import type { CloseSuggestion } from './close-executor';
import type { DupeSetView } from './messages';
import type { PermissionsManager } from './permissions';

export type DeclaredView = View & { recipeId: string };

/** One row of a list view. `suggested`: a CloseExecutor suggestion (Finished), which `keep` dismisses. */
export interface ViewRow {
  tabId: number; windowId: number; title: string; url: string; favIconUrl?: string; pinned: boolean;
  /** The `groupBy` value ('' when the field is missing); absent without groupBy. */
  group?: string;
  /** Why the tab is listed (the suggesting rule's name) and that rule's key. */
  reason?: string; ruleKey?: string;
  suggested?: true;
}

/** A view as views.list reports it. `paused`: the view's recipe, or every rule feeding it, waits for a permission
 * (faded, R45); `notice`: only some feeding rules do (the view still fills). Both are "Paused: needs access to …". */
export interface ViewSummary {
  id: string; tab: string; kind: View['kind']; actions: View['actions']; count: number; paused?: string; notice?: string;
}

export type ViewData =
  | { kind: 'duplicates'; sets: DupeSetView[]; pending: PendingAsk[] }
  | { kind: 'list'; rows: ViewRow[] };

export interface ViewsDeps {
  builtins: Record<string, Recipe>;
  /** The Program the engine runs (ProgramCache.get). */
  getProgram: () => Promise<Program>;
  /** Per-tab facts the snapshot lacks (page facts). Default: none. */
  facts?: (tabId: number) => Partial<TabFacts>;
  /** Needs that are not granted pause their view (R45). Default: all granted. */
  permissions?: Pick<PermissionsManager, 'check'>;
  /** CloseExecutor: its persisted suggestions (storage.session `closeSuggestions`) and the undo exemption (keep). */
  closes?: { ready: Promise<void>; suggestions(): CloseSuggestion[]; exempt(tabId: number, url: string): Promise<void> };
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
}

export interface ComputedView { view: DeclaredView; summary: ViewSummary; data: ViewData }

/** The Finished recipe's view: it also lists CloseExecutor.suggestions() (T9→T17). */
const isSuggestionsView = (v: DeclaredView): boolean => v.recipeId === 'finished' && v.id === 'finished';

/** The views the popup lists, in Program (recipe) order; R58's Duplicates view first. */
export function declaredViews(p: Program, config: Config | undefined, builtins: Record<string, Recipe>): DeclaredView[] {
  const out: DeclaredView[] = [];
  const seen = new Set<string>();
  for (const v of p.views) if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
  if (config && config.dedupe.mode !== 'off') {
    const dup = (Object.hasOwn(builtins, 'duplicates') ? builtins.duplicates?.views ?? [] : []).filter((v) => !seen.has(v.id));
    out.unshift(...dup.map((v) => ({ ...v, recipeId: 'duplicates' })));
  }
  return out;
}

function factsOf(snap: Snapshot, tab: TabSnap, extra: Partial<TabFacts>): TabFacts {
  const opener = tab.openerTabId !== undefined ? snap.tabs.find((t) => t.id === tab.openerTabId) : undefined;
  const groupTitle = tab.groupId !== -1 ? snap.groups.find((g) => g.id === tab.groupId)?.title : undefined;
  return { ...extra, tab, ...(opener && { opener }), ...(groupTitle !== undefined && { groupTitle }) };
}

/** `tab.<prop>` (primitive TabSnap fields; `tab.url` is the pending URL when there is one) and `extract.<name>`. */
function fieldOf(tab: TabSnap, extract: Record<string, string>): (name: string) => unknown {
  return (name) => {
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

function listRows(
  v: DeclaredView, snap: Snapshot, evalOf: (t: TabSnap) => EvalResult, suggestions: Map<number, CloseSuggestion>,
): ViewRow[] {
  const rows: { row: ViewRow; sortKey: unknown; order: number }[] = [];
  snap.tabs.forEach((tab, order) => {
    const ev = evalOf(tab);
    const sug = isSuggestionsView(v) ? suggestions.get(tab.id) : undefined;
    if (!sug && !ev.views.includes(v.id)) return;
    const field = fieldOf(tab, ev.viewVars?.[v.id] ?? {});
    if (v.show && !evalShow(v.show, field)) return;
    const row: ViewRow = {
      tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tabUrl(tab), pinned: tab.pinned,
      ...(tab.favIconUrl && { favIconUrl: tab.favIconUrl }),
      ...(v.groupBy !== undefined && { group: String(field(v.groupBy) ?? '') }),
      ...(sug && { reason: sug.reason, ruleKey: sug.ruleKey, suggested: true as const }),
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

async function pauseOf(v: DeclaredView, full: Program, check: Pick<PermissionsManager, 'check'>['check']): Promise<Pick<ViewSummary, 'paused' | 'notice'>> {
  const own = full.needs[v.recipeId];
  if (own) {
    const st = await check(own);
    if (!st.ok) return { paused: st.reason ?? 'Paused' };
  }
  const feeding = feedingRules(v, full);
  const reasons: string[] = [];
  for (const k of feeding) {
    const n = full.needs[k];
    if (!n) continue;
    const st = await check(n);
    if (!st.ok) reasons.push(st.reason ?? 'Paused');
  }
  if (reasons.length === 0) return {};
  const reason = [...new Set(reasons)].join('; ');
  return reasons.length === feeding.length ? { paused: reason } : { notice: reason };
}

/** Every listed view (or only `input.only`) with its summary and data. Read-only. */
export async function readViews(d: ViewsDeps, input: ViewsInput): Promise<ComputedView[]> {
  const { snap, config, now } = input;
  const p = await d.getProgram();
  await d.closes?.ready;
  const suggestions = new Map((d.closes?.suggestions() ?? []).map((s) => [s.tabId, s]));
  const views = declaredViews(p, config, d.builtins)
    .filter((v) => (input.only === undefined || v.id === input.only) && (v.kind === 'list' || input.dupes));
  if (views.length === 0) return [];
  const live = liveProgram(p);
  const evals = new Map<number, EvalResult>();
  const evalOf = (t: TabSnap): EvalResult => {
    let ev = evals.get(t.id);
    if (!ev) evals.set(t.id, (ev = evaluateTab(live, factsOf(snap, t, d.facts?.(t.id) ?? {}), now)));
    return ev;
  };
  const full = config && d.permissions ? compileProgram(config, d.builtins).program : undefined;
  const dupes = views.some((v) => v.kind === 'duplicates') ? await input.dupes!() : undefined;
  const out: ComputedView[] = [];
  for (const v of views) {
    const data: ViewData = v.kind === 'duplicates' && dupes
      ? { kind: 'duplicates', ...dupes }
      : { kind: 'list', rows: listRows(v, snap, evalOf, suggestions) };
    const count = data.kind === 'duplicates'
      ? data.sets.reduce((n, s) => n + s.closable, 0) + data.pending.length
      : data.rows.length;
    const pause = full && d.permissions ? await pauseOf(v, full, (n) => d.permissions!.check(n)) : {};
    out.push({ view: v, data, summary: { id: v.id, tab: v.tab, kind: v.kind, actions: [...v.actions], count, ...pause } });
  }
  return out;
}
