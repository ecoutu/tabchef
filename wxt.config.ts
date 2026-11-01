import { defineConfig, type UserManifest } from 'wxt';

export const manifestConfig: UserManifest = {
  name: 'Tabchef',
  permissions: ['tabs', 'tabGroups', 'storage', 'contextMenus', 'alarms', 'webNavigation'],
  optional_permissions: ['notifications', 'identity', 'scripting', 'sidePanel', 'bookmarks'],
  optional_host_permissions: ['https://*/*', 'http://localhost/*'],
  options_ui: { page: 'options.html', open_in_tab: true },
};

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: manifestConfig,
  modules: ['@wxt-dev/module-svelte'],
  srcDir: 'src',
});
