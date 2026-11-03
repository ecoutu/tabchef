import { describe, expect, it } from 'vitest';
import { connectionRows, hhmm } from '../../src/ui/connections-model';
import { builtinConnectionDefs, jiraDef } from '../../src/core/connections/builtin';
import type { ConnectionDef, ConnectionStatus } from '../../src/core/connections/types';

const NOW = new Date(2026, 10, 2, 13, 0).getTime();
const gh = (o: Partial<ConnectionDef> = {}): ConnectionDef => ({ ...builtinConnectionDefs().github, ...o });
const st = (o: Partial<ConnectionStatus> = {}): ConnectionStatus => ({ id: 'github', state: 'ok', ssoRequired: [], scopes: [], ...o });
const row = (d: ConnectionDef, s: ConnectionStatus) => connectionRows([d], [s], NOW)[0]!;

describe('connectionRows', () => {
  it('needs-reauth → "Sign in to GitHub again"', () => {
    expect(row(gh(), st({ state: 'needs-reauth' })).badge).toBe('Sign in to GitHub again');
  });

  it('SSO → a link "Authorize Tabchef for acme (SAML SSO)" to the SSO url', () => {
    const url = 'https://github.com/orgs/acme/sso?authorization_request=x';
    expect(row(gh(), st({ ssoRequired: [{ org: 'acme', url }] })).ssoLinks).toEqual([{ org: 'acme', url, text: 'Authorize Tabchef for acme (SAML SSO)' }]);
  });

  it('SSO links only to https URLs', () => {
    expect(row(gh(), st({ ssoRequired: [{ org: 'x', url: 'javascript:alert(1)' }] })).ssoLinks).toEqual([]);
  });

  it('rate-limited → "GitHub rate limit reached. Retrying at 14:05."', () => {
    const blockedUntil = new Date(2026, 10, 2, 14, 5).getTime();
    expect(row(gh(), st({ state: 'rate-limited', blockedUntil })).badge).toBe('GitHub rate limit reached. Retrying at 14:05.');
    expect(row(gh(), st({ state: 'rate-limited' })).badge).toBe('GitHub rate limit reached.');
  });

  it('M3-R96: stored credentials with missing hosts → "Needs access to api.github.com", stored, the origins to request', () => {
    const r = row(gh({ login: 'octo' }), st({ state: 'not-configured', hostsMissing: ['https://api.github.com/*'] }));
    expect(r).toMatchObject({ badge: 'Needs access to api.github.com', stored: true, hostsMissing: ['https://api.github.com/*'] });
    expect(row(gh(), st({ state: 'not-configured' }))).toMatchObject({ stored: false, hostsMissing: [] });
    expect(row(gh(), st({ state: 'needs-reauth' })).stored).toBe(true);
  });

  it('ok, not-configured and error badges; login, scopes, last used, last error, revoke URL', () => {
    const r = row(gh({ login: 'octo', scopes: ['repo', 'read:org'], auth: 'token' }), st({ lastUsedAt: NOW - 5 * 60_000 }));
    expect(r).toMatchObject({
      id: 'github', label: 'GitHub', state: 'ok', badge: 'Connected', login: 'octo', scopes: 'repo, read:org',
      lastUsed: '5 min ago', revokeUrl: 'https://github.com/settings/applications', auth: 'token',
    });
    expect(row(gh(), st({ state: 'not-configured' }))).toMatchObject({ badge: 'Not connected', lastUsed: 'Never', scopes: '' });
    expect(row(gh(), st({ state: 'error', lastError: 'Network error: x' }))).toMatchObject({ badge: 'Error', lastError: 'Network error: x' });
  });

  it('last used: just now, minutes, hours, days', () => {
    const at = (ms: number) => row(gh(), st({ lastUsedAt: NOW - ms })).lastUsed;
    expect(at(10_000)).toBe('just now');
    expect(at(3 * 3_600_000)).toBe('3 h ago');
    expect(at(2 * 86_400_000)).toBe('2 days ago');
    expect(at(86_400_000)).toBe('1 day ago');
  });

  it('a def without a status reads as not-configured', () => {
    expect(connectionRows([gh()], [], NOW)[0]).toMatchObject({ state: 'not-configured', badge: 'Not connected' });
  });

  it('hhmm pads hours and minutes', () => {
    expect(hhmm(new Date(2026, 0, 1, 9, 7).getTime())).toBe('09:07');
  });
});

describe('connectionRows: Jira', () => {
  const jira = (mode: 'scoped' | 'classic' | 'session', o: Partial<NonNullable<ConnectionDef['jira']>> = {}): ConnectionDef => {
    const d = jiraDef('acme.atlassian.net', mode, mode === 'scoped' ? '00000000-0000-4000-8000-000000000000' : undefined);
    return { ...d, jira: { ...d.jira!, ...(mode !== 'session' && { email: 'user@example.com' }), ...o } };
  };
  const js = (o: Partial<ConnectionStatus> = {}): ConnectionStatus => st({ id: 'jira', ...o });

  it('needs-reauth → "Sign in to Jira again"; rate-limited uses the label', () => {
    expect(row(jira('classic'), js({ state: 'needs-reauth' })).badge).toBe('Sign in to Jira again');
    const blockedUntil = new Date(2026, 10, 2, 14, 5).getTime();
    expect(row(jira('classic'), js({ state: 'rate-limited', blockedUntil })).badge).toBe('Jira rate limit reached. Retrying at 14:05.');
  });

  it('expiry warning: 2–7 days → "in N days", 1 → "in 1 day", none beyond 7 or once expired (lastError carries it)', () => {
    const w = (n: number | undefined) => row(jira('classic'), js({ ...(n !== undefined && { expiresInDays: n }) })).expiryWarning;
    expect(w(3)).toBe('Jira token expires in 3 days');
    expect(w(7)).toBe('Jira token expires in 7 days');
    expect(w(2)).toBe('Jira token expires in 2 days');
    expect(w(1)).toBe('Jira token expires in 1 day');
    expect(w(8)).toBeUndefined();
    expect(w(undefined)).toBeUndefined();
    const expired = row(jira('classic'), js({ state: 'needs-reauth', expiresInDays: 0, lastError: 'Jira token expired' }));
    expect(expired).toMatchObject({ badge: 'Sign in to Jira again', lastError: 'Jira token expired' });
    expect(expired.expiryWarning).toBeUndefined();
  });

  it('site, mode and email; the revoke link for token modes only', () => {
    expect(row(jira('scoped'), js())).toMatchObject({
      site: 'acme.atlassian.net', mode: 'Scoped token', email: 'user@example.com',
      revokeUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    });
    expect(row(jira('classic'), js())).toMatchObject({ mode: 'Classic token', email: 'user@example.com' });
    const session = row(jira('session'), js());
    expect(session).toMatchObject({ site: 'acme.atlassian.net', mode: 'Browser session (read-only)' });
    expect(session.email).toBeUndefined();
    expect(session.revokeUrl).toBeUndefined();
  });

  it('the unconfigured template: no site, mode or email', () => {
    const r = row(builtinConnectionDefs().jira, js({ state: 'not-configured' }));
    expect(r).toMatchObject({ badge: 'Not connected', stored: false });
    expect(r.site).toBeUndefined();
    expect(r.mode).toBeUndefined();
  });

  it('GitHub rows carry no site, mode or expiry warning', () => {
    const r = row(gh(), st({ expiresInDays: 3 }));
    expect(r.site).toBeUndefined();
    expect(r.mode).toBeUndefined();
    expect(r.expiryWarning).toBeUndefined();
  });
});
