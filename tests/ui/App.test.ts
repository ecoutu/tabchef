// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config } from '../../src/core/types';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import App from '../../src/entrypoints/options/App.svelte';

const withRule = (): Config => ({ ...defaultConfig(), groupRules: [{ id: 'a', name: 'Alpha', enabled: true, match: { url: 'a.com/*' }, group: { title: 'A', color: 'blue' } }] });
let stored: Config; let rev: string; let status: { syncing: boolean; warning?: string };
const changed = (r: string) => (fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown) => Promise<unknown> }).trigger({ type: 'config.changed', rev: r });

beforeEach(() => {
  window.location.hash = '#/rules';
  stored = withRule(); rev = 'r1'; status = { syncing: false };
  send.mockReset();
  send.mockImplementation(async (req: { type: string; config?: Config; baseRev?: string }) => {
    if (req.type === 'config.get') return { ok: true, data: { config: stored, rev } };
    if (req.type === 'tabs.list') return { ok: true, data: [] };
    if (req.type === 'config.status') return { ok: true, data: status };
    if (req.type === 'config.set') {
      if (req.baseRev !== undefined && req.baseRev !== rev) return { ok: false, error: 'conflict' };
      stored = req.config!; rev = 'r-saved'; return { ok: true, data: null };
    }
    return { ok: true, data: [] };
  });
});
afterEach(cleanup);

const gets = () => send.mock.calls.filter((c) => c[0].type === 'config.get').length;
const edit = async () => { await fireEvent.input(await screen.findByLabelText('Rule name'), { target: { value: 'Edited' } }); };

describe('App config concurrency', () => {
  it('reloads silently when a remote change arrives and nothing is dirty', async () => {
    render(App);
    await screen.findByDisplayValue('Alpha');
    stored = { ...withRule(), groupRules: [{ ...withRule().groupRules[0]!, name: 'Remote' }] }; rev = 'r2';
    await changed('r2');
    await screen.findByDisplayValue('Remote');
    expect(screen.queryByText('Settings changed elsewhere.')).toBeNull();
  });

  it('shows a banner when dirty; Reload discards edits', async () => {
    render(App);
    await edit();
    rev = 'r2'; stored = { ...withRule(), groupRules: [{ ...withRule().groupRules[0]!, name: 'Remote' }] };
    await changed('r2');
    await screen.findByText('Settings changed elsewhere.');
    await fireEvent.click(screen.getByRole('button', { name: 'Reload (discard my edits)' }));
    await screen.findByDisplayValue('Remote');
    expect(screen.queryByText('Settings changed elsewhere.')).toBeNull();
  });

  it('Keep my edits makes the next Save send the new rev', async () => {
    render(App);
    await edit();
    rev = 'r2';
    await changed('r2');
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep my edits' }));
    await waitFor(() => expect(screen.queryByText('Settings changed elsewhere.')).toBeNull());
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const set = send.mock.calls.map((c) => c[0]).filter((r) => r.type === 'config.set');
    expect(set).toHaveLength(1);
    expect(set[0].baseRev).toBe('r2');
    expect(set[0].config.groupRules[0].name).toBe('Edited');
  });

  it('Save sends baseRev, and a conflict response shows the banner', async () => {
    render(App);
    await edit();
    rev = 'r9'; // changed behind our back, no broadcast received
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Settings changed elsewhere.');
    const set = send.mock.calls.map((c) => c[0]).find((r) => r.type === 'config.set');
    expect(set.baseRev).toBe('r1');
    expect(gets()).toBe(1);
  });
});

describe('App sync status (I5)', () => {
  it('shows the sync warning banner from config.status, and refreshes it when the config changes', async () => {
    status = { syncing: false, warning: 'Could not sync config; saved on this device and will retry.' };
    render(App);
    expect((await screen.findByText('Could not sync config; saved on this device and will retry.')).closest('[role="alert"]')).not.toBeNull();
    status = { syncing: false, warning: 'Synced settings were found and loaded; your change on this device was saved as a backup.' };
    rev = 'r2';
    await changed('r2');
    await screen.findByText('Synced settings were found and loaded; your change on this device was saved as a backup.');
  });

  it('shows no banner without a warning', async () => {
    render(App);
    await screen.findByDisplayValue('Alpha');
    await waitFor(() => expect(send.mock.calls.some((c) => c[0].type === 'config.status')).toBe(true));
    expect(screen.queryByTestId('sync-warning')).toBeNull();
  });
});
