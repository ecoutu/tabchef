import type { PendingAsk } from '../engine/ask';

export interface PopupTabDef { id: string; label: string }

/** Recipe tabs shown in the popup; later milestones append entries. */
export const TAB_REGISTRY: PopupTabDef[] = [{ id: 'duplicates', label: 'Duplicates' }];

export interface PopupModelInput {
  dupes: { key: string }[];
  pending: PendingAsk[];
  paused: boolean;
  recentCount: number;
  lastTab?: string;
}

export interface PopupModel {
  tabs: { id: string; label: string; count: number; faded: boolean }[];
  activeTab: string;
  header: { paused: boolean; total: number; recentCount: number };
}

const COUNTERS: Record<string, (i: PopupModelInput) => number> = {
  duplicates: (i) => i.dupes.length + i.pending.length,
};

export function buildPopupModel(input: PopupModelInput, registry: PopupTabDef[] = TAB_REGISTRY): PopupModel {
  const tabs = registry.map((t) => {
    const count = COUNTERS[t.id]?.(input) ?? 0;
    return { id: t.id, label: t.label, count, faded: count === 0 };
  });
  const activeTab = tabs.find((t) => t.id === input.lastTab)?.id ?? tabs[0]!.id;
  return { tabs, activeTab, header: { paused: input.paused, total: tabs.reduce((n, t) => n + t.count, 0), recentCount: input.recentCount } };
}
