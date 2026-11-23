import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { yamlJson } from './wxt.config';
import type { Plugin } from 'vite';
import type { VitestPluginContext } from 'vitest/node';

/**
 * #24: Vitest's file-system module cache (`fsModuleCache`, node_modules/.vitest-cache) keys a module by its own source,
 * so it skips modules that use `import.meta.glob(`: their output depends on which files match. Its check misses a glob
 * with a type argument, `import.meta.glob<T>(`, as src/recipes/load.ts writes it, so a new built-in recipe YAML was
 * missing from builtinRecipes() until `npx vitest --clearCache`. This keeps every glob module out of that cache.
 */
export const globCacheBust = {
  name: 'tabchef:glob-cache-bust',
  configureVitest({ defineCacheKeyGenerator }: Pick<VitestPluginContext, 'defineCacheKeyGenerator'>) {
    defineCacheKeyGenerator(({ sourceCode }) => (/import\.meta\.glob\s*</.test(sourceCode) ? false : undefined));
  },
} satisfies Plugin;

/**
 * #256: WxtVitest adds the setup file `virtual:wxt-setup` (it stubs `chrome`/`browser` with WXT's fakeBrowser). Browser
 * mode imports setup files as `<root>/virtual:wxt-setup?browserv=…`, and its own resolver (vitest:browser:tests, order
 * pre) turns that into the plain path before WXT's resolver sees it, so Vite looks for a file that doesn't exist and
 * every test file fails ("Failed to fetch dynamically imported module"). In the browser project this swaps it for
 * tests/browser/setup.ts, which does the same from a real file.
 */
export const wxtSetupForBrowser = {
  name: 'tabchef:wxt-setup-for-browser',
  enforce: 'post',
  config(config) {
    const files = [config.test?.setupFiles ?? []].flat();
    // Without the swap the browser tests would run with no fake `chrome`/`browser` at all: fail loudly if WXT renames it.
    if (!config.test || !files.includes('virtual:wxt-setup')) throw new Error('wxtSetupForBrowser: WxtVitest no longer adds virtual:wxt-setup');
    config.test.setupFiles = files.map((f) => (f === 'virtual:wxt-setup' ? 'tests/browser/setup.ts' : f));
  },
} satisfies Plugin;

export default defineConfig({
  plugins: [WxtVitest(), svelte(), yamlJson, globCacheBust],
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
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**', 'tests/ui/**', 'tests/browser/**', 'node_modules/**'],
        },
      },
      // #256: tests/browser/**/*.test.ts render components in real headless Chromium (Vitest browser mode, Playwright's
      // bundled browser), for what jsdom can't do: layout, scrolling, real pointer and focus, CSS. Everything else stays
      // in jsdom (ui), which is faster. `chrome`/`browser` are WXT's fakeBrowser here too (wxtSetupForBrowser).
      {
        extends: true,
        plugins: [wxtSetupForBrowser],
        // Pre-bundled up front: Vite otherwise finds these mid-run on a cold cache (as in CI), re-optimizes, and reloads
        // the page under the running tests ("Vite unexpectedly reloaded a test"). A browser test whose component imports
        // another package needs it added here.
        optimizeDeps: { include: ['@testing-library/svelte', 'yaml', 'wxt/browser', 'wxt/testing/fake-browser'] },
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          testTimeout: 20_000, // as for ui: these render the same components
          // A fixed viewport, also when run headed (which would otherwise use the window's size): tests measure layout.
          browser: {
            // Keep scrollbars, which headless Chromium hides by default: a headed run (and the real page) has them.
            enabled: true, provider: playwright({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } }),
            headless: true, viewport: { width: 414, height: 896 },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
