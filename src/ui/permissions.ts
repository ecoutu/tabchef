import { browser } from 'wxt/browser';

/**
 * Optional-permission helpers for extension pages. `requestPermissions` must be called synchronously from a click
 * handler (Chrome requires a user gesture); the background never requests permissions.
 */
export interface PermissionRequest { permissions?: string[]; origins?: string[] }
export interface PermissionState { scripting: boolean; notifications: boolean; origins: string[] }

export async function readPermissions(): Promise<PermissionState> {
  const [scripting, notifications, all] = await Promise.all([
    browser.permissions.contains({ permissions: ['scripting'] }),
    browser.permissions.contains({ permissions: ['notifications'] }),
    browser.permissions.getAll(),
  ]);
  return { scripting, notifications, origins: all.origins ?? [] };
}

export function requestPermissions(p: PermissionRequest): Promise<boolean> {
  return browser.permissions.request(p as Parameters<typeof browser.permissions.request>[0]);
}

export function removePermissions(p: PermissionRequest): Promise<boolean> {
  return browser.permissions.remove(p as Parameters<typeof browser.permissions.remove>[0]);
}

/** Calls `cb` when permissions are granted or revoked (also from chrome://extensions); returns an unsubscribe. */
export function onPermissionsChanged(cb: () => void): () => void {
  const fn = (): void => cb();
  browser.permissions.onAdded.addListener(fn);
  browser.permissions.onRemoved.addListener(fn);
  return () => {
    browser.permissions.onAdded.removeListener(fn);
    browser.permissions.onRemoved.removeListener(fn);
  };
}

/** Within the manifest's optional_host_permissions (`https://*\/*`, `http://localhost/*`). */
const SITE = /^(https:\/\/(\*|(\*\.)?[^/*:@?#\s]+)|http:\/\/localhost)\/\S*$/;

/** One match pattern per line, e.g. `https://github.com/*`. */
export function parseSites(text: string): { origins: string[]; errors: string[] } {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return { origins: [], errors: ['Add at least one site, e.g. https://github.com/*'] };
  const errors = lines.filter((l) => !SITE.test(l)).map((l) => `${l} is not a site pattern like https://github.com/*`);
  return { origins: errors.length ? [] : lines, errors };
}
