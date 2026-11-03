// Demo fixtures shared by the e2e mock services (tests/e2e/mock-services.ts, the e2e:m3 specs) and the store images
// (store/, npm run store:assets): the shapes of the pull requests and Jira tickets the mock answers, builders for
// them, the mock's dummy credentials, and the connection defs that point Tabchef at the mock. The e2e specs keep
// their own values (their assertions name them); the store's demo shop ("acme", Jira project SHOP) is DEMO_PRS and
// DEMO_ISSUES. Nothing here is a real account: the tokens only open the mock.
import { builtinConnectionDefs } from '../../src/core/connections/builtin';
import type { ConnectionDef } from '../../src/core/connections/types';
import { CONNECTIONS_KEY, secretKey } from '../../src/engine/connections/secret-store';

export interface MockIssue { summary: string; status: string; category: 'new' | 'indeterminate' | 'done' }
export interface MockPr { state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string; mergedAt?: string }

/** The dummy token stored for the github connection. The mock answers 401 to anything else. */
export const MOCK_TOKEN = 'ghp_e2eDummyToken0000000000000000000000';
/** The dummy Jira credentials (Basic email:token). The mock answers 401 to anything else. */
export const MOCK_JIRA_EMAIL = 'e2e@example.test';
export const MOCK_JIRA_TOKEN = 'e2e-dummy-jira-token-0000';
/** The login the mock's GET /user answers. */
export const MOCK_LOGIN = 'e2e-user';

/** The mock's key for a pull request: 'owner/repo#number'. */
export const prKey = (repo: string, n: number): string => `${repo}#${n}`;
export const openPr = (title: string): MockPr => ({ state: 'OPEN', title });
/** `mergedAt`: an ISO time, or a Date. */
export const mergedPr = (title: string, mergedAt: string | Date): MockPr =>
  ({ state: 'MERGED', title, mergedAt: typeof mergedAt === 'string' ? mergedAt : mergedAt.toISOString() });
export const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000);

/** A Jira ticket; the status category follows the status name ('Done' is done, 'To Do' is new, the rest in progress). */
export function issue(summary: string, status: string): MockIssue {
  return { summary, status, category: status === 'Done' ? 'done' : status === 'To Do' ? 'new' : 'indeterminate' };
}

/**
 * The github connection on the mock at `origin`, a token connection as setToken stores it (setToken itself validates
 * against api.github.com). `baseUrl` is where the pull request pages are: the mock (e2e) or github.com (store).
 */
export function mockGithubDef(origin: string, baseUrl = origin): ConnectionDef {
  return { ...builtinConnectionDefs().github, auth: 'token', baseUrl, apiBaseUrl: origin, hosts: ['http://localhost/*'] };
}

/** The Jira connection on the mock at `origin`, a classic token for `site` (the host the ticket tabs are on). */
export function mockJiraDef(origin: string, site: string): ConnectionDef {
  return {
    ...builtinConnectionDefs().jira, baseUrl: origin, apiBaseUrl: origin, hosts: ['http://localhost/*'],
    jira: { site, email: MOCK_JIRA_EMAIL, tokenKind: 'classic' },
  };
}

/** The storage.local items for connections `defs` with the mock's credentials: the shape the SecretStore reads. */
export function connectionItems(defs: ConnectionDef[]): Record<string, unknown> {
  const token = (d: ConnectionDef) => (d.kind === 'jira' ? MOCK_JIRA_TOKEN : MOCK_TOKEN);
  return { [CONNECTIONS_KEY]: defs, ...Object.fromEntries(defs.map((d) => [secretKey(d.id), { token: token(d) }])) };
}

/** The store images' demo shop: pull requests in acme/api and acme/web, keyed prKey(). */
export const DEMO_PRS: Record<string, MockPr> = {
  [prKey('acme/api', 412)]: openPr('SHOP-142 Saved carts API'),
  [prKey('acme/web', 88)]: openPr('SHOP-142 Saved carts page'),
  [prKey('acme/web', 91)]: mergedPr('SHOP-139 Gift card balance check', hoursAgo(5)),
  [prKey('acme/api', 405)]: mergedPr('Rate-limit the login endpoint', hoursAgo(2)),
  [prKey('acme/api', 398)]: mergedPr('Upgrade the API to Node 24', hoursAgo(26)),
  [prKey('acme/web', 86)]: mergedPr('Fix the checkout button focus ring', hoursAgo(49)),
  [prKey('acme/api', 417)]: openPr('Add request IDs to the access log'),
};

/** The store images' Jira tickets (project SHOP). */
export const DEMO_ISSUES: Record<string, MockIssue> = {
  'SHOP-142': issue('Saved carts', 'In Progress'),
  'SHOP-139': issue('Gift card balance', 'Done'),
};
