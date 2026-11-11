// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import pages from '../../../fixtures/m3/gh-issue-pages.synthetic.html?raw';
import { GITHUB_ISSUE_PAGE, parseIssuePage } from '../../../src/core/adapters/github-issue-page';
import { adapterProgram, extractFixture } from './watch-fixture';

const URL = 'https://github.com/acme/api/issues/7';
const program = adapterProgram('github.issuePage', ['state']);
const read = async (html: string, url = URL) => parseIssuePage(await extractFixture(html, url, program));
const ex = (state: string): Record<string, string> => ({ 'adapter:github.issuePage.state': state });
const OPEN = { status: 'Open', statusCategory: 'new' };
const CLOSED = { status: 'Closed', statusCategory: 'done' };

describe('GitHub issue page adapter: saved pages through the watch extraction', () => {
  it("GitHub's current React header (2026-11): open, closed as completed, closed as not planned", async () => {
    const [open, completed, notPlanned] = pages.split('<!--page-->');
    expect(await read(open!)).toEqual(OPEN);
    expect(await read(completed!)).toEqual(CLOSED);
    expect(await read(notPlanned!)).toEqual(CLOSED);
  });

  it('unknown markup gives nothing (the word Open elsewhere on the page is not a state)', async () => {
    expect(await read('<p>Open</p><span>Closed</span>')).toEqual({});
  });

  it('not an issue URL: no selectors are sent, so nothing is read', async () => {
    expect(await extractFixture(pages, 'https://github.com/acme/api/pull/7', program)).toEqual({});
  });
});

describe('parseIssuePage', () => {
  it('Open is new; Closed, Completed, Not planned and Duplicate are done, case-insensitively', () => {
    expect(parseIssuePage(ex(' open '))).toEqual(OPEN);
    for (const t of ['Closed', 'Completed', 'Not planned', 'Duplicate', 'Closed as not planned', 'Status: Closed', 'CLOSED']) {
      expect(parseIssuePage(ex(t))).toEqual(CLOSED);
    }
  });

  it('a data-status value reads like its text', () => {
    expect(parseIssuePage(ex('issueOpened'))).toEqual(OPEN);
    expect(parseIssuePage(ex('issueClosedNotPlanned'))).toEqual(CLOSED);
  });

  it('unrecognized or missing state is {}', () => {
    expect(parseIssuePage(ex('Open soon'))).toEqual({});
    expect(parseIssuePage(ex('Merged'))).toEqual({});
    expect(parseIssuePage(ex(''))).toEqual({});
    expect(parseIssuePage({})).toEqual({});
  });

  it('the adapter declares ordered fallbacks for state, its URL pattern and its value', () => {
    expect(GITHUB_ISSUE_PAGE.id).toBe('github.issuePage');
    expect(GITHUB_ISSUE_PAGE.urlPattern).toBe('github.com/:owner/:repo/issues/:num*');
    expect(Object.keys(GITHUB_ISSUE_PAGE.selectors)).toEqual(['state']);
    expect(GITHUB_ISSUE_PAGE.selectors.state.length).toBeGreaterThan(1);
    expect(GITHUB_ISSUE_PAGE.values).toEqual({ state: 'status' });
  });
});
