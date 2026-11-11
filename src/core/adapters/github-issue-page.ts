// The GitHub issue page adapter: an issue's open/closed state read from the page itself. This is the only file with
// GitHub issue DOM knowledge. The watch content script reads the selectors (M2's watch.config contract: text or one
// attribute, capped at 256 characters); parseIssuePage turns what it reported into GithubIssueInfo fields.
import type { GithubIssueInfo } from '../sources/types';
import { adapterKey, cleanText, type Adapter, type AdapterSelector } from './types';

/**
 * Recorded 2026-11-10 from GitHub's React issue header, rendered in Chromium for public issues (open, closed as
 * completed, closed as not planned): fixtures/m3/gh-issue-pages.synthetic.html. The selectors use GitHub's `data-*`
 * names, never the hashed class suffixes. Each list is ordered fallbacks: the first one that matches on the page wins.
 */
export const GITHUB_ISSUE_PAGE = {
  id: 'github.issuePage',
  urlPattern: 'github.com/:owner/:repo/issues/:num*',
  selectors: {
    // The header state label: data-status "issueOpened" / "issueClosed" / "issueClosedNotPlanned", text "Open" /
    // "Closed" / "Closed as not planned".
    state: [{ selector: '[data-testid="header-state"]' }, { selector: 'span[data-status^="issue"]' }, { selector: '[data-status^="issue"]', attr: 'data-status' }],
  },
  parse: parseIssuePage,
  /** The GithubIssueInfo key each field's extract value is. */
  values: { state: 'status' },
} as const satisfies Adapter & { id: 'github.issuePage'; selectors: Record<'state', readonly AdapterSelector[]> };

const OPEN_RE = /^(open|issueopened)$/;
const CLOSED_RE = /^(closed|completed|not planned|duplicate|issueclosed)\b|^issueclosed/;

/**
 * The issue's state fields in the watch's page.facts extracts (key `adapter:github.issuePage.state`). `{}` for a
 * missing or unrecognized label, so a page that is not read never claims a state.
 */
export function parseIssuePage(extracts: Record<string, string>): Partial<Pick<GithubIssueInfo, 'status' | 'statusCategory'>> {
  const k = adapterKey(GITHUB_ISSUE_PAGE.id, 'state');
  const s = cleanText(Object.hasOwn(extracts, k) ? extracts[k] : undefined)?.toLowerCase().replace(/^status:\s*/, '');
  if (s === undefined) return {};
  if (OPEN_RE.test(s)) return { status: 'Open', statusCategory: 'new' };
  return CLOSED_RE.test(s) ? { status: 'Closed', statusCategory: 'done' } : {};
}
