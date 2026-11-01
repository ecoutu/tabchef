import type { DedupeSettings } from '../types';
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
  'stripParams' | 'stripFragment' | 'ignoreTrailingSlash' | 'canonicalizers' | 'urlTransforms'
>;

function shouldStrip(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

export function normalizeUrl(
  url: string,
  s: NormSettings,
): { key: string; fragment: string } | null {
  try {
    let u = parse(url);
    if (!u || EXEMPT_PROTOCOLS.has(u.protocol)) return null;

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

    if (s.stripFragment) u.hash = '';

    let key = u.href;
    for (const t of s.urlTransforms) {
      let re: RegExp;
      try {
        re = new RegExp(t.pattern, t.flags);
      } catch {
        continue;
      }
      key = key.replace(re, t.replacement);
    }
    return { key, fragment };
  } catch {
    return null;
  }
}
