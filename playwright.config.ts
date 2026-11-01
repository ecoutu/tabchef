import { defineConfig } from '@playwright/test';

// The extension is loaded from .output/chrome-mv3: run via `npm run e2e` (builds first).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
