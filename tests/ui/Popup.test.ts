// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Popup from '../../src/entrypoints/popup/App.svelte';

let locked: number[];
let warning: string | undefined;
let dryRun: boolean;

beforeEach(() => {
  fakeBrowser.reset();
  locked = [];
  warning = undefined;
  dryRun = false;
  (vi.spyOn(browser.tabs, 'query') as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([{ id: 5 }]);
  send.mockReset();
  send.mockImplementation(async (req: { type: string; tabId?: number }) => {
    switch (req.type) {
      case 'dupes.list': return { ok: true, data: { sets: [], pending: [] } };
      case 'safety.status': return { ok: true, data: { paused: false, locked } };
      case 'recent.list': return { ok: true, data: [] };
      case 'config.get': return { ok: true, data: { config: { dryRun }, rev: 'r' } };
      case 'config.status': return { ok: true, data: warning ? { syncing: false, warning } : { syncing: false } };
      case 'tab.lock': locked = [...locked, req.tabId!]; return { ok: true, data: null };
      case 'tab.unlock': locked = locked.filter((x) => x !== req.tabId); return { ok: true, data: null };
      default: return { ok: true, data: null };
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Popup', () => {
  it('shows a one-line sync warning when present (I5)', async () => {
    warning = 'Config too large to sync; saved on this device only.';
    render(Popup);
    expect((await screen.findByText(warning)).getAttribute('role')).toBe('status');
  });

  it('no warning line without a warning', async () => {
    render(Popup);
    await waitFor(() => expect(send.mock.calls.some((c) => c[0].type === 'config.status')).toBe(true));
    expect(screen.queryByTestId('sync-warning')).toBeNull();
  });

  it('header shows a "Dry run" chip only while global dry run is on (M2 T12)', async () => {
    render(Popup);
    await waitFor(() => expect(send.mock.calls.some((c) => c[0].type === 'config.get')).toBe(true));
    expect(screen.queryByText('Dry run')).toBeNull();
    cleanup();
    dryRun = true;
    render(Popup);
    expect(await screen.findByText('Dry run')).toBeTruthy();
  });

  it('header Lock current tab locks the active tab, then offers Unlock', async () => {
    render(Popup);
    await fireEvent.click(await screen.findByRole('button', { name: 'Lock current tab' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.lock', tabId: 5 });
    await fireEvent.click(await screen.findByRole('button', { name: 'Unlock current tab' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.unlock', tabId: 5 });
    await screen.findByRole('button', { name: 'Lock current tab' });
  });
});
