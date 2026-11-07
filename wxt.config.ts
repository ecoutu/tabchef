import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { defineConfig, type UserManifest } from 'wxt';

export const manifestConfig: UserManifest = {
  name: 'Tabchef',
  // The store listing's summary (docs/store/listing.md), so the extensions page and the store say the same thing.
  description: 'Group, de-duplicate and auto-close tabs with rules. Recipes for GitHub PRs, OAuth callbacks and Meet calls, or write your own.',
  // sidePanel is required (it has no install warning): granted at runtime as an optional permission, any later
  // sidePanel.open() crashes the whole browser (Chrome 156).
  permissions: ['tabs', 'tabGroups', 'storage', 'contextMenus', 'alarms', 'webNavigation', 'sidePanel'],
  optional_permissions: ['notifications', 'scripting', 'bookmarks'],
  optional_host_permissions: ['https://*/*', 'http://localhost/*'],
  options_ui: { page: 'options.html', open_in_tab: true },
  // storage.session, sidePanel.open and the tab group APIs Tabchef relies on.
  minimum_chrome_version: '116',
};

/**
 * lzma-js (decompress-only build) ends with `this.LZMA = ...` (undefined at ESM top level once bundled)
 * and installs a Worker `onmessage` hook. Neither is wanted: export the decoder and drop the hook.
 * Fails the build if lzma's source changes shape, rather than silently shipping a broken decoder.
 */
const lzmaDecoderFix = {
  name: 'tabchef:lzma-decoder-fix',
  transform(code: string, id: string) {
    if (!id.replace(/\\/g, '/').endsWith('/node_modules/lzma/src/lzma-d.js')) return null;
    const tail = 'this.LZMA = this.LZMA_WORKER = LZMA;';
    const hook = 'typeof onmessage != "undefined"';
    if (!code.includes(tail) || !code.includes(hook)) throw new Error('lzma-d.js changed; update lzmaDecoderFix in wxt.config.ts');
    return { code: code.replace(tail, 'module.exports = { LZMA: LZMA };').replace(hook, 'false'), map: null };
  },
};

/**
 * Built-in recipes are YAML in the repo but JSON in the bundle (D30): `import x from './a.yaml'` (and
 * `import.meta.glob('*.yaml')`) yields the parsed data, so the `yaml` library stays out of the service worker.
 * `?raw` and other queried imports are left to Vite. Shared with vitest.config.ts so tests see the same modules.
 */
export const yamlJson = {
  name: 'tabchef:yaml-json',
  enforce: 'pre' as const,
  load(id: string) {
    if (id.includes('?') || !/\.ya?ml$/.test(id)) return null;
    const data: unknown = parseYaml(readFileSync(id, 'utf8'), { prettyErrors: true });
    return { code: `export default ${JSON.stringify(data)};`, map: null };
  },
};

/**
 * e2e-only build (`npm run e2e:m3`, M3-R86): the mock services run on http://localhost, so the worker may fetch them
 * without a grant (optional permissions cannot be granted in e2e). The same flag reaches the worker as
 * `import.meta.env.WXT_E2E_LOCALHOST` (M3-R35). Never set for `build` / `zip`; the m3 e2e spec's guard checks that.
 */
const e2eLocalhost = process.env.WXT_E2E_LOCALHOST === '1';
// A store package must never carry the localhost grant (M3-R91).
if (e2eLocalhost && process.argv.slice(2).includes('zip')) {
  throw new Error('WXT_E2E_LOCALHOST=1 is for e2e builds only: refusing to zip. Unset it and run `npm run zip` again.');
}

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: e2eLocalhost ? { ...manifestConfig, host_permissions: ['http://localhost/*'] } : manifestConfig,
  modules: ['@wxt-dev/module-svelte'],
  srcDir: 'src',
  vite: () => ({ plugins: [lzmaDecoderFix, yamlJson] }),
});
