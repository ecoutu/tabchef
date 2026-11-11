// @vitest-environment jsdom
// Connections page (M3 T7, GitHub part). Connect GitHub requests both GitHub hosts synchronously inside the click
// handler (the user gesture is lost after an await), then sends connections.github.start and polls while open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { builtinConnectionDefs, jiraDef } from '../../src/core/connections/builtin';
import type { ConnectionDef, ConnectionStatus } from '../../src/core/connections/types';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config } from '../../src/core/types';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Connections from '../../src/entrypoints/options/Connections.svelte';

const HOSTS = ['https://github.com/*', 'https://api.github.com/*'];
const PAT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const START = { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: 0, interval: 5 };

let log: string[];
let defs: ConnectionDef[];
let status: ConnectionStatus[];
let replies: Record<string, unknown[]>;
let request: ReturnType<typeof vi.fn>;
let granted: boolean;

const gh = (o: Partial<ConnectionDef> = {}): ConnectionDef => ({ ...builtinConnectionDefs().github, ...o });
const st = (o: Partial<ConnectionStatus> = {}): ConnectionStatus => ({ id: 'github', state: 'not-configured', ssoRequired: [], scopes: [], ...o });
/** Queues replies for a request type (the last one repeats). */
const reply = (type: string, ...r: unknown[]) => { replies[type] = r; };
const flush = () => vi.advanceTimersByTimeAsync(0);
const sent = (type: string) => send.mock.calls.map(([r]) => r as { type: string }).filter((r) => r.type === type);

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  defs = [gh()];
  status = [st()];
  replies = {};
  granted = true;
  request = vi.fn((p: unknown) => { log.push(`request ${JSON.stringify(p)}`); return Promise.resolve(granted); });
  (browser.permissions as unknown as { request: typeof request }).request = request;
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    log.push(req.type);
    if (req.type === 'connections.list') return { ok: true, data: { defs, status } };
    const q = replies[req.type];
    if (q?.length) return q.length > 1 ? q.shift() : q[0];
    return { ok: true, data: null };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function open(props: { config?: Config | null } = {}) {
  const r = render(Connections, { props });
  await flush();
  return r;
}

