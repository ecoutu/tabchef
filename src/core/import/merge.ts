import type { DedupeSettings } from '../types';

const LISTS = ['allowDuplicates', 'alwaysSwitchSites', 'stripParams'] as const;
const SCALARS = ['scope', 'stripFragment', 'ignoreTrailingSlash', 'followFragment', 'includeIncognito', 'mode', 'matchTitle'] as const;
/** Object lists merged by key: urlTransforms by (pattern, replacement, flags); overrides by pattern (current wins). */
const OBJECT_LISTS = {
  urlTransforms: (t: DedupeSettings['urlTransforms'][number]): string => JSON.stringify([t.pattern, t.replacement, t.flags ?? '']),
  fragmentOverrides: (t: DedupeSettings['fragmentOverrides'][number]): string => t.pattern,
  titleOverrides: (t: DedupeSettings['titleOverrides'][number]): string => t.pattern,
} as const;

/** Merges imported dedupe fields into the current settings without dropping existing entries. */
export function mergeDedupe(current: DedupeSettings, incoming: Partial<DedupeSettings>): { merged: DedupeSettings; changes: string[] } {
  const merged: DedupeSettings = { ...current };
  const changes: string[] = [];
  for (const k of LISTS) {
    const inc = incoming[k];
    if (!inc) continue;
    const next = [...new Set([...current[k], ...inc])];
    const added = next.length - current[k].length;
    if (added > 0) { merged[k] = next; changes.push(`${k}: +${added} (${next.slice(current[k].length).join(', ')})`); }
  }
  for (const k of Object.keys(OBJECT_LISTS) as (keyof typeof OBJECT_LISTS)[]) {
    const inc = incoming[k] as { pattern: string }[] | undefined;
    if (!inc) continue;
    const key = OBJECT_LISTS[k] as (t: { pattern: string }) => string;
    const cur = current[k] as { pattern: string }[];
    const seen = new Set(cur.map(key));
    const add = inc.filter((t) => !seen.has(key(t)) && seen.add(key(t)));
    if (add.length) { (merged as unknown as Record<string, unknown>)[k] = [...cur, ...add]; changes.push(`${k}: +${add.length}`); }
  }
  for (const k of SCALARS) {
    const v = incoming[k];
    if (v !== undefined && v !== current[k]) {
      (merged as unknown as Record<string, unknown>)[k] = v;
      changes.push(`${k}: ${String(current[k])} → ${String(v)}`);
    }
  }
  return { merged, changes };
}
