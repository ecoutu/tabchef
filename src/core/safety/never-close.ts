// The tabs Tabchef never closes, by any path (auto-close, banners, dedupe, the popup): pinned and locked tabs (spec
// §6.9, ruling R71) and anchor tabs (R11). Callers decide what happens instead (skip, suggest, refuse).

export type NeverCloseReason = 'pinned' | 'locked' | 'anchor';

export interface NeverCloseDeps {
  isLocked: (tabId: number) => boolean;
  isAnchor?: (tabId: number) => boolean;
}

/** Why `tab` must never be closed, or undefined when it may be. */
export function neverCloseReason(tab: { id: number; pinned: boolean }, d: NeverCloseDeps): NeverCloseReason | undefined {
  if (tab.pinned) return 'pinned';
  if (d.isLocked(tab.id)) return 'locked';
  if (d.isAnchor?.(tab.id)) return 'anchor';
  return undefined;
}
