import { defineConfig } from '@playwright/test';

// The extension is loaded from .output/chrome-mv3: run via `npm run e2e` (builds first).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // A failed test keeps a trace and screenshots in test-results/ (CI uploads it): open with `npx playwright show-trace`.
  // The runner also traces the persistent context helpers.ts launches, one chunk per test. The m3 build's run writes to
  // test-results-m3/ instead, however it's started: each run empties its output folder first.
  outputDir: process.env.WXT_E2E_LOCALHOST === '1' ? 'test-results-m3' : 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
