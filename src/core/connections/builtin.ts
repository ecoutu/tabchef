import type { ConnectionDef } from './types';

/**
 * Public client id of the registered Tabchef GitHub App (device flow; read-only Pull requests + Metadata) (M3-R47).
 * Never add a client secret anywhere.
 */
export const GITHUB_CLIENT_ID = 'Iv23liQTWp7D0YtIccKH';

/** v1 API hosts. `*.atlassian.net` means exactly one label below atlassian.net. */
export const ALLOWED_API_HOSTS = ['github.com', 'api.github.com', '*.atlassian.net', 'api.atlassian.com'] as const;
export const UNSUPPORTED_HOST_MESSAGE = 'Only github.com and Jira Cloud are supported in this version.';

const EXACT_HOSTS = new Set(['github.com', 'api.github.com', 'api.atlassian.com']);
const JIRA_SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

/**
 * Whether `url` is a base Tabchef may talk to: https, default port, no credentials, and an allowed host. `e2e` (the
 * WXT_E2E_LOCALHOST build flag, passed in by the engine; core never reads import.meta.env) also allows
 * http(s)://localhost on any port.
 */
export function isAllowedBase(url: string, e2e = false): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (e2e && u.hostname === 'localhost' && (u.protocol === 'http:' || u.protocol === 'https:')) return true;
  if (u.protocol !== 'https:' || u.port !== '') return false;
  return EXACT_HOSTS.has(u.hostname) || JIRA_SITE.test(u.hostname);
}

export function builtinConnectionDefs(): Record<'github' | 'jira', ConnectionDef> {
  return {
    github: {
      id: 'github', kind: 'github', label: 'GitHub',
      baseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com',
      hosts: ['https://github.com/*', 'https://api.github.com/*'],
      // GitHub App: permissions come from the app settings, not OAuth scopes (M3-R47).
      auth: 'device-code', scopes: [],
      revokeUrl: 'https://github.com/settings/applications',
    },
    // Template: jiraDef fills baseUrl, apiBaseUrl and hosts once the user names a site.
    jira: {
      id: 'jira', kind: 'jira', label: 'Jira',
      baseUrl: '', apiBaseUrl: '', hosts: [],
      auth: 'token', scopes: [],
      revokeUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    },
  };
}

/**
 * The Jira connection for `site` (a bare host such as 'acme.atlassian.net'). Scoped tokens call
 * api.atlassian.com/ex/jira/<cloudId> and do not authenticate against the site. An empty `apiBaseUrl` means "cloudId
 * not discovered yet" (Task 4 fills it); api.atlassian.com is already in `hosts` so one permission request covers both.
 * Classic tokens call the site directly.
 */
export function jiraDef(site: string, tokenKind: 'scoped' | 'classic', cloudId?: string): ConnectionDef {
  if (!JIRA_SITE.test(site)) throw new Error(UNSUPPORTED_HOST_MESSAGE);
  const baseUrl = `https://${site}`;
  const scoped = tokenKind === 'scoped';
  return {
    ...builtinConnectionDefs().jira,
    baseUrl,
    apiBaseUrl: !scoped ? baseUrl : cloudId ? `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}` : '',
    hosts: scoped ? [`${baseUrl}/*`, 'https://api.atlassian.com/*'] : [`${baseUrl}/*`],
    jira: { site, tokenKind, ...(cloudId !== undefined && { cloudId }) },
  };
}
