// Options page hash routing (ruling R28): longest-prefix match with params. A route path is `/`-separated segments;
// a `:name` segment captures one non-empty segment. The route whose segments are a prefix of the hash's and that has
// the most segments wins; query parameters (`?a=1&b=2`) are params too. Nothing matches → `/rules`.
import { repoFileUrl } from '../core/project';

export interface RouteMatch { path: string; params: Record<string, string> }

/** A page of the options page. */
export type OptionsPage = 'rules' | 'recipes' | 'dedupe' | 'history' | 'backups' | 'import' | 'explain' | 'newRule' | 'connections' | 'projects' | 'projectHome';

/**
 * The options page's route table. To add a page, add one entry here; the nav and hash routing pick it up, and
 * `npm run check:terms` learns its label. `nav: false` keeps a route out of the nav.
 */
export const OPTIONS_ROUTES: readonly { path: string; label: string; page: OptionsPage; nav?: false }[] = [
  { path: '/rules', label: 'Rules', page: 'rules' },
  { path: '/recipes', label: 'Recipes', page: 'recipes' },
  // Projects: the list of open projects and, per project, its home (M4, projectHomeHash).
  { path: '/projects', label: 'Projects', page: 'projects' },
  { path: '/project/:id', label: 'Project', page: 'projectHome', nav: false },
  { path: '/dedupe', label: 'Duplicates', page: 'dedupe' },
  { path: '/history', label: 'History', page: 'history' },
  { path: '/backups', label: 'Backups', page: 'backups' },
  { path: '/import', label: 'Import', page: 'import' },
  // The conflict view (M2 T14): linked from History rows and T16's "Why is this tab here?" (explainHash).
  { path: '/explain/:tabId', label: 'Why is this tab here?', page: 'explain', nav: false },
  // A pre-filled rule from the context menu (M2 T16, newRuleHash); longest prefix wins over /rules (R28).
  { path: '/rules/new', label: 'New rule', page: 'newRule', nav: false },
  // Connections: sign in to GitHub and Jira; needs no config.
  { path: '/connections', label: 'Connections', page: 'connections' },
  // ROUTE-INSERT-POINT
];

/** The public guide to recipes and rules (docs/recipes.md), linked from the Rules and Recipes pages' intro text. */
export const RECIPES_GUIDE_URL = repoFileUrl('docs/recipes.md');

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

export { explainHash, newProjectHash, newRuleHash, projectHomeHash, type NewRuleKind } from '../core/links';
