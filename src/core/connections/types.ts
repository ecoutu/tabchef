// Connection model shared by core, engine and UI. Metadata only: tokens never appear in these types.
export type AuthStyle = 'device-code' | 'token' | 'session' | 'oauth-pkce' | 'oauth-proxy'; // M3 implements the first three
export type ConnectionKind = 'github' | 'jira' | 'custom';
export interface ConnectionDef {
  id: string; // 'github' | 'jira' | user id ^[a-z0-9][a-z0-9-]{0,62}$
  kind: ConnectionKind;
  label: string;
  baseUrl: string; // 'https://github.com' | 'https://acme.atlassian.net'
  apiBaseUrl: string; // 'https://api.github.com' | 'https://api.atlassian.com/ex/jira/<cloudId>' | 'https://acme.atlassian.net'
  hosts: string[]; // origins it needs, e.g. ['https://github.com/*','https://api.github.com/*']
  auth: AuthStyle;
  scopes: string[];
  jira?: { site: string; email?: string; tokenKind: 'scoped' | 'classic'; cloudId?: string; tokenExpiresAt?: number };
  revokeUrl?: string; // shown on the Connections page
  login?: string; // account name shown on the Connections page (metadata only)
}
export type ConnectionState = 'not-configured' | 'ok' | 'needs-reauth' | 'rate-limited' | 'error';
export interface ConnectionStatus {
  id: string;
  state: ConnectionState;
  lastUsedAt?: number;
  lastError?: string;
  blockedUntil?: number;
  ssoRequired: { org: string; url: string }[];
  expiresInDays?: number;
  scopes: string[];
}
export interface ApiRequest {
  method: 'GET' | 'POST';
  path: string; // relative to apiBaseUrl, starts with '/'
  query?: Record<string, string>;
  json?: unknown;
  background?: boolean; // subject to the 10% budget rule
}
export type ConnErrorKind =
  | 'not-configured' | 'unauthorized' | 'sso-required' | 'rate-limited' | 'not-found'
  | 'network' | 'timeout' | 'server' | 'bad-request' | 'read-only';
export type ApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; kind: ConnErrorKind; status?: number; message: string; retryAt?: number; sso?: { org: string; url: string } };