describe('Connections page', () => {
  it('names the repositories whose pull requests the GitHub connection cannot read, with what fixes it', async () => {
    status = [st({ state: 'ok' })];
    send.mockImplementation(async (req: { type: string }) => (req.type === 'connections.list'
      ? { ok: true, data: { defs, status, unreadable: [{ repo: 'acme/api', error: 'not-found' }, { repo: 'acme/web', error: 'sso-required' }] } }
      : { ok: true, data: null }));
    await open();
    const card = screen.getByRole('region', { name: 'GitHub' });
    const note = within(card).getByText(/cannot read pull requests in/).closest('p')!;
    expect(note.textContent).toContain('acme/api');
    expect(note.textContent).toContain('acme/web');
    expect(note.textContent).toMatch(/install the Tabchef GitHub App|personal access token/);
  });

  /** The default config with the github-issue recipe on or off. */
  const withIssueRecipe = (enabled: boolean): Config => {
    const c = defaultConfig();
    return { ...c, recipes: c.recipes.map((r) => (r.id === 'github-issue' ? { ...r, enabled } : r)) };
  };

  it('says why GitHub issue data is missing when the GitHub App lacks the Issues permission, with where to accept it', async () => {
    status = [st({ state: 'ok' })];
    send.mockImplementation(async (req: { type: string }) => (req.type === 'connections.list'
      ? { ok: true, data: { defs, status, missingIssues: true } }
      : { ok: true, data: null }));
    await open({ config: withIssueRecipe(true) });
    const card = screen.getByRole('region', { name: 'GitHub' });
    const note = within(card).getByText(/can't read GitHub issues yet/).closest('p')!;
    expect(note.textContent).toContain('Issues (read-only) permission');
    expect(within(note).getByRole('link').getAttribute('href')).toBe('https://github.com/settings/installations');
  });

  it('no Issues permission note while the GitHub issue projects recipe is off (or the config is not loaded yet)', async () => {
    status = [st({ state: 'ok' })];
    send.mockImplementation(async (req: { type: string }) => (req.type === 'connections.list'
      ? { ok: true, data: { defs, status, missingIssues: true } }
      : { ok: true, data: null }));
    for (const config of [withIssueRecipe(false), null]) {
      await open({ config });
      expect(screen.getByRole('region', { name: 'GitHub' })).toBeTruthy();
      expect(screen.queryByText(/can't read GitHub issues yet/)).toBeNull();
      cleanup();
    }
  });

  it('no Issues permission note while issue data is readable', async () => {
    status = [st({ state: 'ok' })];
    await open();
    expect(screen.queryByText(/can't read GitHub issues yet/)).toBeNull();
  });

  it('lists GitHub with its badge; Connect GitHub when not connected', async () => {
    await open();
    expect(screen.getByRole('region', { name: 'GitHub' })).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('Connect GitHub: requests both GitHub hosts synchronously in the click handler, then sends start; shows the code', async () => {
    reply('connections.github.start', { ok: true, data: START });
    reply('connections.github.poll', { ok: true, data: { state: 'pending', interval: 5 } });
    await open();
    log = [];
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    // fireEvent dispatches synchronously: the request was made before any await in the handler.
    expect(request).toHaveBeenCalledWith({ origins: HOSTS });
    await flush();
    expect(log).toEqual([`request ${JSON.stringify({ origins: HOSTS })}`, 'connections.github.start']);
    expect(screen.getByText('WDJB-MJHT')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open github.com/login/device' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/login/device');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });

  it('Copy puts the user code on the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    reply('connections.github.start', { ok: true, data: START });
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await flush();
    await fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await flush();
    expect(writeText).toHaveBeenCalledWith('WDJB-MJHT');
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('a denied permission: no start is sent, an inline message instead', async () => {
    granted = false;
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await flush();
    expect(sent('connections.github.start')).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('Tabchef needs access to github.com and api.github.com to connect GitHub.');
  });

  it('a failed start shows its error', async () => {
    reply('connections.github.start', { ok: false, error: 'GitHub returned an unexpected response' });
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('GitHub returned an unexpected response');
  });

  it('polls on the interval: pending → slow-down (longer interval) → done (list reloaded)', async () => {
    reply('connections.github.start', { ok: true, data: START });
    reply('connections.github.poll',
      { ok: true, data: { state: 'pending', interval: 5 } },
      { ok: true, data: { state: 'slow-down', interval: 10 } },
      { ok: true, data: { state: 'done' } });
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await flush();
    expect(sent('connections.github.poll')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('Waiting for you to enter the code on GitHub');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent('connections.github.poll')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent('connections.github.poll')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent('connections.github.poll')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('GitHub asked Tabchef to check less often');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sent('connections.github.poll')).toHaveLength(2);
    defs = [gh({ login: 'octo' })];
    status = [st({ state: 'ok' })];
    const lists = sent('connections.list').length;
    await vi.advanceTimersByTimeAsync(1);
    expect(sent('connections.github.poll')).toHaveLength(3);
    expect(screen.getByRole('status').textContent).toContain('Connected to GitHub.');
    expect(sent('connections.list').length).toBeGreaterThan(lists);
    expect(document.querySelector('.badge')?.textContent).toBe('Connected');
    expect(screen.getByText(/Signed in as octo/)).toBeTruthy();
    expect(screen.queryByText('WDJB-MJHT')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent('connections.github.poll')).toHaveLength(3);
  });

  it.each([
    ['expired', 'The GitHub sign-in code expired; start again'],
    ['denied', 'GitHub sign-in was cancelled'],
    ['error', 'GitHub sign-in failed: x'],
  ])('a %s poll stops polling and shows its message', async (state, message) => {
    reply('connections.github.start', { ok: true, data: START });
    reply('connections.github.poll', { ok: true, data: { state, message } });
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(screen.queryByText('WDJB-MJHT')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent('connections.github.poll')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });

  it('closing the page stops polling', async () => {
    reply('connections.github.start', { ok: true, data: START });
    reply('connections.github.poll', { ok: true, data: { state: 'pending', interval: 5 } });
    const r = await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent('connections.github.poll')).toHaveLength(1);
    r.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent('connections.github.poll')).toHaveLength(1);
  });

  it('personal access token: a password input; Save sends setToken and clears the field; an error is shown', async () => {
    reply('connections.setToken', { ok: false, error: 'GitHub rejected this token (401)' }, { ok: true, data: st({ state: 'ok' }) });
    await open();
    const form = screen.getByText('Use a personal access token instead').closest('details')!;
    expect(form.textContent).toContain('Fine-grained token (recommended)');
    expect(form.textContent).toMatch(/Pull requests.*Metadata/);
    expect(form.textContent).toMatch(/Pull requests, Issues and Metadata/); // Issues: GitHub issue projects
    expect(form.innerHTML).toContain('Issues: Read-only');
    expect(form.textContent).toMatch(/classic.*repo/);
    const input = screen.getByLabelText('Personal access token') as HTMLInputElement;
    expect(input.type).toBe('password');
    await fireEvent.input(input, { target: { value: PAT } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await flush();
    expect(sent('connections.setToken')).toEqual([{ type: 'connections.setToken', id: 'github', token: PAT }]);
    expect(input.value).toBe('');
    expect(screen.getByRole('alert').textContent).toContain('GitHub rejected this token (401)');
    expect(document.body.innerHTML).not.toContain(PAT);
    defs = [gh({ auth: 'token', login: 'octo' })];
    status = [st({ state: 'ok' })];
    await fireEvent.input(input, { target: { value: PAT } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await flush();
    expect(document.querySelector('.badge')?.textContent).toBe('Connected');
    expect(document.body.innerHTML).not.toContain(PAT);
  });

  it('an empty token is not sent', async () => {
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
    await flush();
    expect(sent('connections.setToken')).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('Paste a token first');
  });

  it('connected: Test connection and Disconnect', async () => {
    defs = [gh({ login: 'octo' })];
    status = [st({ state: 'ok', lastUsedAt: Date.now() })];
    reply('connections.test', { ok: true, data: { login: 'octo' } });
    await open();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await flush();
    expect(sent('connections.test')).toEqual([{ type: 'connections.test', id: 'github' }]);
    expect(screen.getByRole('status').textContent).toContain('Connection works (signed in as octo).');
    status = [st()];
    defs = [gh()];
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await flush();
    expect(sent('connections.disconnect')).toEqual([{ type: 'connections.disconnect', id: 'github' }]);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });

  it('M3-R96: revoked host + stored token: badge names the host; Disconnect and Revoke shown and remove the token; no Connect or Test', async () => {
    defs = [gh({ login: 'octo' })];
    status = [st({ hostsMissing: ['https://api.github.com/*'] })];
    await open();
    expect(screen.getByText('Needs access to api.github.com')).toBeTruthy();
    expect(screen.queryByText('Not connected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Revoke on GitHub' })).toBeTruthy();
    status = [st()];
    defs = [gh()];
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await flush();
    expect(sent('connections.disconnect')).toEqual([{ type: 'connections.disconnect', id: 'github' }]);
    expect(screen.getByText('Not connected')).toBeTruthy();
  });

  it('M3-R96: Grant access requests exactly the missing hosts synchronously and starts no device flow', async () => {
    defs = [gh({ login: 'octo' })];
    status = [st({ hostsMissing: ['https://api.github.com/*'] })];
    await open();
    log = [];
    status = [st({ state: 'ok' })]; // what the worker lists once the host is granted
    await fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.github.com/*'] });
    await flush();
    expect(log[0]).toBe(`request ${JSON.stringify({ origins: ['https://api.github.com/*'] })}`);
    expect(sent('connections.github.start')).toEqual([]);
    expect(log).toEqual([`request ${JSON.stringify({ origins: ['https://api.github.com/*'] })}`, 'connections.list']);
    expect(document.querySelector('.badge')?.textContent).toBe('Connected');
  });

  it('M3-R96: a denied Grant access shows a message and starts nothing', async () => {
    defs = [gh({ login: 'octo' })];
    status = [st({ hostsMissing: ['https://api.github.com/*'] })];
    granted = false;
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('api.github.com');
    expect(sent('connections.github.start')).toEqual([]);
  });

  it('T7 fix: Disconnect cancels a device flow in progress before sending disconnect; no poll follows', async () => {
    defs = [gh({ login: 'octo' })];
    status = [st({ state: 'needs-reauth' })];
    reply('connections.github.start', { ok: true, data: START });
    reply('connections.github.poll', { ok: true, data: { state: 'pending', interval: 5 } });
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await flush();
    expect(screen.getByText('WDJB-MJHT')).toBeTruthy();
    log = [];
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    // The flow is cancelled synchronously, before the disconnect request goes out.
    expect(screen.queryByText('WDJB-MJHT')).toBeNull();
    await flush();
    expect(log[0]).toBe('connections.disconnect');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent('connections.github.poll')).toHaveLength(0);
  });

  it('T7 fix: a permission prompt answered after the page closed sends no start', async () => {
    let answer!: (v: boolean) => void;
    request.mockImplementation(() => new Promise<boolean>((res) => { answer = res; }));
    const r = await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    r.unmount();
    answer(true);
    await flush();
    expect(sent('connections.github.start')).toEqual([]);
  });

  it('T7 fix: a rate-limited row re-lists once at blockedUntil (stale badge); the timer stops on unmount', async () => {
    status = [st({ state: 'rate-limited', blockedUntil: Date.now() + 120_000 })];
    const r = await open();
    const lists = () => sent('connections.list').length;
    expect(lists()).toBe(1);
    status = [st({ state: 'ok' })];
    await vi.advanceTimersByTimeAsync(119_000);
    expect(lists()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lists()).toBe(2);
    expect(document.querySelector('.badge')?.textContent).toBe('Connected');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(lists()).toBe(2);
    // A far-off block is re-checked at the clamp (1 h), and nothing fires after unmount.
    cleanup();
    status = [st({ state: 'rate-limited', blockedUntil: Date.now() + 86_400_000 })];
    send.mockClear();
    const r2 = await open();
    await vi.advanceTimersByTimeAsync(3_600_000 + 1_000);
    expect(lists()).toBe(2);
    r2.unmount();
    await vi.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(lists()).toBe(2);
    void r;
  });

  it('a failed test shows the error', async () => {
    status = [st({ state: 'ok' })];
    reply('connections.test', { ok: false, error: 'GitHub server error (502)' });
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('GitHub server error (502)');
  });

  it('needs-reauth, SAML SSO and rate-limited copy', async () => {
    const url = 'https://github.com/orgs/acme/sso?authorization_request=x';
    status = [st({ state: 'needs-reauth', ssoRequired: [{ org: 'acme', url }] })];
    await open();
    expect(screen.getByText('Sign in to GitHub again')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
    const sso = screen.getByRole('link', { name: 'Authorize Tabchef for acme (SAML SSO)' }) as HTMLAnchorElement;
    expect(sso.href).toBe(url);
    cleanup();
    status = [st({ state: 'rate-limited', blockedUntil: new Date(2026, 10, 2, 14, 5).getTime() })];
    await open();
    expect(screen.getByText('GitHub rate limit reached. Retrying at 14:05.')).toBeTruthy();
  });

  it('a connections.changed broadcast reloads the list', async () => {
    await open();
    status = [st({ state: 'needs-reauth' })];
    await (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> }).trigger({ type: 'connections.changed', id: 'github' });
    await flush();
    expect(screen.getByText('Sign in to GitHub again')).toBeTruthy();
  });

  it('a failed list shows its error', async () => {
    send.mockImplementation(async () => ({ ok: false, error: 'connections unavailable' }));
    await open();
    expect(screen.getByRole('alert').textContent).toContain('connections unavailable');
  });
});

describe('Connections page: Jira', () => {
  const JTOKEN = 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789';
  const EMAIL = 'user@example.com';
  const SITE = 'acme.atlassian.net';
  const SCOPED_HOSTS = ['https://acme.atlassian.net/*', 'https://api.atlassian.com/*'];
  const SITE_HOSTS = ['https://acme.atlassian.net/*'];
  const js = (o: Partial<ConnectionStatus> = {}): ConnectionStatus => st({ id: 'jira', ...o });
  const jd = (mode: 'scoped' | 'classic' | 'session', o: Partial<NonNullable<ConnectionDef['jira']>> = {}): ConnectionDef => {
    const d = jiraDef(SITE, mode, mode === 'scoped' ? '00000000-0000-4000-8000-000000000000' : undefined);
    return { ...d, jira: { ...d.jira!, ...(mode !== 'session' && { email: EMAIL }), ...o } };
  };
  const card = () => within(screen.getByRole('region', { name: 'Jira' }));
  const field = (label: string) => card().getByLabelText(label) as HTMLInputElement;
  async function fill(o: { site?: string; email?: string; token?: string; classic?: boolean; expiry?: string } = {}) {
    await fireEvent.input(field('Jira site'), { target: { value: o.site ?? SITE } });
    await fireEvent.input(field('Atlassian account email'), { target: { value: o.email ?? EMAIL } });
    await fireEvent.input(field('API token'), { target: { value: o.token ?? JTOKEN } });
    if (o.classic) await fireEvent.click(field('Classic API token'));
    if (o.expiry !== undefined) await fireEvent.input(field('Token expiry (optional)'), { target: { value: o.expiry } });
  }
  const connect = () => fireEvent.click(card().getByRole('button', { name: 'Connect Jira' }));

  beforeEach(() => {
    defs = [gh(), builtinConnectionDefs().jira];
    status = [st(), js()];
  });

  it('not connected: the form (site placeholder, email, password token, kind radios, expiry date) and the session action', async () => {
    await open();
    expect(card().getByText('Not connected')).toBeTruthy();
    expect(field('Jira site').placeholder).toBe('your-site.atlassian.net');
    expect(field('Atlassian account email').type).toBe('email');
    expect(field('API token').type).toBe('password');
    expect(field('Scoped API token — recommended').checked).toBe(true);
    expect(field('Classic API token').type).toBe('radio');
    expect(field('Token expiry (optional)').type).toBe('date');
    expect(card().getByRole('button', { name: 'Use my browser session instead (read-only, best effort)' })).toBeTruthy();
    const create = card().getByRole('link', { name: /Create a token/ }) as HTMLAnchorElement;
    expect(create.href).toBe('https://id.atlassian.com/manage-profile/security/api-tokens');
    expect(card().queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(card().queryByRole('button', { name: 'Test connection' })).toBeNull();
  });

  it('help: scopes, where to create tokens, why the expiry, and what session mode is', async () => {
    await open();
    const tips = [...document.querySelectorAll('section[aria-labelledby="conn-jira"] [role="tooltip"], section[aria-labelledby="conn-jira"] .help-tip')]
      .map((e) => e.textContent).join(' ');
    expect(tips).toContain('read:jira-work');
    expect(tips).toContain('read:jira-user');
    expect(tips).toContain('https://id.atlassian.com/manage-profile/security/api-tokens');
    expect(tips).toMatch(/Atlassian does not report/);
    expect(tips).toMatch(/third-party cookies/);
  });

  it('Connect Jira (scoped): requests both hosts synchronously in the handler, then sends setToken; the token field is cleared', async () => {
    reply('connections.setToken', { ok: true, data: js({ state: 'ok' }) });
    await open();
    await fill();
    log = [];
    await connect();
    expect(request).toHaveBeenCalledWith({ origins: SCOPED_HOSTS });
    expect(field('API token').value).toBe('');
    await flush();
    expect(log.slice(0, 2)).toEqual([`request ${JSON.stringify({ origins: SCOPED_HOSTS })}`, 'connections.setToken']);
    expect(sent('connections.setToken')).toEqual([{ type: 'connections.setToken', id: 'jira', token: JTOKEN, jira: { site: SITE, email: EMAIL, tokenKind: 'scoped' } }]);
    expect(screen.getByRole('status').textContent).toContain('Connected to Jira.');
    expect(document.body.innerHTML).not.toContain(JTOKEN);
  });

  it('classic: requests the site only; the expiry date → expiresAt at the end of that local day', async () => {
    await open();
    const d = new Date(Date.now() + 3 * 86_400_000);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await fill({ classic: true, expiry: ymd, site: ' ACME.atlassian.net ' });
    await connect();
    expect(request).toHaveBeenCalledWith({ origins: SITE_HOSTS });
    await flush();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
    expect(sent('connections.setToken')).toEqual([{ type: 'connections.setToken', id: 'jira', token: JTOKEN, jira: { site: SITE, email: EMAIL, tokenKind: 'classic', expiresAt: end } }]);
  });

  it.each([
    ['an invalid site', { site: 'https://acme.atlassian.net/' }, 'Enter your Jira site, like your-site.atlassian.net.'],
    ['a site outside Jira Cloud', { site: 'jira.example.com' }, 'Enter your Jira site, like your-site.atlassian.net.'],
    ['no email', { email: ' ' }, 'Enter the email address of your Atlassian account.'],
    ['no token', { token: '' }, 'Paste a token first.'],
    ['a past expiry date', { expiry: '2020-01-01' }, 'The expiry date is in the past.'],
  ])('%s: an inline error, no permission request, nothing sent', async (_, o, message) => {
    await open();
    await fill(o);
    await connect();
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(sent('connections.setToken')).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain(message);
  });

  it('a denied permission: an inline message, nothing sent', async () => {
    granted = false;
    await open();
    await fill();
    await connect();
    await flush();
    expect(sent('connections.setToken')).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('Tabchef needs access to acme.atlassian.net and api.atlassian.com to connect Jira.');
  });

  it('a rejected token shows its error', async () => {
    reply('connections.setToken', { ok: false, error: 'Jira rejected this token (401)' });
    await open();
    await fill();
    await connect();
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('Jira rejected this token (401)');
    expect(field('API token').value).toBe('');
  });

  it('browser session: requests the site host synchronously, then sends setSession', async () => {
    reply('connections.setSession', { ok: true, data: js({ state: 'ok' }) });
    await open();
    await fireEvent.input(field('Jira site'), { target: { value: SITE } });
    log = [];
    await fireEvent.click(card().getByRole('button', { name: 'Use my browser session instead (read-only, best effort)' }));
    expect(request).toHaveBeenCalledWith({ origins: SITE_HOSTS });
    await flush();
    expect(log.slice(0, 2)).toEqual([`request ${JSON.stringify({ origins: SITE_HOSTS })}`, 'connections.setSession']);
    expect(sent('connections.setSession')).toEqual([{ type: 'connections.setSession', site: SITE }]);
  });

  it('browser session with an invalid site or a denied permission: nothing sent', async () => {
    await open();
    await fireEvent.click(card().getByRole('button', { name: 'Use my browser session instead (read-only, best effort)' }));
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Enter your Jira site, like your-site.atlassian.net.');
    granted = false;
    await fireEvent.input(field('Jira site'), { target: { value: SITE } });
    await fireEvent.click(card().getByRole('button', { name: 'Use my browser session instead (read-only, best effort)' }));
    await flush();
    expect(sent('connections.setSession')).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('Tabchef needs access to acme.atlassian.net to connect Jira.');
  });

  it('connected (scoped token): site, mode, email, last used, Test, Disconnect and the revoke link; no form', async () => {
    defs = [gh(), jd('scoped')];
    status = [st(), js({ state: 'ok', lastUsedAt: Date.now() })];
    reply('connections.test', { ok: true, data: { displayName: 'Test User' } });
    await open();
    expect(card().getByText('Connected')).toBeTruthy();
    expect(card().getByText(SITE)).toBeTruthy();
    expect(card().getByText('Scoped token')).toBeTruthy();
    expect(card().getByText(EMAIL)).toBeTruthy();
    expect(card().getByText('just now')).toBeTruthy();
    expect((card().getByRole('link', { name: 'Revoke on Atlassian' }) as HTMLAnchorElement).href).toBe('https://id.atlassian.com/manage-profile/security/api-tokens');
    expect(card().queryByRole('button', { name: 'Connect Jira' })).toBeNull();
    await fireEvent.click(card().getByRole('button', { name: 'Test connection' }));
    await flush();
    expect(sent('connections.test')).toEqual([{ type: 'connections.test', id: 'jira' }]);
    expect(screen.getByRole('status').textContent).toContain('Connection works (signed in as Test User).');
    defs = [gh(), builtinConnectionDefs().jira];
    status = [st(), js()];
    await fireEvent.click(card().getByRole('button', { name: 'Disconnect' }));
    await flush();
    expect(sent('connections.disconnect')).toEqual([{ type: 'connections.disconnect', id: 'jira' }]);
    expect(card().getByText('Not connected')).toBeTruthy();
    expect(card().getByRole('button', { name: 'Connect Jira' })).toBeTruthy();
  });

  it('connected (classic / browser session): the mode; session shows no email and no revoke link', async () => {
    defs = [gh(), jd('classic')];
    status = [st(), js({ state: 'ok' })];
    await open();
    expect(card().getByText('Classic token')).toBeTruthy();
    cleanup();
    defs = [gh(), jd('session')];
    await open();
    expect(card().getByText('Browser session (read-only)')).toBeTruthy();
    expect(card().queryByText(EMAIL)).toBeNull();
    expect(card().queryByRole('link', { name: 'Revoke on Atlassian' })).toBeNull();
    expect(card().getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('expiry warning, and an expired token (needs-reauth): the badge, the error once, and the form again (prefilled)', async () => {
    defs = [gh(), jd('classic')];
    status = [st(), js({ state: 'ok', expiresInDays: 3 })];
    await open();
    expect(card().getByText('Jira token expires in 3 days')).toBeTruthy();
    cleanup();
    status = [st(), js({ state: 'needs-reauth', expiresInDays: 0, lastError: 'Jira token expired' })];
    await open();
    expect(card().getByText('Sign in to Jira again')).toBeTruthy();
    expect(card().getAllByText('Jira token expired')).toHaveLength(1);
    expect(card().getByRole('button', { name: 'Connect Jira' })).toBeTruthy();
    expect(field('Jira site').value).toBe(SITE);
    expect(field('Atlassian account email').value).toBe(EMAIL);
    expect(field('Classic API token').checked).toBe(true);
    expect(field('API token').value).toBe('');
  });

  it('M3-R96: revoked host access: Grant access requests only the missing hosts; Disconnect stays', async () => {
    defs = [gh(), jd('scoped')];
    status = [st(), js({ state: 'not-configured', hostsMissing: ['https://api.atlassian.com/*'] })];
    await open();
    expect(card().getByText('Needs access to api.atlassian.com')).toBeTruthy();
    expect(card().queryByRole('button', { name: 'Connect Jira' })).toBeNull();
    expect(card().getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    log = [];
    await fireEvent.click(card().getByRole('button', { name: 'Grant access' }));
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.atlassian.com/*'] });
    await flush();
    expect(log).toEqual([`request ${JSON.stringify({ origins: ['https://api.atlassian.com/*'] })}`, 'connections.list']);
    expect(sent('connections.setToken')).toEqual([]);
  });
});
