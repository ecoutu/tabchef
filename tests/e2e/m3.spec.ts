// M3 end-to-end: the Merged PRs flow and connection failures against a mock GitHub API on localhost.
// Needs the e2e build (`npm run e2e:m3`: WXT_E2E_LOCALHOST=1 adds host_permissions http://localhost/* and lets the
// connection layer use a localhost apiBaseUrl, M3-R35 / M3-R86). Under plain `npm run e2e` the mocked tests skip; the
// production-build guard (e) runs in both.
// (b), Jira ticket grouping, lands with Task 16's recipe and Task 6's Jira connection (M3-R85).
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { builtinConnectionDefs } from '../../src/core/connections/builtin';
import type { ConnectionDef, ConnectionStatus } from '../../src/core/connections/types';
import type { Recipe, RecipeRef } from '../../src/core/lang/types';
import { config, EXT_PATH, launch, openTab, reset, send, setConfig, tabs, type Harness } from './helpers';
import { MOCK_TOKEN, startMockServices, type MockServices } from './mock-services';

interface ViewRow { tabId: number; url: string; source?: { state?: string; mergedAt?: string }; stale?: true }

const ROOT = resolve(import.meta.dirname, '../..');
const RECIPE_ID = 'merged-prs-e2e';
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { host_permissions?: string[] };
const isE2eBuild = (() => {
  try {
    return manifestOf(EXT_PATH).host_permissions?.includes('http://localhost/*') === true;
  } catch {
    return false;
  }
})();

/**
 * The shipped Merged PRs recipe as a user recipe for the mock: its PR URL pattern points at the mock origin (the tabs
 * cannot be on github.com), and each rule's needs are "the github connection, or nothing" — the shipped page
 * alternative needs `scripting`, which e2e cannot grant, so without the `{}` alternative a needs-reauth connection
 * would pause the rule instead of leaving its rows stale.
 */
function mergedPrsRecipe(origin: string): RecipeRef {
  const shipped = parseYaml(readFileSync(join(ROOT, 'src/recipes/builtin/merged-prs.yaml'), 'utf8')) as Recipe;
  const host = new URL(origin).host;
  const body = JSON.parse(JSON.stringify(shipped).replaceAll('github.com/:owner/:repo/pull/', `${host}/:owner/:repo/pull/`)) as Recipe;
  body.recipe = RECIPE_ID;
  for (const r of body.rules) r.needs = { anyOf: [{ connections: ['github'] }, {}] };
  return { id: RECIPE_ID, enabled: true, params: {}, source: 'user', body };
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

  /**
   * The github connection on the mock: a PAT connection whose apiBaseUrl is the mock, stored in the shape setToken
   * stores (`connections` def + SecretStore's `conn.secret.github`). setToken itself always validates against
   * api.github.com, so it cannot target the mock. `connections.disconnect` first clears an earlier test's runtime status
   * (needs-reauth); `connections.test` (GET /user through the ConnectionManager) proves the def reaches the mock. Then
   * the recipe is enabled, whose config change re-evaluates the capability levels with the connection in place.
   */
  async function connectAndEnable(): Promise<void> {
    await send(h, { type: 'connections.disconnect', id: 'github' });
    const def: ConnectionDef = {
      ...builtinConnectionDefs().github, auth: 'token', baseUrl: mock.origin, apiBaseUrl: mock.origin, hosts: ['http://localhost/*'],
    };
    await h.sw.evaluate(async ([d, token]) => {
      await chrome.storage.local.set({ connections: [d], 'conn.secret.github': { token } });
    }, [def, MOCK_TOKEN] as const);
    expect(await send<{ login?: string }>(h, { type: 'connections.test', id: 'github' })).toEqual({ login: 'e2e-user' });
    expect((await github())?.state).toBe('ok');
    await setConfig(h, { ...config([]), recipes: [...config([]).recipes, mergedPrsRecipe(mock.origin)] });
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

  test('(c) a 401 marks the connection needs-reauth; the merged row stays, stale, and no tab closes', async () => {
    mock.github.setPr('acme/api#2', { state: 'MERGED', title: 'Fix logout', mergedAt: '2026-11-01T12:00:00Z' });
    mock.github.setPr('acme/api#3', { state: 'OPEN', title: 'Refactor session' });
    await connectAndEnable();
    const merged = await openTab(h, prUrl(2));
    await expect.poll(async () => (await mergedRows()).filter((r) => r.tabId === merged).map((r) => r.stale ?? false), { timeout: 5000 })
      .toEqual([false]);

    // A merged PR is final (never refetched): the next lookup that goes out is the new open PR's, which gets the 401.
    mock.github.failNext(401);
    const open = await openTab(h, prUrl(3));
    await expect.poll(async () => (await github())?.state, { timeout: 5000 }).toBe('needs-reauth');

    // The next refresh (any tab change) sees needs-reauth: the final entry is kept and marked stale, nothing is sent.
    const sent = mock.github.requests;
    await openTab(h, `${mock.origin}/after-401`);
    await expect.poll(async () => (await mergedRows()).filter((r) => r.tabId === merged).map((r) => ({ state: r.source?.state, stale: r.stale })), { timeout: 5000 })
      .toEqual([{ state: 'merged', stale: true }]);
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
