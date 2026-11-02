// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import issue from '../../../fixtures/m3/jira-issue-page.synthetic.html?raw';
import unknown from '../../../fixtures/m3/gh-pr-unknown-page.synthetic.html?raw';
import { JIRA_ISSUE_PAGE, parseJiraIssuePage } from '../../../src/core/adapters/jira-issue-page';
import { adapterProgram, extractFixture } from './watch-fixture';

const URL = 'https://acme.atlassian.net/browse/ABC-12';
const program = adapterProgram('jira.issuePage', ['status', 'summary']);

describe('Jira issue page adapter: a saved page through the watch extraction', () => {
  it('gives the status and the summary (whitespace collapsed)', async () => {
    expect(parseJiraIssuePage(await extractFixture(issue, URL, program))).toEqual({ status: 'In Progress', summary: 'Retry the flaky checkout test' });
    expect(parseJiraIssuePage(await extractFixture(issue, `${URL}?focusedCommentId=1`, program)).status).toBe('In Progress');
  });

  it('unknown markup gives neither; a non-issue URL is sent no selectors', async () => {
    expect(parseJiraIssuePage(await extractFixture(unknown, URL, program))).toEqual({});
    expect(await extractFixture(issue, 'https://acme.atlassian.net/jira/your-work', program)).toEqual({});
  });
});

describe('parseJiraIssuePage', () => {
  it('empty values are missing', () => {
    expect(parseJiraIssuePage({ 'adapter:jira.issuePage.status': '  ', 'adapter:jira.issuePage.summary': '' })).toEqual({});
  });

  it('the adapter declares status and summary fallbacks and its URL pattern', () => {
    expect(JIRA_ISSUE_PAGE.id).toBe('jira.issuePage');
    expect(JIRA_ISSUE_PAGE.urlPattern).toBe('*.atlassian.net/browse/:key*');
    expect(Object.keys(JIRA_ISSUE_PAGE.selectors)).toEqual(['status', 'summary']);
  });
});
