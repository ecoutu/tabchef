import { defineConfig, type UserManifest } from 'wxt';

export const manifestConfig: UserManifest = {
  name: 'Tabchef',
  permissions: ['tabs', 'tabGroups', 'storage', 'contextMenus', 'alarms', 'webNavigation'],
  optional_permissions: ['notifications', 'identity', 'scripting', 'sidePanel', 'bookmarks'],
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

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: manifestConfig,
  modules: ['@wxt-dev/module-svelte'],
  srcDir: 'src',
  vite: () => ({ plugins: [lzmaDecoderFix] }),
});
