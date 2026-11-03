import { describe, expect, it } from 'vitest';
import {
  ALLOWED_API_HOSTS, GITHUB_CLIENT_ID, UNSUPPORTED_HOST_MESSAGE, builtinConnectionDefs, isAllowedBase, jiraDef,
} from '../../../src/core/connections/builtin';
import project from '../../../src/core/project.json' with { type: 'json' };

describe('isAllowedBase', () => {
  it('accepts github.com, api.github.com, *.atlassian.net and api.atlassian.com over https', () => {
    for (const u of ['https://github.com', 'https://api.github.com', 'https://acme.atlassian.net', 'https://api.atlassian.com/ex/jira/abc'])
      expect(isAllowedBase(u), u).toBe(true);
  });

  it('rejects other hosts, http, look-alikes, ports and credentials', () => {
    for (const u of [
      'https://ghe.acme.com', 'http://github.com', 'https://github.com.evil.com', 'https://evilgithub.com',
      'https://atlassian.net', 'https://acme.atlassian.net.evil.com', 'https://a.b.atlassian.net', 'https://github.com:8443',
      'https://user:pw@github.com', 'not a url', '',
    ]) expect(isAllowedBase(u), u).toBe(false);
  });

  it('allows http://localhost only with the e2e flag (off by default)', () => {
    expect(isAllowedBase('http://localhost:4000')).toBe(false);
    expect(isAllowedBase('http://localhost:4000', false)).toBe(false);
    expect(isAllowedBase('http://localhost:4000', true)).toBe(true);
    expect(isAllowedBase('http://127.0.0.1:4000', true)).toBe(false);
  });

  it('lists the v1 hosts and the rejection message', () => {
    expect(ALLOWED_API_HOSTS).toEqual(['github.com', 'api.github.com', '*.atlassian.net', 'api.atlassian.com']);
    expect(UNSUPPORTED_HOST_MESSAGE).toBe('Only github.com and Jira Cloud are supported in this version.');
  });
});

describe('builtinConnectionDefs', () => {
  it('github is the device-code OAuth connection', () => {
    const g = builtinConnectionDefs().github;
    expect(g).toMatchObject({
      id: 'github', kind: 'github', baseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com',
      hosts: ['https://github.com/*', 'https://api.github.com/*'], auth: 'device-code', scopes: [],
      revokeUrl: 'https://github.com/settings/applications',
    });
  });

  it('jira is an unfilled token template', () => {
    const j = builtinConnectionDefs().jira;
    expect(j).toMatchObject({ id: 'jira', kind: 'jira', auth: 'token', hosts: [], baseUrl: '', apiBaseUrl: '' });
  });

  it('returns fresh objects each call', () => {
    const a = builtinConnectionDefs();
    a.github.hosts.push('https://x/*');
    expect(builtinConnectionDefs().github.hosts).toHaveLength(2);
  });

  it('uses the registered GitHub App client id from project.json (M3-R47)', () => {
    expect(GITHUB_CLIENT_ID).toBe(project.githubAppClientId);
  });
});

describe('jiraDef', () => {
  it('scoped: api.atlassian.com base with the cloudId, and both hosts', () => {
    const d = jiraDef('acme.atlassian.net', 'scoped', 'cid-1');
    expect(d).toMatchObject({
      id: 'jira', kind: 'jira', auth: 'token', baseUrl: 'https://acme.atlassian.net',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/cid-1',
      hosts: ['https://acme.atlassian.net/*', 'https://api.atlassian.com/*'],
      jira: { site: 'acme.atlassian.net', tokenKind: 'scoped', cloudId: 'cid-1' },
    });
    expect(isAllowedBase(d.apiBaseUrl)).toBe(true);
  });

  it('classic: the site is the api base and api.atlassian.com is not requested', () => {
    const d = jiraDef('acme.atlassian.net', 'classic');
    expect(d.apiBaseUrl).toBe('https://acme.atlassian.net');
    expect(d.hosts).toEqual(['https://acme.atlassian.net/*']);
    expect(d.jira).toEqual({ site: 'acme.atlassian.net', tokenKind: 'classic' });
  });

  it('scoped before the cloudId is known: empty api base (never the site), api.atlassian.com still requested', () => {
    const d = jiraDef('acme.atlassian.net', 'scoped');
    expect(d.apiBaseUrl).toBe('');
    expect(isAllowedBase(d.apiBaseUrl)).toBe(false);
    expect(d.baseUrl).toBe('https://acme.atlassian.net');
    expect(d.hosts).toContain('https://api.atlassian.com/*');
  });

  it('rejects a site outside *.atlassian.net', () => {
    expect(() => jiraDef('jira.acme.com', 'classic')).toThrow(UNSUPPORTED_HOST_MESSAGE);
    expect(() => jiraDef('https://acme.atlassian.net', 'classic')).toThrow(UNSUPPORTED_HOST_MESSAGE);
  });
});
