// The GitHub pull request page adapter (M3 T10): a PR's state and head branch read from the page itself. This is the
// only file with GitHub DOM knowledge. The watch content script reads the selectors (M2's watch.config contract:
// text or one attribute, capped at 256 characters); parsePrPage turns what it reported into PrInfo fields.
import type { PrInfo, PrState } from '../sources/types';
import { adapterKey, cleanText, type Adapter, type AdapterSelector } from './types';

/**
 * Recorded 2026-11-03 from GitHub's React PR header, rendered in Chromium for public PRs (open fork head, merged,
 * closed): fixtures/m3/gh-pr-react-pages.synthetic.html. The selectors use GitHub's `data-*` component names, never the
 * hashed class suffixes. The classic markup (`.gh-header-meta`, M3-R57's hand-written guess) stays as the last
 * fallback. Each list is ordered fallbacks: the first one that matches on the page wins.
 */
export const GITHUB_PR_PAGE = {
  id: 'github.prPage',
  urlPattern: 'github.com/:owner/:repo/pull/:num*',
  selectors: {
    // The header state label: data-status "pullOpened" / "pullMerged" / ..., text "Open" / "Merged" / "Closed" / "Draft".
    state: [{ selector: 'span[data-status^="pull"]' }, { selector: '[data-status]' }, { selector: '.gh-header-meta .State', attr: 'title' }, { selector: '.gh-header-meta .State' }],
    // "… into <base> from <head>": the base link comes first, the head link sits in the wrapper after it (with the
    // "Copy head branch name" button). Text "branch" (same repo) or "owner:branch" (a fork).
    branch: [
      { selector: 'a[data-component="BranchName"] ~ div > a[data-component="BranchName"]' },
      { selector: '.gh-header-meta .head-ref', attr: 'title' }, { selector: '.gh-header-meta .head-ref' },
    ],
  },
  parse: parsePrPage,
  /** The PrInfo key each field's extract value is. */
  values: { state: 'state', branch: 'headRefName' },
} as const satisfies Adapter & { id: 'github.prPage'; selectors: Record<'state' | 'branch', readonly AdapterSelector[]> };

const STATES: ReadonlySet<string> = new Set<PrState>(['open', 'draft', 'merged', 'closed']);

function stateOf(text: string | undefined): PrState {
  const s = cleanText(text)?.toLowerCase().replace(/^status:\s*/, '');
  return s !== undefined && STATES.has(s) ? (s as PrState) : 'unknown';
}

/** A branch name has no ':' and no whitespace: the part after the last ':' of the head ref text. */
function branchOf(text: string | undefined): string | undefined {
  const b = text?.slice(text.lastIndexOf(':') + 1).trim();
  return b && !/\s/.test(b) ? b : undefined;
}

/**
 * The PR fields in the watch's page.facts extracts (keys `adapter:github.prPage.<field>`). `state` is always set:
 * a missing or unrecognized badge is 'unknown', never 'open'.
 */
export function parsePrPage(extracts: Record<string, string>): Partial<PrInfo> {
  const get = (f: keyof typeof GITHUB_PR_PAGE.selectors) => {
    const k = adapterKey(GITHUB_PR_PAGE.id, f);
    return Object.hasOwn(extracts, k) ? extracts[k] : undefined;
  };
  const headRefName = branchOf(get('branch'));
  return { state: stateOf(get('state')), ...(headRefName !== undefined && { headRefName }) };
}
