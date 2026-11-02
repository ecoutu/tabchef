// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import type { Config } from '../../src/core/types';
import { v1Config, withGroupRules } from '../helpers/config';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Backups from '../../src/entrypoints/options/Backups.svelte';

const rule = (id: string) => ({ id, name: id, enabled: true, match: { url: 'a.com/*' }, group: { title: id, color: 'blue' as const } });
const cfgWith = (...ids: string[]): Config => withGroupRules(ids.map(rule));
const UNSAVED = 'You have unsaved changes on this page; they will be discarded.';

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => req.type === 'config.backups' ? { ok: true, data: [{ at: 1000, config: cfgWith('x') }] } : { ok: true, data: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const file = (content: string, size?: number): File => {
  const f = new File([content], 'c.json', { type: 'application/json' });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return f;
};
const pick = async (f: File) => {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  await fireEvent.change(input, { target: { files: [f] } });
};
const props = (over = {}) => ({ saved: cfgWith('a'), dirty: false, onApplied: vi.fn(), ...over });

describe('Backups', () => {
  it('restore confirm mentions unsaved changes only when dirty', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(Backups, props({ dirty: true }));
    await fireEvent.click(await screen.findByRole('button', { name: /Restore backup/ }));
    expect(confirm.mock.calls[0]![0]).toContain(UNSAVED);
    cleanup();
    render(Backups, props({ dirty: false }));
    await fireEvent.click(await screen.findByRole('button', { name: /Restore backup/ }));
    expect(confirm.mock.calls[1]![0]).not.toContain(UNSAVED);
  });

  it('import confirm mentions unsaved changes when dirty', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(Backups, props({ dirty: true }));
    await pick(file(JSON.stringify(cfgWith('a', 'b'))));
    await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
    expect(confirm.mock.calls[0]![0]).toContain(UNSAVED);
  });

  it('an exported v1 (M1) file is migrated before the diff', async () => {
    render(Backups, props({ saved: cfgWith('a') }));
    await pick(file(JSON.stringify(v1Config([rule('a'), rule('b')]))));
    await screen.findByText(/changes 1 item compared with your current config/);
  });

  it('lists v1 backups with their rule count', async () => {
    send.mockImplementation(async (req: { type: string }) => req.type === 'config.backups' ? { ok: true, data: [{ at: 1000, config: v1Config([rule('x'), rule('y')]) }] } : { ok: true, data: null });
    render(Backups, props());
    await screen.findByText(/2 rules \(v1, upgraded on restore\)/);
  });

  it('import diff is computed against the saved config, not the draft', async () => {
    // Importing [a,b] differs from the saved [a] by 1 rule, whatever the page's unsaved draft holds.
    render(Backups, props({ saved: cfgWith('a'), dirty: true }));
    await pick(file(JSON.stringify(cfgWith('a', 'b'))));
    await screen.findByText(/changes 1 item compared with your current config/);
  });

  it('rejects files over 5 MB before reading them', async () => {
    render(Backups, props());
    const f = file('{}', 5 * 1024 * 1024 + 1);
    const text = vi.spyOn(f, 'text');
    await pick(f);
    await waitFor(() => expect(screen.getByText('File too large (max 5 MB).')).toBeTruthy());
    expect(text).not.toHaveBeenCalled();
  });
});
