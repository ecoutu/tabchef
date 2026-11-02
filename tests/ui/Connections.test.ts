// @vitest-environment jsdom
// Connections page (M3 T7, GitHub part). Connect GitHub requests both GitHub hosts synchronously inside the click
// handler (the user gesture is lost after an await), then sends connections.github.start and polls while open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { builtinConnectionDefs } from '../../src/core/connections/builtin';
import type { ConnectionDef, ConnectionStatus } from '../../src/core/connections/types';

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

async function open() {
  const r = render(Connections);
  await flush();
  return r;
}

describe('Connections page', () => {
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
