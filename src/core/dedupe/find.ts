import { compilePattern, PatternError } from '../match/pattern';
import { firstOverride, isExemptUrl, normalizeUrl } from '../url/normalize';
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
 * Whether duplicates of a tab on `url` must also have equal titles (T18). Precedence, as the brief orders it: the first
 * `s.titleOverrides` entry matching `url` (the original URL), then the per-rule `o.matchTitle` (R25), then `s.matchTitle`.
 */
export function matchTitleFor(url: string, s: DedupeSettings, o?: DedupeOverride): boolean {
  return firstOverride(url, s.titleOverrides)?.matchTitle ?? o?.matchTitle ?? s.matchTitle;
}

/** `s`/`o` with title matching switched off entirely (no global, per-rule or per-site title check). */
export function withoutTitle(s: DedupeSettings, o?: DedupeOverride): { s: DedupeSettings; o: DedupeOverride } {
  return { s: { ...s, matchTitle: false, titleOverrides: [] }, o: { ...o, matchTitle: false } };
}

/**
 * The pairwise test shared by the engine (findDuplicate) and the popup (findDuplicateSets), apart from the key:
 * `other` can duplicate the candidate when it is another tab, in the same window under same-window scope, and, when
 * `titled`, both titles are non-empty and equal (R18). The keys must also be equal under the CANDIDATE's override.
 */
function pairOk(cand: TabSnap, titled: boolean, other: TabSnap, s: DedupeSettings): boolean {
  if (other.id === cand.id) return false;
  if (s.scope === 'same-window' && other.windowId !== cand.windowId) return false;
  return !titled || (cand.title !== '' && other.title === cand.title);
}

/**
 * The oldest (lowest id) tab that duplicates `newTab`, or null. Pure.
 * `newTab.url` is the candidate URL (pendingUrl is ignored for the candidate); other tabs use pendingUrl || url.
 * Pinned and `protectedIds` candidates are never deduped; a pinned tab can still be the existing tab.
 * `o` is the new tab's winning dedupe action (R25): `o.mode` wins over `s.mode` (an effective 'off' returns null),
 * `o.keepFragment` keys every tab compared here, and `matchTitleFor(newTab.url, s, o)` decides whether titles must
 * match too (key + '\u0000' + title; an empty title never matches).
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
  const titled = matchTitleFor(newTab.url, s, o);
  let best: TabSnap | null = null;
  for (const t of tabs) {
    if (best && t.id > best.id) continue;
    if (pairOk(newTab, titled, t, s) && keyOf(tabUrl(t), t.incognito, s, o)?.key === mine.key) best = t;
  }
  return best ? { existing: best, fragment: mine.fragment } : null;
}

/**
 * All sets of 2+ tabs that are duplicates; tabs within a set sorted by id ascending (index 0 = oldest), sets by size
 * descending (then oldest tab). `overrideOf` (M2 T17) is each tab's winning dedupe action (R25), as the engine decides
 * it. A set links each tab to the oldest OLDER tab it duplicates by the engine's own pairwise test (findDuplicate's,
 * with that tab as the candidate and its override applied to both tabs), so a listed extra is exactly a tab the engine
 * would treat as a duplicate if it were new. A tab whose override mode is 'off' is never an extra (it can still be the
 * kept tab of another). Unlike findDuplicate, the global mode and pinned/protected tabs are not filtered here (callers
 * skip them when closing). `key` is unique per set.
 */
export function findDuplicateSets(
  tabs: TabSnap[], s: DedupeSettings, overrideOf?: (t: TabSnap) => DedupeOverride | undefined,
): { key: string; tabs: TabSnap[] }[] {
  const sorted = [...tabs].sort((a, b) => a.id - b.id);
  // Only keepFragment changes another tab's key under a candidate's override: index tabs once per variant (O(n)).
  const variants = new Map<string, Map<string, TabSnap[]>>();
  const bucketOf = (t: TabSnap, key: string): string => (s.scope === 'same-window' ? `${t.windowId}\n${key}` : key);
  const index = (o?: DedupeOverride): Map<string, TabSnap[]> => {
    const v = String(o?.keepFragment);
    let m = variants.get(v);
    if (!m) {
      variants.set(v, (m = new Map()));
      for (const t of sorted) {
        const k = keyOf(tabUrl(t), t.incognito, s, o)?.key;
        if (k === undefined) continue;
        const b = bucketOf(t, k);
        const list = m.get(b);
        if (list) list.push(t);
        else m.set(b, [t]);
      }
    }
    return m;
  };
  const parent = new Map<number, number>();
  const root = (id: number): number => {
    let r = id;
    while (parent.has(r)) r = parent.get(r) as number;
    return r;
  };
  const keyOfRoot = new Map<number, string>();
  for (const t of sorted) {
    const o = overrideOf?.(t);
    if (o?.mode === 'off') continue;
    const mine = keyOf(tabUrl(t), t.incognito, s, o);
    if (!mine) continue;
    const titled = matchTitleFor(tabUrl(t), s, o);
    const older = (index(o).get(bucketOf(t, mine.key)) ?? []).find((x) => x.id < t.id && pairOk(t, titled, x, s)); // same bucket: same key
    if (!older) continue;
    const a = root(older.id);
    const b = root(t.id);
    if (a === b) continue;
    const [keep, join] = a < b ? [a, b] : [b, a];
    parent.set(join, keep);
    if (!keyOfRoot.has(keep)) keyOfRoot.set(keep, titled ? `${mine.key}\u0000${t.title}` : mine.key);
    keyOfRoot.delete(join);
  }
  const byRoot = new Map<number, TabSnap[]>();
  for (const t of sorted) {
    if (!parent.has(t.id) && !keyOfRoot.has(t.id)) continue;
    const r = root(t.id);
    const list = byRoot.get(r);
    if (list) list.push(t);
    else byRoot.set(r, [t]);
  }
  const used = new Set<string>();
  const sets = [...byRoot.entries()].map(([r, members]) => {
    let key = keyOfRoot.get(r) ?? String(r);
    if (used.has(key)) key = `${key}\n${r}`;
    used.add(key);
    return { key, tabs: members };
  });
  return sets.sort((a, b) => b.tabs.length - a.tabs.length || (a.tabs[0] as TabSnap).id - (b.tabs[0] as TabSnap).id);
}
