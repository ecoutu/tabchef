// Options page hash routing (ruling R28): longest-prefix match with params. A route path is `/`-separated segments;
// a `:name` segment captures one non-empty segment. The route whose segments are a prefix of the hash's and that has
// the most segments wins; query parameters (`?a=1&b=2`) are params too. Nothing matches → `/rules`.

export interface RouteMatch { path: string; params: Record<string, string> }

const FALLBACK = '/rules';
const segments = (p: string): string[] => p.split('/').filter((s) => s !== '');
const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Match `hash` (`#/explain/7`, with or without `#`) against `routes`. */
export function matchRoute(routes: readonly { path: string }[], hash: string): RouteMatch {
  const h = hash.replace(/^#/, '');
  const qi = h.indexOf('?');
  const segs = segments(qi < 0 ? h : h.slice(0, qi)).map(decode);
  let best: { path: string; params: Record<string, string>; n: number } | undefined;
  for (const r of routes) {
    const rs = segments(r.path);
    if (rs.length === 0 || rs.length > segs.length || (best && best.n >= rs.length)) continue;
    const params: Record<string, string> = {};
    const ok = rs.every((s, i) => {
      if (s.startsWith(':')) { params[s.slice(1)] = segs[i] as string; return true; }
      return s === segs[i];
    });
    if (ok) best = { path: r.path, params, n: rs.length };
  }
  if (!best) return { path: FALLBACK, params: {} };
  const query: Record<string, string> = {};
  if (qi >= 0) for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) query[k] = v;
  return { path: best.path, params: { ...query, ...best.params } };
}

export { explainHash, newRuleHash, type NewRuleKind } from '../core/links';
