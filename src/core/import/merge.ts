import type { DedupeSettings } from '../types';

const LISTS = ['allowDuplicates', 'alwaysSwitchSites', 'stripParams'] as const;
const SCALARS = ['scope', 'stripFragment', 'ignoreTrailingSlash', 'followFragment', 'includeIncognito', 'mode'] as const;
type Transform = DedupeSettings['urlTransforms'][number];
const tkey = (t: Transform): string => JSON.stringify([t.pattern, t.replacement, t.flags ?? '']);

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
  if (incoming.urlTransforms) {
    const seen = new Set(current.urlTransforms.map(tkey));
    const add = incoming.urlTransforms.filter((t) => !seen.has(tkey(t)) && seen.add(tkey(t)));
    if (add.length) { merged.urlTransforms = [...current.urlTransforms, ...add]; changes.push(`urlTransforms: +${add.length}`); }
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
