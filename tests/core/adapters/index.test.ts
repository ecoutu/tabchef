// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterKey, adapterValue } from '../../../src/core/adapters';
import { GITHUB_PR_PAGE } from '../../../src/core/adapters/github-pr-page';
import { JIRA_ISSUE_PAGE } from '../../../src/core/adapters/jira-issue-page';
import { adapterProgram, extractFixture } from './watch-fixture';

describe('ADAPTERS', () => {
  it('lists the GitHub PR page and Jira issue page adapters by id', () => {
    expect(Object.keys(ADAPTERS)).toEqual(['github.prPage', 'github.issuePage', 'jira.issuePage']);
    expect(ADAPTERS['github.prPage'].selectors).toBe(GITHUB_PR_PAGE.selectors);
    expect(ADAPTERS['jira.issuePage'].selectors).toBe(JIRA_ISSUE_PAGE.selectors);
  });

  it('page.facts keys are adapter:<id>.<field>', () => {
    expect(adapterKey('github.prPage', 'state')).toBe('adapter:github.prPage.state');
  });
});

describe('adapterValue (the {adapter, field} extract value)', () => {
  const k = (f: string) => adapterKey('github.prPage', f);
  it('a field is its parsed value: state, and branch as the head ref name', () => {
    expect(adapterValue('github.prPage', 'state', { [k('state')]: 'Status: Merged' })).toBe('merged');
    expect(adapterValue('github.prPage', 'branch', { [k('branch')]: 'acme/api:feat/x' })).toBe('feat/x');
    expect(adapterValue('jira.issuePage', 'summary', { 'adapter:jira.issuePage.summary': 'Fix it' })).toBe('Fix it');
  });

  it("PrState 'unknown' is never a value (M3-R45): missing, like an absent field", () => {
    expect(adapterValue('github.prPage', 'state', { [k('state')]: 'Queued' })).toBeUndefined();
    expect(adapterValue('github.prPage', 'state', {})).toBeUndefined();
  });

  it('an unknown adapter or field has no value', () => {
    expect(adapterValue('github.prPage', 'nope', { [k('state')]: 'Open' })).toBeUndefined();
    expect(adapterValue('nope' as 'github.prPage', 'state', {})).toBeUndefined();
  });
});

describe('ordered fallbacks', () => {
  it('when several fallbacks match, the first one listed wins', async () => {
    // The state badge has both a title ("Status: Merged", first) and text ("Open", a later fallback).
    const html = '<div class="gh-header-meta"><span class="State" title="Status: Merged">Open</span></div>';
    const x = await extractFixture(html, 'https://github.com/a/b/pull/1', adapterProgram('github.prPage', ['state']));
    expect(adapterValue('github.prPage', 'state', x)).toBe('merged');
  });
});
