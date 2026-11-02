// Popup tabs (M2 T17): one tab per recipe-declared view (views.list), in the user's order; the views past
// `visibleCount` go under "More ▾". Order and visible count are popup preferences in storage.local `popup.prefs`
// (ruling R20 as amended), not Config: reordering must not change configRev.

/** A view as the popup gets it from views.list (only the fields the model reads). */
export interface PopupViewInput { id: string; tab: string; count: number; paused?: string; notice?: string }

export interface PopupPrefs { tabOrder?: string[]; visibleCount?: number }
export const POPUP_PREFS_KEY = 'popup.prefs';
export const DEFAULT_VISIBLE_COUNT = 5;

export interface PopupModelInput extends PopupPrefs {
  views: PopupViewInput[];
  paused: boolean;
  recentCount: number;
  lastTab?: string;
}

export interface PopupTab { id: string; label: string; count: number; faded: boolean; paused?: string; notice?: string }

export interface PopupModel {
  tabs: PopupTab[];
  /** Overflow views, listed under "More ▾". */
  more: { id: string; label: string; count: number }[];
  /** The open view: the last-used one when it still exists (visible or overflow), else the first; '' with no views. */
  activeTab: string;
  /** `total`: the sum of every view's count, visible and overflow (the toolbar badge's number, R20). */
  header: { paused: boolean; total: number; recentCount: number };
}

/** Stored popup.prefs, keeping only well-formed fields (a bad or missing value falls back to the defaults). */
export function parsePopupPrefs(v: unknown): PopupPrefs {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const x = v as Record<string, unknown>;
  const out: PopupPrefs = {};
  if (Array.isArray(x.tabOrder) && x.tabOrder.every((id) => typeof id === 'string')) out.tabOrder = x.tabOrder as string[];
  if (typeof x.visibleCount === 'number' && Number.isInteger(x.visibleCount)) out.visibleCount = x.visibleCount;
  return out;
}

/** `ids` in `order` first (unknown ids skipped), then the rest in their own order. */
function ordered<T extends { id: string }>(items: T[], order: string[] = []): T[] {
  const byId = new Map(items.map((x) => [x.id, x]));
  const first = [...new Set(order)].flatMap((id) => byId.get(id) ?? []);
  const placed = new Set(first.map((x) => x.id));
  return [...first, ...items.filter((x) => !placed.has(x.id))];
}

export function buildPopupModel(input: PopupModelInput): PopupModel {
  const all = ordered(input.views, input.tabOrder).map((v): PopupTab => ({
    id: v.id, label: v.tab, count: v.count, faded: v.count === 0 || v.paused !== undefined,
    ...(v.paused !== undefined && { paused: v.paused }), ...(v.notice !== undefined && { notice: v.notice }),
  }));
  const n = Number.isInteger(input.visibleCount) ? Math.max(1, input.visibleCount as number) : DEFAULT_VISIBLE_COUNT;
  const tabs = all.slice(0, n);
  const more = all.slice(n).map((t) => ({ id: t.id, label: t.label, count: t.count }));
  const activeTab = all.find((t) => t.id === input.lastTab)?.id ?? all[0]?.id ?? '';
  return { tabs, more, activeTab, header: { paused: input.paused, total: all.reduce((s, t) => s + t.count, 0), recentCount: input.recentCount } };
}
