// M3 end-to-end: the Merged PRs flow and connection failures against a mock GitHub API on localhost.
// Needs the e2e build (`npm run e2e:m3`: WXT_E2E_LOCALHOST=1 adds host_permissions http://localhost/* and lets the
// connection layer use a localhost apiBaseUrl, M3-R35 / M3-R86). Under plain `npm run e2e` the mocked tests skip; the
// production-build guard (e) runs in both.
// (b) Jira ticket grouping at the Titles level (no connection), (b2) the Done prompt with a Jira token connection on the mock.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { builtinConnectionDefs } from '../../src/core/connections/builtin';
import type { ConnectionDef, ConnectionStatus } from '../../src/core/connections/types';
import type { Recipe, RecipeRef } from '../../src/core/lang/types';
import { RATE_KEY } from '../../src/engine/connections/rate-limiter';
import { CONNECTIONS_KEY, secretKey } from '../../src/engine/connections/secret-store';
import { config, EXT_PATH, groups, launch, openTab, reset, send, setConfig, tabs, type Harness } from './helpers';
import { MOCK_JIRA_EMAIL, MOCK_JIRA_TOKEN, MOCK_TOKEN, startMockServices, type MockServices } from './mock-services';

interface ViewRow { tabId: number; url: string; source?: { state?: string; mergedAt?: string }; stale?: true }
interface WhyEntry { tabId?: number; ruleId?: string; action: string; detail: string }

const ROOT = resolve(import.meta.dirname, '../..');
const RECIPE_ID = 'merged-prs-e2e';
const JIRA_RECIPE_ID = 'jira-ticket-e2e';
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { host_permissions?: string[] };
const isE2eBuild = (() => {
  try {
    return manifestOf(EXT_PATH).host_permissions?.includes('http://localhost/*') === true;
  } catch {
    return false;
  }
})();

/**
 * The shipped Merged PRs recipe as a user recipe for the mock: only its PR URL pattern changes, to the mock origin
 * (the tabs cannot be on github.com). Its needs are the shipped ones: needs-reauth keeps the connection level (M3-R89).
 */
function mergedPrsRecipe(origin: string, over: Pick<RecipeRef, 'params' | 'ruleEnabled'> = { params: {} }): RecipeRef {
  const shipped = parseYaml(readFileSync(join(ROOT, 'src/recipes/builtin/merged-prs.yaml'), 'utf8')) as Recipe;
  const host = new URL(origin).host;
  const body = JSON.parse(JSON.stringify(shipped).replaceAll('github.com/:owner/:repo/pull/', `${host}/:owner/:repo/pull/`)) as Recipe;
  body.recipe = RECIPE_ID;
  return { id: RECIPE_ID, enabled: true, source: 'user', body, ...over };
}

/**
 * The shipped jira-ticket-either recipe as a user recipe for the mock: only its PR URL pattern changes, to the mock origin
 * (a user rule cannot assign a project, M3-R15, so the recipe's own rule is repointed, as for Merged PRs). The Jira side
 * is the shipped rule with `jiraSite` set to the mock host.
 */
function jiraRecipe(origin: string): RecipeRef {
  const shipped = parseYaml(readFileSync(join(ROOT, 'src/recipes/builtin/jira-ticket-either.yaml'), 'utf8')) as Recipe;
  const host = new URL(origin).host;
  const body = JSON.parse(JSON.stringify(shipped).replaceAll('github.com/:owner/:repo/pull/', `${host}/:owner/:repo/pull/`)) as Recipe;
  body.recipe = JIRA_RECIPE_ID;
  return { id: JIRA_RECIPE_ID, enabled: true, source: 'user', body, params: { jiraSite: host } };
}

