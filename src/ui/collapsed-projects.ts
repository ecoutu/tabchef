// Collapsed project cards (#151): the ids of the cards shown as their header alone in the Projects tab (popup and side
// panel). Stored per device in storage.local `projects.collapsed`, shared by both pages; an id not in the set is an
// expanded card, so every project starts expanded and a missing or unreadable value expands them all.

export const COLLAPSED_PROJECTS_KEY = 'projects.collapsed';

/** The stored set: a list of non-empty ids, deduplicated; anything else is none collapsed. */
export function parseCollapsed(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** A change to the stored set, applied to its value when written (a read-modify-write), not to this page's copy. */
export type Edit = (collapsed: readonly string[]) => string[];

/** Collapses the cards `ids` (one card, or "Collapse all" over the listed cards), keeping the others' state. */
export function collapseIds(collapsed: readonly string[], ids: readonly string[]): string[] {
  const set = new Set(collapsed);
  return [...collapsed, ...ids.filter((id) => !set.has(id))];
}

/** Expands the cards `ids` (one card, or "Expand all" over the listed cards), keeping the others' state. */
export function expandIds(collapsed: readonly string[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  return collapsed.filter((id) => !set.has(id));
}

/** Drops the ids of projects not in `ids` (the listed cards), keeping the order. */
export function pruneCollapsed(collapsed: readonly string[], ids: readonly string[]): string[] {
  const listed = new Set(ids);
  return collapsed.filter((id) => listed.has(id));
}

/** Every listed card is collapsed (false with no cards): the control then reads "Expand all". */
export function allCollapsed(collapsed: readonly string[], ids: readonly string[]): boolean {
  const set = new Set(collapsed);
  return ids.length > 0 && ids.every((id) => set.has(id));
}

/** The same ids, in any order (no storage write when nothing changed). */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return a.length === b.length && b.every((id) => set.has(id));
}
