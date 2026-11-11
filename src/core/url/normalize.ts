import type { DedupeOverride, DedupeSettings } from '../types';
import { compilePattern, PatternError } from '../match/pattern';
import { canonicalizers } from './canonicalizers';

const EXEMPT_PROTOCOLS = new Set([
  'chrome:', 'chrome-extension:', 'about:', 'devtools:', 'view-source:', 'file:',
  'edge:', 'data:', 'blob:', 'javascript:',
]);

function parse(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isExemptUrl(url: string | undefined): boolean {
  const u = parse(url);
  return !u || EXEMPT_PROTOCOLS.has(u.protocol);
}

type NormSettings = Pick<
  DedupeSettings,
  'stripParams' | 'stripFragment' | 'ignoreTrailingSlash' | 'canonicalizers' | 'urlTransforms' | 'fragmentOverrides'
>;

/**
 * The first entry whose url pattern matches `url` (invalid patterns are skipped), or undefined. Shared by
 * fragmentOverrides (here) and titleOverrides (find.ts); both match the ORIGINAL url (T18↔T6).
 */
export function firstOverride<E extends { pattern: string }>(url: string, entries: readonly E[]): E | undefined {
  for (const e of entries) {
    try {
      if (compilePattern(e.pattern)(url)) return e;
    } catch (err) {
      if (!(err instanceof PatternError)) throw err;
    }
  }
  return undefined;
}

function shouldStrip(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

// Case-conversion markers for a urlTransform replacement's `\L` and `\E`: private-use characters, which a URL's href
// never holds (the URL parser percent-encodes them).
const LOWER = '\uE000';
const END = '\uE001';

/**
 * `key` with `re` replaced by `replacement`. As in sed or an editor's regex replace, `\L` in the replacement lower-cases
 * the text that follows it, up to `\E` or the end of the replacement (a recipe folds a case-insensitive part of a URL,
 * such as GitHub's owner/repo). Only the replaced text changes case; the rest of the key keeps it.
 */
function applyTransform(key: string, re: RegExp, replacement: string): string {
  if (!replacement.includes('\\L')) return key.replace(re, replacement);
  const marked = `${replacement.replaceAll('\\L', LOWER).replaceAll('\\E', END)}${END}`;
  let out = '';
  let lower = false;
  for (const ch of key.replace(re, marked)) {
    if (ch === LOWER) lower = true;
    else if (ch === END) lower = false;
    else out += lower ? ch.toLowerCase() : ch;
  }
  return out;
}

/**
 * Dedupe key of `url` and its #fragment, or null for exempt/unparseable URLs. Whether the fragment stays in the key
 * (T18↔T6), decided on the original `url` before canonicalizers and urlTransforms: the per-rule `o.keepFragment`
 * (R25), else the first matching `s.fragmentOverrides` entry, else `!s.stripFragment`.
 */
export function normalizeUrl(
  url: string,
  s: NormSettings,
  o?: Pick<DedupeOverride, 'keepFragment'>,
): { key: string; fragment: string } | null {
  try {
    let u = parse(url);
    if (!u || EXEMPT_PROTOCOLS.has(u.protocol)) return null;
    const keepFragment = o?.keepFragment ?? firstOverride(url, s.fragmentOverrides)?.keepFragment ?? !s.stripFragment;

    for (const id of s.canonicalizers) {
      const fn = Object.hasOwn(canonicalizers, id) ? canonicalizers[id] : undefined;
      if (fn) u = fn(u);
    }

    const fragment = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;

    const params = new URLSearchParams(u.search);
    const kept = [...params.entries()].filter(([k]) => !shouldStrip(k, s.stripParams));
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // stable
    const next = new URLSearchParams(kept).toString();
    u.search = next;

    if (s.ignoreTrailingSlash && u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    }

    if (!keepFragment) u.hash = '';

    let key = u.href;
    for (const t of s.urlTransforms) {
      let re: RegExp;
      try {
        re = new RegExp(t.pattern, t.flags);
      } catch {
        continue;
      }
      key = applyTransform(key, re, t.replacement);
    }
    return { key, fragment };
  } catch {
    return null;
  }
}