test.describe('M3 with mocked services', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!isE2eBuild && process.env.WXT_E2E_LOCALHOST !== '1', 'needs the WXT_E2E_LOCALHOST=1 build: run npm run e2e:m3');
  let h: Harness;
  let mock: MockServices;

  test.beforeAll(async () => {
    // e2e:m3 asked for the e2e build: a build without the localhost grant is a failure here, not a skip.
    expect(isE2eBuild, '.output/chrome-mv3 is not the WXT_E2E_LOCALHOST=1 build').toBe(true);
    mock = await startMockServices();
    h = await launch();
  });
  test.afterAll(async () => {
    await h?.close();
    await mock?.close();
  });
  test.beforeEach(async () => { await reset(h); });

  const prUrl = (n: number) => `${mock.origin}/acme/api/pull/${n}`;
  const tabById = async (id: number) => (await tabs(h)).find((t) => t.id === id);
  const github = async () => (await send<{ status: ConnectionStatus[] }>(h, { type: 'connections.list' })).status.find((s) => s.id === 'github');
  const mergedRows = async () => (await send<{ rows: ViewRow[] }>(h, { type: 'view.data', viewId: 'merged' })).rows;
  const recentUrls = async () => (await send<{ url: string }[]>(h, { type: 'recent.list' })).map((r) => r.url);

  const withRecipe = (ref: RecipeRef) => ({ ...config([]), recipes: [...config([]).recipes, ref] });

  /**
   * The github connection on the mock: a PAT connection whose apiBaseUrl is the mock, stored in the shape setToken
   * stores (CONNECTIONS_KEY def + SecretStore's secretKey('github')); setToken itself always validates against
   * api.github.com, so it cannot target the mock (M3-R91). Each test starts from a clean connection, so the tests do not
   * depend on their order: `connections.disconnect` clears an earlier test's runtime status (needs-reauth), and the
   * limiter's state (RATE_KEY: an earlier 403's block) is removed. `connections.test` (GET /user through the
   * ConnectionManager) proves the def reaches the mock. Then the recipe is enabled, whose config change re-evaluates the
   * capability levels with the connection in place.
   */
  async function connectAndEnable(ref: RecipeRef = mergedPrsRecipe(mock.origin)): Promise<void> {
    await send(h, { type: 'connections.disconnect', id: 'github' });
    const def: ConnectionDef = {
      ...builtinConnectionDefs().github, auth: 'token', baseUrl: mock.origin, apiBaseUrl: mock.origin, hosts: ['http://localhost/*'],
    };
    await h.sw.evaluate(async ([items, rateKey]) => {
      await chrome.storage.session.remove(rateKey);
      await chrome.storage.local.set(items);
    }, [{ [CONNECTIONS_KEY]: [def], [secretKey('github')]: { token: MOCK_TOKEN } }, RATE_KEY] as const);
    expect(await send<{ login?: string }>(h, { type: 'connections.test', id: 'github' })).toEqual({ login: 'e2e-user' });
    expect((await github())?.state).toBe('ok');
    await setConfig(h, withRecipe(ref));
    await expect.poll(async () => (await send<{ id: string }[]>(h, { type: 'views.list' })).map((v) => v.id), { timeout: 5000 })
      .toContain('merged');
  }

  test('(a) a merged PR tab is listed by the Merged view within 5 s; close-all closes it into Recently closed', async () => {
    mock.github.setPr('acme/api#1', { state: 'MERGED', title: 'Add login', mergedAt: '2026-11-01T12:00:00Z' });
    await connectAndEnable();
    const id = await openTab(h, prUrl(1));

    await expect.poll(async () => (await mergedRows()).filter((r) => r.tabId === id).map((r) => ({ url: r.url, state: r.source?.state, stale: r.stale })), { timeout: 5000 })
      .toEqual([{ url: prUrl(1), state: 'merged', stale: undefined }]);

    const rows = await mergedRows();
    expect(await send(h, { type: 'view.close', viewId: 'merged', tabs: rows.map((r) => ({ tabId: r.tabId, url: r.url })) }))
      .toEqual({ closed: 1, skipped: 0 });
    await expect.poll(() => tabById(id), { timeout: 5000 }).toBeUndefined();
    expect(await recentUrls()).toContain(prUrl(1));
  });

  test('(b) Titles level, no connection: a Jira ticket tab and a PR tab naming its key share one ABC-1 group', async () => {
    mock.jira.setIssue('ABC-1', { summary: 'Login', status: 'In Progress', category: 'indeterminate' });
    mock.github.setPr('acme/api#1', { state: 'OPEN', title: 'ABC-1 fix' });
    // No connections: an earlier test's github connection would lift the PR rule above the Titles level.
    await send(h, { type: 'connections.disconnect', id: 'github' });
    await send(h, { type: 'connections.disconnect', id: 'jira' });
    await setConfig(h, withRecipe(jiraRecipe(mock.origin)));
    const jiraRequests = mock.jira.requests;
    const githubRequests = mock.github.requests;
    const ticket = await openTab(h, `${mock.origin}/browse/ABC-1`);
    const pr = await openTab(h, prUrl(1));

    const state = async () => {
      const gs = await groups(h);
      const ts = (await tabs(h)).filter((t) => t.id === ticket || t.id === pr);
      return { groups: gs.map((g) => g.title), members: ts.map((t) => gs.find((g) => g.id === t.groupId)?.title ?? null) };
    };
    await expect.poll(state, { timeout: 10_000 }).toEqual({ groups: ['ABC-1'], members: ['ABC-1', 'ABC-1'] });
    const groupIds = (await tabs(h)).filter((t) => t.id === ticket || t.id === pr).map((t) => t.groupId);
    expect(new Set(groupIds).size).toBe(1);

    const cards = await send<{ id: string; title: string; tabs: { tabId: number }[] }[]>(h, { type: 'projects.list' });
    expect(cards.map((c) => ({ id: c.id, title: c.title, tabs: c.tabs.map((t) => t.tabId).sort() })))
      .toEqual([{ id: `${JIRA_RECIPE_ID}:ABC-1`, title: 'ABC-1', tabs: [ticket, pr].sort() }]);
    // Titles level: neither a Jira nor a GitHub request went out.
    expect(mock.jira.requests).toBe(jiraRequests);
    expect(mock.github.requests).toBe(githubRequests);
  });

  test('(b2) with a Jira token connection on the mock, a Done ticket shows the close prompt data', async () => {
    // The source cache keeps an issue for 5 minutes, so each status is set before its ticket tab opens.
    mock.jira.setIssue('ABC-2', { summary: 'Logout', status: 'Done', category: 'done' });
    mock.jira.setIssue('ABC-3', { summary: 'Signup', status: 'In Progress', category: 'indeterminate' });
    // Same shape setJiraToken stores (classic token: apiBaseUrl is the site); setJiraToken validates against Atlassian hosts.
    const host = new URL(mock.origin).host;
    const def: ConnectionDef = {
      ...builtinConnectionDefs().jira, baseUrl: mock.origin, apiBaseUrl: mock.origin, hosts: ['http://localhost/*'],
      jira: { site: host, email: MOCK_JIRA_EMAIL, tokenKind: 'classic' },
    };
    await send(h, { type: 'connections.disconnect', id: 'jira' });
    await h.sw.evaluate(async ([items, rateKey]) => {
      await chrome.storage.session.remove(rateKey);
      await chrome.storage.local.set(items);
    }, [{ [CONNECTIONS_KEY]: [def], [secretKey('jira')]: { token: MOCK_JIRA_TOKEN } }, RATE_KEY] as const);
    await setConfig(h, withRecipe(jiraRecipe(mock.origin)));

    const id = await openTab(h, `${mock.origin}/browse/ABC-2`);
    await openTab(h, `${mock.origin}/browse/ABC-3`);
    const cards = async () => new Map((await send<{ id: string; done: boolean; status?: { name: string; via: string } }[]>(h, { type: 'projects.list' }))
      .map((c) => [c.id.slice(JIRA_RECIPE_ID.length + 1), { name: c.status?.name, via: c.status?.via, done: c.done }]));
    await expect.poll(async () => [...(await cards())].sort(), { timeout: 10_000 }).toEqual([
      ['ABC-2', { name: 'Done', via: 'api', done: true }],
      ['ABC-3', { name: 'In Progress', via: 'api', done: false }],
    ]);
    expect(await tabById(id)).toBeDefined(); // prompting only: nothing is closed
  });

  test('(c) a 401 marks the connection needs-reauth; the merged row stays, stale, and its due auto-close is skipped', async () => {
    // Auto-close on, falling due 15 s after the merge: the merge is "now", so the close is not due until after the 401.
    const AFTER_MS = 15_000;
    const auto = { params: { autoCloseAfter: '15s' }, ruleEnabled: { 'auto-close-merged': true } };
    await connectAndEnable(mergedPrsRecipe(mock.origin, auto));
    const mergedAt = Date.now();
    mock.github.setPr('acme/api#2', { state: 'MERGED', title: 'Fix logout', mergedAt: new Date(mergedAt).toISOString() });
    mock.github.setPr('acme/api#3', { state: 'OPEN', title: 'Refactor session' });
    const merged = await openTab(h, prUrl(2));
    await expect.poll(async () => (await mergedRows()).filter((r) => r.tabId === merged).map((r) => r.stale ?? false), { timeout: 5000 })
      .toEqual([false]);

    // A merged PR is final (never refetched): the next lookup that goes out is the new open PR's, which gets the 401.
    mock.github.failNext(401);
    const open = await openTab(h, prUrl(3));
    await expect.poll(async () => (await github())?.state, { timeout: 5000 }).toBe('needs-reauth');
    expect(Date.now()).toBeLessThan(mergedAt + AFTER_MS); // the 401 came before the close was due

    // Wait until the close is due. Nothing re-evaluates the merged tab meanwhile (no event of its own, data unchanged).
    await expect.poll(() => Date.now(), { timeout: AFTER_MS + 5000, intervals: [500] }).toBeGreaterThan(mergedAt + AFTER_MS + 500);

    // The next refresh (any tab change) sees needs-reauth: the final entry is kept and marked stale, nothing is sent.
    // The shipped needs keep pr-state at its connection level (M3-R89), so the row stays listed. The stale flip is a
    // reported change (M3-R92): the merged tab is re-evaluated, its now-due auto-close matches on the stale entry, and
    // is skipped and logged (M3-R90) instead of executed. No config change or age tick is needed.
    const sent = mock.github.requests;
    await openTab(h, `${mock.origin}/after-401`);
    await expect.poll(async () => (await mergedRows()).filter((r) => r.tabId === merged).map((r) => ({ state: r.source?.state, stale: r.stale })), { timeout: 5000 })
      .toEqual([{ state: 'merged', stale: true }]);
    await expect.poll(async () => (await send<WhyEntry[]>(h, { type: 'why.all' }))
      .filter((e) => e.tabId === merged && e.action === 'close-skipped').map((e) => ({ ruleId: e.ruleId, detail: e.detail })), { timeout: 5000 })
      .toEqual([{ ruleId: `${RECIPE_ID}/auto-close-merged`, detail: 'Not closed: its source data is stale' }]);
    expect(mock.github.requests).toBe(sent);
    expect(await tabById(merged)).toMatchObject({ url: prUrl(2) });
    expect(await tabById(open)).toMatchObject({ url: prUrl(3) });
    const recent = await recentUrls();
    expect(recent).not.toContain(prUrl(2));
    expect(recent).not.toContain(prUrl(3));
  });

  test('(d) a 403 with retry-after: 60 blocks the connection; a refresh within 60 s sends no request', async () => {
    mock.github.setPr('acme/api#4', { state: 'OPEN', title: 'Add metrics' });
    mock.github.setPr('acme/api#5', { state: 'OPEN', title: 'Add tracing' });
    await connectAndEnable();
    mock.github.failNext(403, { 'retry-after': '60' });
    const startedAt = Date.now();
    await openTab(h, prUrl(4));
    await expect.poll(async () => (await github())?.state, { timeout: 5000 }).toBe('rate-limited');
    expect((await github())?.blockedUntil).toBeGreaterThan(startedAt + 55_000);

    // A new PR tab is due a lookup, and its refresh runs (its cache entry records the block), but sends nothing.
    const sent = mock.github.requests;
    await openTab(h, prUrl(5));
    const entry = () => h.sw.evaluate(async (k) => {
      const raw = ((await chrome.storage.local.get('sourceCache')).sourceCache ?? []) as [string, { via: string; error?: string }][];
      return raw.find(([key]) => key === k)?.[1];
    }, 'github|github.pull_request|acme/api#5');
    await expect.poll(entry, { timeout: 5000 }).toMatchObject({ via: 'none', error: 'rate-limited' });
    expect(mock.github.requests).toBe(sent);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  });
});

test.describe('production build', () => {
  test('(e) a plain build has no host_permissions and the e2e flag off', async () => {
    test.setTimeout(120_000);
    // `npm run build` (wxt build) without WXT_E2E_LOCALHOST, into a temp dir so the loaded e2e build is left alone.
    const out = mkdtempSync(join(tmpdir(), 'tabchef-prod-'));
    try {
      const env = { ...process.env };
      delete env.WXT_E2E_LOCALHOST;
      execFileSync(process.execPath, ['--input-type=module', '-e', 'import { build } from "wxt"; await build({ outDir: process.argv[1] });', out], {
        cwd: ROOT, env, stdio: 'pipe',
      });
      const dir = join(out, 'chrome-mv3');
      const manifest = manifestOf(dir);
      expect(manifest).not.toHaveProperty('host_permissions');
      // The worker bundle passes the flag as a literal (`allowLocalhost:!1`); the e2e build has `!0`.
      const js = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
      expect(js).toContain('allowLocalhost:!1');
      expect(js).not.toContain('allowLocalhost:!0');
      expect(js).not.toContain('WXT_E2E_LOCALHOST');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
