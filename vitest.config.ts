import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { yamlJson } from './wxt.config';

export default defineConfig({
  plugins: [WxtVitest(), svelte(), yamlJson],
  // Svelte 5 resolves its server build under node unless the browser condition is set (needed for component tests).
  resolve: { conditions: ['browser'] },
  test: {
    // include/exclude live on the projects only: `extends: true` merges a root include into each project's, which ran
    // every test in both.
    projects: [
      // Component tests render Svelte in jsdom and step through Save -> preview -> config.set. On a loaded machine (load
      // average 12) some took over the 5 s default, so they get 20 s. Everything else keeps 5 s, so a real hang there
      // still fails fast.
      { extends: true, test: { name: 'ui', include: ['tests/ui/**/*.test.ts'], testTimeout: 20_000 } },
      {
        extends: true,
        test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**', 'tests/ui/**', 'node_modules/**'] },
      },
    ],
  },
});
