import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { yamlJson } from './wxt.config';

export default defineConfig({
  plugins: [WxtVitest(), svelte(), yamlJson],
  // Svelte 5 resolves its server build under node unless the browser condition is set (needed for component tests).
  resolve: { conditions: ['browser'] },
  test: { include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**', 'node_modules/**'] },
});
