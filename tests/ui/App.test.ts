// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Config } from '../../src/core/types';
import { withGroupRules } from '../helpers/config';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import App from '../../src/entrypoints/options/App.svelte';

const withRule = (name = 'Alpha'): Config => withGroupRules([{ id: 'a', name, enabled: true, match: { url: 'a.com/*' }, group: { title: 'A', color: 'blue' } }]);
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
    if (req.type === 'explain.tab') return { ok: true, data: { tab: { id: 12, title: 'T', url: 'https://t.example/' }, hasPageFacts: false, rules: [] } };
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
    stored = withRule('Remote'); rev = 'r2';
    await changed('r2');
    await screen.findByDisplayValue('Remote');
    expect(screen.queryByText('Settings changed elsewhere.')).toBeNull();
  });

  it('shows a banner when dirty; Reload discards edits', async () => {
    render(App);
    await edit();
    rev = 'r2'; stored = withRule('Remote');
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
    expect(set[0].config.rules[0].name).toBe('Edited');
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

describe('App: preview before Save (M2 T13)', () => {
  const effects = { moves: [{ tabId: 1, title: 'A tab', to: 'A' }], closes: [], groupsCreated: ['A'], unchanged: 0, anchorsOpened: 0, dryRun: false };
  const withPreview = (data: unknown) => {
    const base = send.getMockImplementation()!;
    send.mockImplementation(async (req: { type: string }) => (req.type === 'preview.change' ? { ok: true, data } : base(req)));
  };
  const types = () => send.mock.calls.map((c) => c[0].type);

  it('a change with effects opens the dialog; Cancel sends no config.set and keeps the edits', async () => {
    withPreview(effects);
    render(App);
    await edit();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('1 tabs would move, 0 would close.');
    const prev = send.mock.calls.map((c) => c[0]).find((r) => r.type === 'preview.change');
    expect(prev.config.rules[0].name).toBe('Edited');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(types()).not.toContain('config.set');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Apply sends config.set with baseRev', async () => {
    withPreview(effects);
    render(App);
    await edit();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await screen.findByText('Saved.');
    const set = send.mock.calls.map((c) => c[0]).filter((r) => r.type === 'config.set');
    expect(set).toHaveLength(1);
    expect(set[0].baseRev).toBe('r1');
    expect(types().indexOf('preview.change')).toBeLessThan(types().indexOf('config.set'));
  });

  it('a no-op change: no dialog, Save goes straight through', async () => {
    withPreview({ moves: [], closes: [], groupsCreated: [], unchanged: 2, anchorsOpened: 0, dryRun: false });
    render(App);
    await edit();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(types()).toContain('preview.change');
    expect(types()).toContain('config.set');
  });

  it('a change with only dry-run entries saves without opening the dialog (R52)', async () => {
    withPreview({ moves: [{ tabId: 1, title: 'A tab', to: 'A', dryRun: true }], closes: [], groupsCreated: [], unchanged: 0, anchorsOpened: 0, dryRun: false });
    render(App);
    await edit();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(types()).toContain('config.set');
  });

  it('a failed preview saves nothing, keeps the edits and shows the error', async () => {
    const base = send.getMockImplementation()!;
    send.mockImplementation(async (req: { type: string }) => (req.type === 'preview.change' ? { ok: false, error: 'boom' } : base(req)));
    render(App);
    await edit();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Could not preview: boom');
    expect(types()).not.toContain('config.set');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    await edit();
    expect(screen.queryByText('Could not preview: boom')).toBeNull();
  });

  it('an invalid config still reaches config.set, which reports the errors', async () => {
    const base = send.getMockImplementation()!;
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'preview.change') return { ok: false, error: 'invalid config', errors: ['bad config'] };
      if (req.type === 'config.set') return { ok: false, error: 'invalid config', errors: ['bad config'] };
      return base(req);
    });
    render(App);
    await edit();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Could not save:');
    expect(types()).toContain('config.set');
  });
});

describe('App routing (R28, M2 T14)', () => {
  it('#/explain/<tabId> opens the conflict view for that tab, and is not in the nav', async () => {
    window.location.hash = '#/explain/12';
    render(App);
    await screen.findByText('No rule applies to this tab.');
    expect(send.mock.calls.some((c) => c[0].type === 'explain.tab' && c[0].tabId === 12)).toBe(true);
    expect(screen.queryByRole('link', { name: /explain/i })).toBeNull();
  });
});
