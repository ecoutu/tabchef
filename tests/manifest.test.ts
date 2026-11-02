import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifestConfig } from '../wxt.config';

describe('manifest permissions', () => {
  it('declares exactly the required permissions', () => {
    expect(manifestConfig.permissions).toEqual([
      'tabs',
      'tabGroups',
      'storage',
      'contextMenus',
      'alarms',
      'webNavigation',
    ]);
  });

  it('declares exactly the optional permissions', () => {
    expect(manifestConfig.optional_permissions).toEqual([
      'notifications',
      'identity',
      'scripting',
      'sidePanel',
      'bookmarks',
    ]);
  });

  it('declares optional host permissions only', () => {
    expect(manifestConfig.optional_host_permissions).toEqual([
      'https://*/*',
      'http://localhost/*',
    ]);
    expect(manifestConfig.host_permissions).toBeUndefined();
  });

  it('opens options in a tab', () => {
    expect(manifestConfig.options_ui?.open_in_tab).toBe(true);
  });
  it('requires Chrome 116+ (storage.session, sidePanel.open, tab group APIs)', () => {
    expect(manifestConfig.minimum_chrome_version).toBe('116');
  });
  it('M3 T17: the side panel is an unlisted page; sidePanel stays optional (no side_panel key)', () => {
    expect(manifestConfig).not.toHaveProperty('side_panel');
    expect(manifestConfig.permissions).not.toContain('sidePanel');
    expect(manifestConfig.optional_permissions).toContain('sidePanel');
    // WXT adds `side_panel` and a required `sidePanel` for an entrypoint named sidepanel; the panel page is `panel`.
    const entries = readdirSync(new URL('../src/entrypoints/', import.meta.url));
    expect(entries.filter((e) => /^sidepanel/i.test(e) || /\.sidepanel\./i.test(e))).toEqual([]);
    expect(entries).toContain('panel');
  });
});
