// Demo data for the store images: a made-up "acme" shop with two repositories (acme/api, acme/web) and a Jira site
// (acme.atlassian.net, project SHOP). The mock services answer the pull requests and tickets; the pages the tabs
// open are answered in-process by capture.ts. Nothing here is a real account, repository or ticket.
import type { GroupColor } from '../src/core/types';
import type { MockIssue, MockPr } from '../tests/e2e/mock-services';

export const JIRA_SITE = 'acme.atlassian.net';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** Pull requests, keyed 'owner/repo#number' as the mock wants them. */
export const DEMO_PRS: Record<string, MockPr> = {
  'acme/api#412': { state: 'OPEN', title: 'SHOP-142 Saved carts API' },
  'acme/web#88': { state: 'OPEN', title: 'SHOP-142 Saved carts page' },
  'acme/web#91': { state: 'MERGED', title: 'SHOP-139 Gift card balance check', mergedAt: hoursAgo(5) },
  'acme/api#405': { state: 'MERGED', title: 'Rate-limit the login endpoint', mergedAt: hoursAgo(2) },
  'acme/api#398': { state: 'MERGED', title: 'Upgrade the API to Node 24', mergedAt: hoursAgo(26) },
  'acme/web#86': { state: 'MERGED', title: 'Fix the checkout button focus ring', mergedAt: hoursAgo(49) },
  'acme/api#417': { state: 'OPEN', title: 'Add request IDs to the access log' },
};

export const DEMO_ISSUES: Record<string, MockIssue> = {
  'SHOP-142': { summary: 'Saved carts', status: 'In Progress', category: 'indeterminate' },
  'SHOP-139': { summary: 'Gift card balance', status: 'Done', category: 'done' },
};

export interface DemoPage { url: string }
const gh = (path: string): DemoPage => ({ url: `https://github.com/${path}` });
const jira = (key: string): DemoPage => ({ url: `https://${JIRA_SITE}/browse/${key}` });

/** Titles for the pages that are not pull requests or tickets (those come from the mock). */
const TITLES: Record<string, string> = {
  '/acme/web': 'acme/web: The Acme shop storefront',
  '/acme/api': 'acme/api: Orders, carts and payments API',
  '/acme/api/issues': 'Issues · acme/api',
  '/acme/web/actions': 'Actions · acme/web',
  '/acme/api/pulls': 'Pull requests · acme/api',
  '/en-US/docs/Web/API/URL_Pattern_API': 'URL Pattern API - Web APIs | MDN',
  '/callback': 'Signed in. You can close this tab.',
};
export function pageTitle(url: URL): string {
  return TITLES[url.pathname] ?? `${url.host}${url.pathname}`;
}

/** Screenshot 1: opened during the startup grace, so the duplicates stay open for the popup to list. */
export const DUPLICATE_TABS: DemoPage[] = [
  gh('acme/api/pull/412'),
  gh('acme/web'),
  gh('acme/api/pull/412/files'),
  gh('acme/api/issues'),
  gh('acme/api/pull/412'),
  gh('acme/web'),
  gh('acme/api/issues'),
  gh('acme/api/pull/412/commits'),
];

/** The sets the popup lists: the pull request (4 copies), acme/web and the issues page (2 each). */
export const DUPLICATE_SETS = 3;

/** Screenshots 2 and 5: the user's own group rules, in their order. */
export const GROUP_RULES: { id: string; url: string; title: string; color: GroupColor }[] = [
  { id: 'api', url: 'github.com/acme/api*', title: 'api', color: 'blue' },
  { id: 'web', url: 'github.com/acme/web*', title: 'web', color: 'green' },
  { id: 'docs', url: 'developer.mozilla.org/*', title: 'docs', color: 'purple' },
];

/** Screenshots 3 and 4: Jira tickets with their pull requests, and the merged pull requests. */
export const PROJECT_TABS: DemoPage[] = [
  jira('SHOP-142'),
  gh('acme/api/pull/412'),
  gh('acme/web/pull/88'),
  jira('SHOP-139'),
  gh('acme/web/pull/91'),
  gh('acme/api/pull/405'),
  gh('acme/api/pull/398'),
  gh('acme/web/pull/86'),
];
export const MERGED_COUNT = 4;
export const PROJECT_COUNT = 2;
/** What the Projects view shows once every lookup has answered: the tickets' status and the pull requests' state. */
export const PROJECT_PILLS: [text: string, count: number][] = [['Done', 1], ['In Progress', 1], ['merged', 1], ['open', 2]];

/**
 * Screenshots 5 and 2 share their tabs. The preview (5) reports on PREVIEW_TABS with the group rules off; then the
 * tabs only the preview needs close, GROUP_EXTRA_TABS open, and the rules go on, grouping the tabs of screenshot 2.
 */
export const PREVIEW_TABS: DemoPage[] = [
  gh('acme/api/pull/412'),
  gh('acme/web/pull/88'),
  gh('acme/api/issues'),
  { url: 'http://localhost:3000/callback?code=demo' },
  gh('acme/web'),
];
/** The preview's moves: every tab but the callback page joins a group. */
export const PREVIEW_MOVES = 4;
/** Closed after the preview: screenshot 2's tab strip does not show them. */
export const PREVIEW_ONLY_TABS: DemoPage[] = [PREVIEW_TABS[3]!, PREVIEW_TABS[4]!];
export const GROUP_EXTRA_TABS: DemoPage[] = [
  { url: 'https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API' },
  gh('acme/web/actions'),
  gh('acme/api/pull/417'),
];
/** The tabs screenshot 2 groups: api (412, issues, 417), web (88, actions) and docs (MDN). */
export const GROUP_TAB_COUNT = PREVIEW_TABS.length - PREVIEW_ONLY_TABS.length + GROUP_EXTRA_TABS.length;
