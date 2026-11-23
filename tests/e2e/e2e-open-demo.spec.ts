// npm run e2e:open -- --demo: the store images' demo (store/demo.ts, loaded with store/capture.ts) in the debuggable
// browser, on the e2e:m3 mock services. Needs the WXT_E2E_LOCALHOST=1 build (localhost host permission), so it runs
// under `npm run e2e:m3` and skips under `npm run e2e`. A second process attaches over CDP and checks the demo: the
// state file names the mock, the demo tabs are open in their groups, both connections have reached the mock, and a
// github.com page the second process opens is answered in-process too. Then SIGTERM cleans everything up.
import { chromium, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionDef, ConnectionStatus } from '../../src/core/connections/types';
import { matchesPattern } from '../../src/core/match/pattern';
import { CONNECTIONS_KEY } from '../../src/engine/connections/secret-store';
import * as demo from '../../store/demo';
import { prKey } from '../helpers/demo';
import { expectCleanExit, EXIT_WAIT_MS, READY_WAIT_MS, ready, start, stopRun } from './e2e-open-helpers';
import { EXT_PATH, isE2eBuild } from './helpers';

/** The demo adds the mock services, the connections, the rules and its tabs (each loaded) before the state file. */
const DEMO_READY_WAIT_MS = READY_WAIT_MS + 30_000;

/** The demo tabs loadDemo opens: the projects, preview and group tabs, each URL once. */
const DEMO_URLS = [...new Set([...demo.PROJECT_TABS, ...demo.PREVIEW_TABS, ...demo.GROUP_EXTRA_TABS].map((p) => p.url))];

test.afterEach(stopRun);
test.setTimeout(DEMO_READY_WAIT_MS + 2 * 15_000 + EXIT_WAIT_MS + 30_000); // + the groups and connections polls

test.beforeEach(() => {
  // Under e2e:m3 a missing build fails (as in m3.spec.ts); elsewhere it skips.
  test.skip(!existsSync(join(EXT_PATH, 'manifest.json')) && process.env.WXT_E2E_LOCALHOST !== '1', 'no build in .output/chrome-mv3: run `npm run e2e:m3`');
  test.skip(!isE2eBuild && process.env.WXT_E2E_LOCALHOST !== '1', 'needs the WXT_E2E_LOCALHOST=1 build: run npm run e2e:m3');
  // e2e:m3 asked for the e2e build: a build without the localhost grant is a failure here, not a skip.
  expect(isE2eBuild, '.output/chrome-mv3 is not the WXT_E2E_LOCALHOST=1 build').toBe(true);
});

test('e2e:open --demo: the demo tabs, groups and connections on the mock services; SIGTERM cleans up', async () => {
  const run = start(process.execPath, ['scripts/run-ts.mjs', 'scripts/e2e-open.ts', '--demo']);
  const state = await ready(run, DEMO_READY_WAIT_MS);
  expect(state).toMatchObject({ pid: run.child.pid, headless: true, extensionPath: EXT_PATH });
  expect(state.mockOrigin, run.output()).toMatch(/^http:\/\/localhost:\d+$/);

  const browser = await chromium.connectOverCDP(state.cdpEndpoint);
  const context = browser.contexts()[0]!;
  const ui = await context.newPage();
  await ui.goto(state.urls.options);

  // The demo tabs, each URL once.
  const webTabs = () => ui.evaluate(async () => (await chrome.tabs.query({}))
    .filter((t) => !/^(chrome-extension:|about:)/.test(t.url ?? ''))
    .map((t) => ({ url: t.url ?? '', title: t.title ?? '', groupId: t.groupId })));
  const tabs = await webTabs();
  expect(tabs.map((t) => t.url).sort(), run.output()).toEqual([...DEMO_URLS].sort());

  // The pull request tabs are on github.com, answered in-process with the mock's page: its title is the mock PR's.
  const pr = tabs.find((t) => t.url === 'https://github.com/acme/api/pull/412');
  expect(pr?.title).toContain(demo.DEMO_PRS[prKey('acme/api', 412)]!.title);

  // Each group rule's group (under the title demo.ts gives it) holds exactly the tabs whose URLs the rule matches.
  const groupedUrls = async () => {
    const groups = await ui.evaluate(() => chrome.tabGroups.query({}));
    const ts = await webTabs();
    return Object.fromEntries(demo.GROUP_RULES.map((r) => {
      const ids = groups.filter((g) => g.title === r.title).map((g) => g.id);
      return [r.title, ts.filter((t) => ids.includes(t.groupId)).map((t) => t.url).sort()];
    }));
  };
  const expected = Object.fromEntries(demo.GROUP_RULES.map((r) =>
    [r.title, DEMO_URLS.filter((u) => matchesPattern(r.url, u)).sort()]));
  expect(Object.values(expected).every((urls) => urls.length > 0)).toBe(true);
  await expect.poll(groupedUrls, { message: 'the demo groups', timeout: 15_000 }).toEqual(expected);

  // Both connections point at the mock and have answered a request there (github: the setup's connection test;
  // jira: a ticket lookup).
  const defs = await ui.evaluate(async (k) => (await chrome.storage.local.get(k))[k], CONNECTIONS_KEY) as ConnectionDef[];
  expect(Object.fromEntries(defs.map((d) => [d.id, d.apiBaseUrl]))).toEqual({ github: state.mockOrigin, jira: state.mockOrigin });
  await expect.poll(async () => {
    const list = await ui.evaluate(() => chrome.runtime.sendMessage({ type: 'connections.list' })) as
      { ok: boolean; data: { status: ConnectionStatus[] } };
    return list.ok && Object.fromEntries(list.data.status.map((s) => [s.id, { state: s.state, used: s.lastUsedAt !== undefined }]));
  }, { message: 'both connections used on the mock', timeout: 15_000 }).toEqual({
    github: { state: 'ok', used: true }, jira: { state: 'ok', used: true },
  });

  // A page a second client opens goes through the demo's routes too: never the real github.com. Its URL is no demo
  // tab's: once the startup grace is over, the extension closes a new tab that duplicates one.
  const url = 'https://github.com/acme/api';
  expect(DEMO_URLS).not.toContain(url);
  const page = await context.newPage();
  await page.goto(url);
  expect(await page.title()).toBe(demo.pageTitle(new URL(url)));
  await page.close();
  await ui.close();
  await browser.close();

  // Still up after the client disconnects, so the clean exit below is SIGTERM's doing.
  expect((await fetch(`${state.cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(5000) })).ok).toBe(true);
  run.child.kill('SIGTERM');
  expect(await expectCleanExit(run, state), run.output()).toEqual({ code: 0, signal: null });
});
