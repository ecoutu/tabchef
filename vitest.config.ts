import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
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
        test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**', 'tests/ui/**', 'node_modules/**'] },
      },
    ],
  },
});
