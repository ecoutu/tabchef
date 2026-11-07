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
      'sidePanel',
    ]);
  });

  it('declares exactly the optional permissions', () => {
    expect(manifestConfig.optional_permissions).toEqual([
      'notifications',
      'scripting',
      'bookmarks',
    ]);
  });

  it('M4 T14b: bookmarks (project sync) is optional only, never required', () => {
    expect(manifestConfig.permissions).not.toContain('bookmarks');
    expect(manifestConfig.optional_permissions).toContain('bookmarks');
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
  it('M3 T17: the side panel is an unlisted page (no side_panel key); sidePanel is required, not optional', () => {
    expect(manifestConfig).not.toHaveProperty('side_panel');
    // Granted at runtime as an optional permission, any later sidePanel.open() crashes Chrome 156 (whole browser).
    expect(manifestConfig.permissions).toContain('sidePanel');
    expect(manifestConfig.optional_permissions).not.toContain('sidePanel');
    // WXT adds a `side_panel` key for an entrypoint named sidepanel (opened on every action click); the page is `panel`.
    const entries = readdirSync(new URL('../src/entrypoints/', import.meta.url));
    expect(entries.filter((e) => /^sidepanel/i.test(e) || /\.sidepanel\./i.test(e))).toEqual([]);
    expect(entries).toContain('panel');
  });
});
