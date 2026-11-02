import { describe, expect, it } from 'vitest';
import { connectionRows, hhmm } from '../../src/ui/connections-model';
import { builtinConnectionDefs } from '../../src/core/connections/builtin';
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
