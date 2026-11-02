import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { SecretStore, type KeyValueArea } from '../../../src/engine/connections/secret-store';
import { jiraDef } from '../../../src/core/connections/builtin';

const mk = () => new SecretStore({ local: browser.storage.local, session: browser.storage.session });
const all = async (a: 'local' | 'session') => browser.storage[a].get(null);

describe('SecretStore', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('setSecret writes only storage.local conn.secret.<id>', async () => {
    await mk().setSecret('github', { token: 'gho_long_lived_token_1' });
    expect(await all('local')).toEqual({ 'conn.secret.github': { token: 'gho_long_lived_token_1' } });
    expect(await all('session')).toEqual({});
    expect(await mk().getSecret('github')).toEqual({ token: 'gho_long_lived_token_1' });
  });

  it('setAccess writes only storage.session conn.access.<id>', async () => {
    await mk().setAccess('github', { token: 'ghu_short_lived_token_1', expiresAt: 123 });
    expect(await all('session')).toEqual({ 'conn.access.github': { token: 'ghu_short_lived_token_1', expiresAt: 123 } });
    expect(await all('local')).toEqual({});
    expect(await mk().getAccess('github')).toEqual({ token: 'ghu_short_lived_token_1', expiresAt: 123 });
  });

  it('clear removes both and leaves other connections', async () => {
    const s = mk();
    await s.setSecret('github', { token: 't1', refreshToken: 'r1', refreshExpiresAt: 9 });
    await s.setAccess('github', { token: 'a1' });
    await s.setSecret('jira', { token: 't2' });
    await s.clear('github');
    expect(await s.getSecret('github')).toBeUndefined();
    expect(await s.getAccess('github')).toBeUndefined();
    expect(await all('session')).toEqual({});
    expect(await all('local')).toEqual({ 'conn.secret.jira': { token: 't2' } });
  });

  it('ignores malformed stored values', async () => {
    await browser.storage.local.set({ 'conn.secret.github': { token: 42 } });
    await browser.storage.session.set({ 'conn.access.github': 'raw' });
    expect(await mk().getSecret('github')).toBeUndefined();
    expect(await mk().getAccess('github')).toBeUndefined();
  });

  it('knownSecrets: every stored token, refresh token and the Jira email:token pair', async () => {
    const jira = { ...jiraDef('acme.atlassian.net', 'scoped', 'c1'), jira: { site: 'acme.atlassian.net', tokenKind: 'scoped' as const, cloudId: 'c1', email: 'me@x.com' } };
    const custom = { ...jira, id: 'work-jira' };
    await browser.storage.local.set({ connections: [jira, custom] });
    const s = mk();
    await s.setSecret('github', { token: 'gh-secret', refreshToken: 'gh-refresh' });
    await s.setAccess('github', { token: 'gh-access' });
    await s.setSecret('jira', { token: 'ATATTjira' });
    await s.setSecret('work-jira', { token: 'ATATTwork' });
    expect((await s.knownSecrets()).sort()).toEqual(
      ['ATATTjira', 'ATATTwork', 'gh-access', 'gh-refresh', 'gh-secret', 'me@x.com:ATATTjira', 'me@x.com:ATATTwork'].sort(),
    );
  });

  it('knownSecrets is empty when nothing is stored', async () => {
    expect(await mk().knownSecrets()).toEqual([]);
  });

  describe('init (setAccessLevel)', () => {
    const area = (extra: Partial<KeyValueArea> = {}): KeyValueArea => ({
      get: async () => ({}), set: async () => {}, remove: async () => {}, ...extra,
    });

    it('restricts storage.local to trusted contexts when supported', async () => {
      const setAccessLevel = vi.fn(async () => {});
      await new SecretStore({ local: area({ setAccessLevel }), session: area() }).init();
      expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    });

    it('setSecret and setAccess call setAccessLevel before their first write (M3-R46)', async () => {
      const calls: string[] = [];
      const local = area({
        setAccessLevel: async () => { calls.push('setAccessLevel'); },
        set: async (items) => { calls.push(`local.set ${Object.keys(items).join()}`); },
      });
      const session = area({ set: async (items) => { calls.push(`session.set ${Object.keys(items).join()}`); } });
      const s = new SecretStore({ local, session });
      await s.setSecret('github', { token: 't' });
      await s.setAccess('github', { token: 'a' });
      expect(calls).toEqual(['setAccessLevel', 'local.set conn.secret.github', 'session.set conn.access.github']);
    });

    it('setAccess alone also initializes first', async () => {
      const calls: string[] = [];
      const s = new SecretStore({
        local: area({ setAccessLevel: async () => { calls.push('setAccessLevel'); } }),
        session: area({ set: async () => { calls.push('session.set'); } }),
      });
      await s.setAccess('github', { token: 'a' });
      expect(calls).toEqual(['setAccessLevel', 'session.set']);
    });

    it('warns once when unsupported (fakeBrowser) and does not throw', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = mk();
      await s.init();
      await s.init();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('warns once when Chrome rejects it, and does not throw', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = new SecretStore({ local: area({ setAccessLevel: async () => { throw new Error('nope'); } }), session: area() });
      await expect(s.init()).resolves.toBeUndefined();
      await s.init();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
