import type { AuthStyle, ConnectionDef, ConnectionState, ConnectionStatus } from '../core/connections/types';

/** One row of the Connections page. Metadata only: tokens never reach the UI. */
export interface ConnectionRow {
  id: string;
  label: string;
  auth: AuthStyle;
  state: ConnectionState;
  badge: string;
  /** The account name, when known. */
  login?: string;
  /** OAuth scopes ("repo, read:org"); '' for GitHub App user tokens and fine-grained tokens. */
  scopes: string;
  lastUsed: string;
  lastError?: string;
  ssoLinks: { org: string; url: string; text: string }[];
  /** "Jira token expires in 3 days" when 1–7 days are left (once expired, lastError says so). */
  expiryWarning?: string;
  /** Token modes only: a browser session has no token to revoke. */
  revokeUrl?: string;
  /** Jira: the site host, the mode, and the account email (token modes). */
  site?: string;
  mode?: string;
  email?: string;
  /** Credentials are stored (connected, or connected but blocked): Disconnect and Revoke apply in every state. */
  stored: boolean;
  /** Host patterns to request with Grant access: credentials are stored but these are not granted (M3-R96). */
  hostsMissing: string[];
}

/** Local HH:MM. */
export function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ago(at: number | undefined, now: number): string {
  if (at === undefined) return 'Never';
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** "api.github.com" from "https://api.github.com/*". */
export const hostName = (origin: string) => origin.replace(/^https?:\/\/|\/\*$/g, '');

function badgeOf(def: ConnectionDef, s: ConnectionStatus): string {
  if (s.hostsMissing?.length) return `Needs access to ${s.hostsMissing.map(hostName).join(' and ')}`;
  switch (s.state) {
    case 'ok': return 'Connected';
    case 'not-configured': return 'Not connected';
    case 'needs-reauth': return `Sign in to ${def.label} again`;
    case 'rate-limited':
      return `${def.label} rate limit reached.${s.blockedUntil !== undefined ? ` Retrying at ${hhmm(s.blockedUntil)}.` : ''}`;
    case 'error': return 'Error';
  }
}

const JIRA_MODES = { scoped: 'Scoped token', classic: 'Classic token' } as const;
const JIRA_SESSION_MODE = 'Browser session (read-only)';

/** The Jira site, mode and email; nothing for the unconfigured template or another kind. */
function jiraFields(def: ConnectionDef): Pick<ConnectionRow, 'site' | 'mode' | 'email'> {
  const j = def.kind === 'jira' ? def.jira : undefined;
  if (!j?.site) return {};
  const mode = def.auth === 'session' ? JIRA_SESSION_MODE : j.tokenKind ? JIRA_MODES[j.tokenKind] : undefined;
  return {
    site: j.site,
    ...(mode !== undefined && { mode }),
    ...(def.auth !== 'session' && j.email !== undefined && { email: j.email }),
  };
}

/** Ruling M3-R103: 2–7 days → "in N days", 1 → "in 1 day"; 0 (expired) is the lastError instead. */
function expiryWarning(def: ConnectionDef, s: ConnectionStatus): string | undefined {
  const n = s.expiresInDays;
  if (def.kind !== 'jira' || n === undefined || n < 1 || n > 7) return undefined;
  return `${def.label} token expires in ${n} ${n === 1 ? 'day' : 'days'}`;
}

const isHttps = (u: string) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The Connections page rows, in `defs` order; a def without a status is not-configured. */
export function connectionRows(defs: ConnectionDef[], status: ConnectionStatus[], now: number): ConnectionRow[] {
  return defs.map((def) => {
    const s = status.find((x) => x.id === def.id) ?? { id: def.id, state: 'not-configured', ssoRequired: [], scopes: [] };
    const warning = expiryWarning(def, s);
    return {
      id: def.id,
      label: def.label,
      auth: def.auth,
      state: s.state,
      badge: badgeOf(def, s),
      ...(def.login !== undefined && { login: def.login }),
      scopes: def.scopes.join(', '),
      lastUsed: ago(s.lastUsedAt, now),
      ...(s.lastError !== undefined && { lastError: s.lastError }),
      ssoLinks: s.ssoRequired.filter((x) => isHttps(x.url)).map((x) => ({ ...x, text: `Authorize Tabchef for ${x.org} (SAML SSO)` })),
      ...(warning !== undefined && { expiryWarning: warning }),
      ...(def.revokeUrl !== undefined && def.auth !== 'session' && { revokeUrl: def.revokeUrl }),
      ...jiraFields(def),
      stored: s.state !== 'not-configured' || !!s.hostsMissing?.length,
      hostsMissing: s.hostsMissing ?? [],
    };
  });
}

/** The end (23:59:59.999 local) of a date input's day ('2026-11-05'), or undefined for anything else. */
export function endOfLocalDay(ymd: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = new Date(y, mo, d, 23, 59, 59, 999);
  return at.getFullYear() === y && at.getMonth() === mo && at.getDate() === d ? at.getTime() : undefined;
}
