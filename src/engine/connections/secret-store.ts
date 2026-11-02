import type { ConnectionDef } from '../../core/connections/types';

/** The slice of a browser.storage area SecretStore uses. `setAccessLevel` exists only on Chrome's real areas. */
export interface KeyValueArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(o: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
}
export interface AccessToken { token: string; expiresAt?: number }
export interface StoredSecret { token: string; refreshToken?: string; refreshExpiresAt?: number }

export const CONNECTIONS_KEY = 'connections';
const secretKey = (id: string) => `conn.secret.${id}`;
const accessKey = (id: string) => `conn.access.${id}`;
const BUILTIN_IDS = ['github', 'jira'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The only reader/writer of conn.secret.* (storage.local: long-lived tokens) and conn.access.* (storage.session:
 * short-lived access tokens). Never logs or throws a token.
 */
export class SecretStore {
  private readonly local: KeyValueArea;
  private readonly session: KeyValueArea;
  private initing?: Promise<void>;

  constructor(area: { local: KeyValueArea; session: KeyValueArea }) {
    this.local = area.local;
    this.session = area.session;
  }

  /** Restricts storage.local to trusted contexts where supported; warns once otherwise. Idempotent. */
  init(): Promise<void> {
    this.initing ??= (async () => {
      try {
        if (typeof this.local.setAccessLevel !== 'function') throw new Error('setAccessLevel unsupported');
        await this.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      } catch {
        console.warn('[tabchef] storage.local.setAccessLevel(TRUSTED_CONTEXTS) unavailable; secrets rely on content scripts never reading conn.* keys');
      }
    })();
    return this.initing;
  }

  async getAccess(id: string): Promise<AccessToken | undefined> {
    const v = (await this.session.get(accessKey(id)))[accessKey(id)];
    if (!isObj(v) || typeof v.token !== 'string') return undefined;
    return { token: v.token, ...(typeof v.expiresAt === 'number' && { expiresAt: v.expiresAt }) };
  }

  async setAccess(id: string, t: AccessToken): Promise<void> {
    await this.init();
    await this.session.set({ [accessKey(id)]: t });
  }

  async getSecret(id: string): Promise<StoredSecret | undefined> {
    const v = (await this.local.get(secretKey(id)))[secretKey(id)];
    if (!isObj(v) || typeof v.token !== 'string') return undefined;
    return {
      token: v.token,
      ...(typeof v.refreshToken === 'string' && { refreshToken: v.refreshToken }),
      ...(typeof v.refreshExpiresAt === 'number' && { refreshExpiresAt: v.refreshExpiresAt }),
    };
  }

  async setSecret(id: string, s: StoredSecret): Promise<void> {
    await this.init(); // setAccessLevel before any long-lived token is written (M3-R46)
    await this.local.set({ [secretKey(id)]: s });
  }

  async clear(id: string): Promise<void> {
    await Promise.all([this.local.remove(secretKey(id)), this.session.remove(accessKey(id))]);
  }

  /** Every stored token for redact(): ids from the `connections` metadata (plus the built-ins), and Jira email:token. */
  async knownSecrets(): Promise<string[]> {
    const raw = (await this.local.get(CONNECTIONS_KEY))[CONNECTIONS_KEY];
    const defs = Array.isArray(raw) ? (raw as unknown[]).filter((d): d is ConnectionDef => isObj(d) && typeof d.id === 'string') : [];
    const emails = new Map(defs.map((d) => [d.id, d.jira?.email]));
    const ids = [...new Set([...BUILTIN_IDS, ...defs.map((d) => d.id)])];
    const out = new Set<string>();
    await Promise.all(ids.map(async (id) => {
      const [secret, access] = await Promise.all([this.getSecret(id), this.getAccess(id)]);
      if (secret) {
        out.add(secret.token);
        if (secret.refreshToken) out.add(secret.refreshToken);
        const email = emails.get(id);
        if (typeof email === 'string' && email) out.add(`${email}:${secret.token}`);
      }
      if (access) out.add(access.token);
    }));
    return [...out];
  }
}
