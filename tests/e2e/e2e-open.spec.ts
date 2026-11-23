// npm run e2e:open (scripts/e2e-open.ts): the extension in a browser a second process drives over CDP, the way
// Playwright MCP and Chrome DevTools MCP attach. Runs the script headless on the build `npm run e2e` made
// (--ext .output/chrome-mv3, so no build of its own) on a free port, then stops it with SIGTERM, or with Ctrl-C's
// SIGINT through npm.
import { chromium, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cdp, expectCleanExit, EXIT_WAIT_MS, READY_WAIT_MS, ready, start, stopRun } from './e2e-open-helpers';
import { EXT_PATH } from './helpers';

test.afterEach(stopRun);

// Long enough for the waits in e2e-open-helpers.ts to fail with their own messages (the script's output) before the test times out:
// the state file, the steps in between, the exit.
test.setTimeout(READY_WAIT_MS + EXIT_WAIT_MS + 30_000);

test.beforeEach(() => {
  test.skip(!existsSync(join(EXT_PATH, 'manifest.json')), 'no build in .output/chrome-mv3: run `npm run e2e`');
});

test('e2e:open: a second process attaches over CDP and drives the options page; SIGTERM cleans up', async () => {
  const run = start(process.execPath, ['scripts/run-ts.mjs', 'scripts/e2e-open.ts']);
  const state = await ready(run);
  expect(state).toMatchObject({ pid: run.child.pid, headless: true, extensionPath: EXT_PATH });
  expect(state.mockOrigin).toBeUndefined();

  // The port serves the DevTools HTTP endpoints while Playwright in the script controls the browser over its pipe.
  const version = await (await cdp(state.cdpEndpoint)).json() as { webSocketDebuggerUrl?: string };
  expect(version.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);

  const browser = await chromium.connectOverCDP(state.cdpEndpoint);
  const context = browser.contexts()[0]!;
  expect(context.pages().map((p) => p.url())).toContain(state.urls.options);
  const page = await context.newPage();
  await page.goto(state.urls.options);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Rules', exact: true }).click();
  await expect(page).toHaveURL(/#\/rules$/);
  await page.close();
  // Disconnecting the second client leaves the browser running.
  await browser.close();
  expect((await cdp(state.cdpEndpoint)).ok).toBe(true);

  run.child.kill('SIGTERM');
  expect(await expectCleanExit(run, state), run.output()).toEqual({ code: 0, signal: null });
});

// When npm's script shell is bash (macOS's and Fedora's /bin/sh), bash execs the script, so one Ctrl-C reaches it
// twice: from the terminal and forwarded by npm. The second must not force-quit past the cleanup.
test('e2e:open: Ctrl-C through npm closes the browser and cleans up', async () => {
  const run = start('npm', ['run', 'e2e:open', '--'], {
    detached: true, env: { ...process.env, npm_config_script_shell: '/bin/bash' },
  });
  const state = await ready(run);
  // Ctrl-C signals the terminal's whole foreground process group.
  process.kill(-run.child.pid!, 'SIGINT');
  const exit = await expectCleanExit(run, state);
  expect(exit.code === 0 || exit.signal === 'SIGINT', `exit ${JSON.stringify(exit)}:\n${run.output()}`).toBe(true);
});
