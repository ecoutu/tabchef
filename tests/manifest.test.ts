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
});
