// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import open from '../../../fixtures/m3/gh-pr-open-page.synthetic.html?raw';
import draft from '../../../fixtures/m3/gh-pr-draft-page.synthetic.html?raw';
import merged from '../../../fixtures/m3/gh-pr-merged-page.synthetic.html?raw';
import closed from '../../../fixtures/m3/gh-pr-closed-page.synthetic.html?raw';
import unknown from '../../../fixtures/m3/gh-pr-unknown-page.synthetic.html?raw';
import react from '../../../fixtures/m3/gh-pr-react-pages.synthetic.html?raw';
import { GITHUB_PR_PAGE, parsePrPage } from '../../../src/core/adapters/github-pr-page';
import { adapterProgram, extractFixture } from './watch-fixture';

const URL = 'https://github.com/acme/api/pull/7';
const program = adapterProgram('github.prPage', ['state', 'branch']);
const read = async (html: string, url = URL) => parsePrPage(await extractFixture(html, url, program));
const ex = (state?: string, branch?: string) => ({
  ...(state !== undefined && { 'adapter:github.prPage.state': state }),
  ...(branch !== undefined && { 'adapter:github.prPage.branch': branch }),
});

describe('GitHub PR page adapter: saved pages through the watch extraction', () => {
  it('open, draft, merged and closed pages give their state and head branch', async () => {
    expect(await read(open)).toEqual({ state: 'open', headRefName: 'feature/PROJ-12-retry' });
    expect(await read(draft)).toEqual({ state: 'draft', headRefName: 'wip/PROJ-13' }); // no title attrs: text fallback
    expect(await read(merged)).toEqual({ state: 'merged', headRefName: 'feature/PROJ-12-retry' });
    expect(await read(closed)).toEqual({ state: 'closed', headRefName: 'fix-typo' }); // fork head: owner prefix dropped
  });

  it("GitHub's current React header (2026-11): the state label and the HEAD branch (not the base), fork owner dropped", async () => {
    const [openFork, merged2] = react.split('<!--page-->');
    expect(await read(openFork!)).toEqual({ state: 'open', headRefName: 'feat/abc-12/new-parser' });
    expect(await read(merged2!)).toEqual({ state: 'merged', headRefName: 'docs/ABC-34' });
  });

  it('the files tab of a PR is a PR page too', async () => {
    expect((await read(merged, `${URL}/files`)).state).toBe('merged');
  });

  it('unknown markup gives state unknown, never open (the word Open elsewhere on the page is not a state)', async () => {
    expect(await read(unknown)).toEqual({ state: 'unknown' });
  });

  it('not a PR URL: no selectors are sent, so nothing is read', async () => {
    expect(await extractFixture(merged, 'https://github.com/acme/api/issues/7', program)).toEqual({});
  });
});

describe('parsePrPage', () => {
  it('reads the state badge text or its "Status: X" title, case-insensitively', () => {
    expect(parsePrPage(ex('Status: Merged')).state).toBe('merged');
    expect(parsePrPage(ex('  draft ')).state).toBe('draft');
    expect(parsePrPage(ex('Closed')).state).toBe('closed');
  });

  it('an unrecognized or missing state is unknown', () => {
    expect(parsePrPage(ex('Queued')).state).toBe('unknown');
    expect(parsePrPage(ex('Open soon')).state).toBe('unknown');
    expect(parsePrPage({}).state).toBe('unknown');
  });

  it('the branch is the part after the last ":" (owner/repo:branch, owner:branch or branch); whitespace is not a branch', () => {
    expect(parsePrPage(ex(undefined, 'acme/api:feat/x')).headRefName).toBe('feat/x');
    expect(parsePrPage(ex(undefined, 'octocat : fix-typo')).headRefName).toBe('fix-typo');
    expect(parsePrPage(ex(undefined, 'feat/x')).headRefName).toBe('feat/x');
    expect(parsePrPage(ex(undefined, 'unknown repository'))).not.toHaveProperty('headRefName');
    expect(parsePrPage(ex(undefined, 'acme/api:'))).not.toHaveProperty('headRefName');
  });

  it('the adapter declares ordered fallbacks for state and branch, and its URL pattern', () => {
    expect(GITHUB_PR_PAGE.id).toBe('github.prPage');
    expect(GITHUB_PR_PAGE.urlPattern).toBe('github.com/:owner/:repo/pull/:num*');
    expect(Object.keys(GITHUB_PR_PAGE.selectors)).toEqual(['state', 'branch']);
    expect(GITHUB_PR_PAGE.selectors.state.length).toBeGreaterThan(1);
  });
});
