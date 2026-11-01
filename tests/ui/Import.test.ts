// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Import from '../../src/entrypoints/options/Import.svelte';

const UNSAVED = 'You have unsaved changes on this page; they will be discarded.';
const PREVIEW = { rules: [{ id: 'a', name: 'Acme', enabled: true, match: { url: ['https://acme.example/*'] }, group: { title: 'Acme', color: 'blue' }, strict: true, merge: false }],
  dedupe: {}, warnings: ['Heads up'], changes: ['scope: all-windows \u2192 same-window'] };

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    if (req.type === 'import.preview') return { ok: true, data: PREVIEW };
    if (req.type === 'config.get') return { ok: true, data: { config: {}, rev: 'r1' } };
    return { ok: true, data: { rules: 1 } };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const props = (over = {}) => ({ dirty: false, onApplied: vi.fn(), ...over });
const paste = async (text: string) => {
  await fireEvent.input(screen.getByLabelText('Or paste JSON'), { target: { value: text } });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
};

describe('Import page', () => {
  it('previews pasted JSON with table and warnings, then applies after confirm with baseRev', async () => {
    const p = props();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(Import, p);
    await paste('{"sync":{}}');
    expect(await screen.findByText('Heads up')).toBeTruthy();
    expect(screen.getByText('https://acme.example/*')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
    expect(confirm.mock.calls[0]![0]).not.toContain(UNSAVED);
    expect(confirm.mock.calls[0]![0]).toContain('scope: all-windows \u2192 same-window');
    expect(confirm.mock.calls[0]![0]).not.toContain('nothing is overwritten');
    await waitFor(() => expect(p.onApplied).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith({ type: 'import.apply', source: 'auto-group-tabs', data: { sync: {} }, baseRev: 'r1' });
  });

  it('adds the unsaved line when dirty and does nothing if the confirm is declined', async () => {
    const p = props({ dirty: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(Import, p);
    await paste('{}');
    await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
    expect(confirm.mock.calls[0]![0]).toContain(UNSAVED);
    expect(send.mock.calls.some((c) => c[0].type === 'import.apply')).toBe(false);
  });

  it('shows the Tab Deduper explanation only for that source; rejects invalid JSON and oversize files', async () => {
    render(Import, props());
    expect(screen.queryByText(/never closed tabs automatically/)).toBeNull();
    await fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'tab-deduper' } });
    expect(screen.getByText(/Tab Deduper never closed tabs automatically; Tabchef defaults to switching to the existing tab \(always-switch\)\. You can choose ask or off under Dedupe\./)).toBeTruthy();
    await paste('nope');
    expect((await screen.findByRole('alert')).textContent).toBe('Not valid JSON.');
    const big = new File(['{}'], 'd.json');
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    await fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [big] } });
    expect((await screen.findByRole('alert')).textContent).toBe('File too large (max 5 MB).');
  });
});
