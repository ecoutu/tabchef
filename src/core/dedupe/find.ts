import { compilePattern, PatternError } from '../match/pattern';
import { isExemptUrl, normalizeUrl } from '../url/normalize';
import type { DedupeOverride, DedupeSettings, TabSnap } from '../types';

/** The URL a tab is on or about to be on. */
export const tabUrl = (t: TabSnap): string => t.pendingUrl || t.url;

function isAllowedDuplicate(url: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (compilePattern(p)(url)) return true;
    } catch (e) {
      if (!(e instanceof PatternError)) throw e;
    }
  }
  return false;
}

/** Dedupe key for a tab, or null when it never takes part in dedupe (exempt, allow-listed, excluded incognito). */
function keyOf(url: string, incognito: boolean, s: DedupeSettings, o?: DedupeOverride): { key: string; fragment: string } | null {
  if (isExemptUrl(url)) return null;
  if (incognito && !s.includeIncognito) return null;
  if (isAllowedDuplicate(url, s.allowDuplicates)) return null;
  return normalizeUrl(url, s, o);
}

/**
 * The oldest (lowest id) tab that duplicates `newTab`, or null. Pure.
 * `newTab.url` is the candidate URL (pendingUrl is ignored for the candidate); other tabs use pendingUrl || url.
 * Pinned and `protectedIds` candidates are never deduped; a pinned tab can still be the existing tab.
 * `o` is the new tab's winning dedupe action (R25): `o.mode` wins over `s.mode` (an effective 'off' returns null) and
 * `o.keepFragment` keys every tab compared here.
 */
export function findDuplicate(
  newTab: TabSnap,
  tabs: TabSnap[],
  s: DedupeSettings,
  o?: DedupeOverride,
  protectedIds?: Set<number>,
): { existing: TabSnap; fragment: string } | null {
  if ((o?.mode ?? s.mode) === 'off') return null;
  if (newTab.pinned || protectedIds?.has(newTab.id)) return null;
  const mine = keyOf(newTab.url, newTab.incognito, s, o);
  if (!mine) return null;
  let best: TabSnap | null = null;
  for (const t of tabs) {
    if (t.id === newTab.id) continue;
    if (s.scope === 'same-window' && t.windowId !== newTab.windowId) continue;
    if (best && t.id > best.id) continue;
    if (keyOf(tabUrl(t), t.incognito, s, o)?.key === mine.key) best = t;
  }
  return best ? { existing: best, fragment: mine.fragment } : null;
}

/** All sets of 2+ tabs sharing a dedupe key; tabs within a set sorted by id ascending (index 0 = oldest), sets by size descending. */
export function findDuplicateSets(tabs: TabSnap[], s: DedupeSettings): { key: string; tabs: TabSnap[] }[] {
  const byKey = new Map<string, { key: string; tabs: TabSnap[] }>();
  for (const t of tabs) {
    const k = keyOf(tabUrl(t), t.incognito, s)?.key;
    if (k === undefined) continue;
    const bucket = s.scope === 'same-window' ? `${t.windowId}\n${k}` : k;
    let set = byKey.get(bucket);
    if (!set) byKey.set(bucket, (set = { key: k, tabs: [] }));
    set.tabs.push(t);
  }
  const sets = [...byKey.values()].filter((x) => x.tabs.length >= 2);
  for (const x of sets) x.tabs.sort((a, b) => a.id - b.id);
  return sets.sort((a, b) => b.tabs.length - a.tabs.length);
}
