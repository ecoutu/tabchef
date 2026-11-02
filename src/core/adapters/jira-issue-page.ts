// The Jira issue page adapter (M3 T10): an issue's status and summary read from the Jira Cloud issue view itself. This
// is the only file with Jira DOM knowledge. Same contract as github-pr-page.ts.
import type { JiraIssue } from '../sources/types';
import { adapterKey, cleanText, type Adapter, type AdapterSelector } from './types';

/**
 * PROVISIONAL (M3-R57): hand-written from Atlassian's public Jira Cloud issue view markup, not yet checked against a
 * recorded page. Each list is ordered fallbacks: the first one that matches wins.
 */
export const JIRA_ISSUE_PAGE = {
  id: 'jira.issuePage',
  urlPattern: '*.atlassian.net/browse/:key*',
  selectors: {
    status: [
      { selector: '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button' },
      { selector: '[data-testid="issue-field-status.ui.status-view.status-button.status-button"]' },
    ],
    summary: [
      { selector: 'h1[data-testid="issue.views.issue-base.foundation.summary.heading"]' },
      { selector: '[data-testid="issue-view-foundation.summary.heading"]' },
    ],
  },
  parse: parseJiraIssuePage,
  /** The JiraIssue key each field's extract value is. */
  values: { status: 'status', summary: 'summary' },
} as const satisfies Adapter & { id: 'jira.issuePage'; selectors: Record<'status' | 'summary', readonly AdapterSelector[]> };

/** The issue fields in the watch's page.facts extracts (keys `adapter:jira.issuePage.<field>`); empty ones are missing. */
export function parseJiraIssuePage(extracts: Record<string, string>): Partial<JiraIssue> {
  const get = (f: keyof typeof JIRA_ISSUE_PAGE.selectors) => {
    const k = adapterKey(JIRA_ISSUE_PAGE.id, f);
    return cleanText(Object.hasOwn(extracts, k) ? extracts[k] : undefined);
  };
  const status = get('status');
  const summary = get('summary');
  return { ...(status !== undefined && { status }), ...(summary !== undefined && { summary }) };
}
