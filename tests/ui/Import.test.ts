// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/svelte';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Import from '../../src/entrypoints/options/Import.svelte';

const UNSAVED = 'You have unsaved changes on this page; they will be discarded.';
const PREVIEW = { rules: [{ id: 'a', name: 'Acme', enabled: true, match: { url: ['https://acme.example/*'] }, group: { title: 'Acme', color: 'blue' }, strict: true, merge: false }],
  dedupe: {}, warnings: ['Heads up'], changes: ['scope: all-windows \u2192 same-window'], config: { version: 2, rules: [] } };

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
    expect(screen.getByText(/Tab Deduper never closed tabs automatically; Tabchef defaults to switching to the existing tab \(always-switch\)\. You can choose ask or off on the Duplicates page\./)).toBeTruthy();
    await paste('nope');
    expect((await screen.findByRole('alert')).textContent).toBe('Not valid JSON.');
    const big = new File(['{}'], 'd.json');
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    await fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [big] } });
    expect((await screen.findByRole('alert')).textContent).toBe('File too large (max 5 MB).');
  });

  describe('collapse suggestions (M2 T19)', () => {
    const SUGGESTION = {
      replaces: ['r1', 'r2', 'r3'], notes: ['repo-10 tabs currently go to repo-1'],
      rule: { id: 'collapsed-repo', name: 'github.com/acme/:repo*', enabled: true, match: { url: ['/^https:\\/\\/github\\.com\\/acme\\/(?<repo>repo-1|repo-2|repo-10).*$/i'] },
        actions: [{ group: { title: '{repo|lower}', color: '{repo|lower|map:repoColors|default:cyan}' } }] },
      table: { name: 'repoColors', entries: { 'repo-1': 'green', 'repo-2': 'cyan', 'repo-10': 'cyan' } },
    };
    beforeEach(() => {
      send.mockImplementation(async (req: { type: string }) => {
        if (req.type === 'import.preview') return { ok: true, data: { ...PREVIEW, collapse: [SUGGESTION] } };
        if (req.type === 'config.get') return { ok: true, data: { config: {}, rev: 'r1' } };
        return { ok: true, data: { rules: 1 } };
      });
    });

    it('shows the card with the shadow note; never applied unless chosen', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(Import, props());
      await paste('{}');
      expect(await screen.findByText('Replace 3 similar rules with 1 templated rule?')).toBeTruthy();
      expect(screen.getByText('repo-10 tabs currently go to repo-1')).toBeTruthy();
      expect(screen.getByText('Table repoColors')).toBeTruthy();
      expect(screen.getByText('repo-1: green, repo-2: cyan, repo-10: cyan')).toBeTruthy();
      await fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
      await waitFor(() => expect(send.mock.calls.some((c) => c[0].type === 'import.apply')).toBe(true));
      expect(send.mock.calls.find((c) => c[0].type === 'import.apply')![0]).not.toHaveProperty('collapse');
    });

    it('[Use templated rule] sends the chosen index; [Keep as is] drops the card', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(Import, props());
      await paste('{}');
      await fireEvent.click(await screen.findByRole('button', { name: 'Use templated rule' }));
      expect(screen.getByText(/Will replace 3 rules with 1 templated rule/)).toBeTruthy();
      await fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
      expect(confirm.mock.calls[0]![0]).toContain('1 templated rule replaces 3 similar rules');
      await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'import.apply', source: 'auto-group-tabs', data: {}, baseRev: 'r1', collapse: [0] }));
      expect(send).toHaveBeenCalledWith({ type: 'import.preview', source: 'auto-group-tabs', data: {}, collapse: [0] }); // M1: previewed with it
      cleanup();
      send.mockClear();
      render(Import, props());
      await paste('{}');
      await fireEvent.click(await screen.findByRole('button', { name: 'Use templated rule' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Keep as is' }));
      expect(screen.queryByText('Replace 3 similar rules with 1 templated rule?')).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
      await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'import.apply', source: 'auto-group-tabs', data: {}, baseRev: 'r1' }));
    });
  });

  describe('M1/R68: import.apply goes through the preview', () => {
    const effects = { moves: [], closes: [{ tabId: 3, title: 'Callback', ruleKey: 'user/a', afterMs: 3000 }], groupsCreated: [], unchanged: 0, anchorsOpened: 0, dryRun: false };
    let previewReply: unknown;
    beforeEach(() => {
      previewReply = { ok: true, data: effects };
      send.mockImplementation(async (req: { type: string }) => {
        if (req.type === 'import.preview') return { ok: true, data: PREVIEW };
        if (req.type === 'config.get') return { ok: true, data: { config: {}, rev: 'r1' } };
        if (req.type === 'preview.change') return previewReply;
        return { ok: true, data: { rules: 1 } };
      });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
    });
    const applied = () => send.mock.calls.filter((c) => c[0].type === 'import.apply');

    it('previews the config import.apply would store; with effects, Cancel sends nothing and Apply imports', async () => {
      const p = props();
      render(Import, p);
      await paste('{}');
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
      await fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(applied()).toHaveLength(0);
      expect(send).toHaveBeenCalledWith({ type: 'preview.change', config: PREVIEW.config });
      await fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(applied()).toHaveLength(1));
      await waitFor(() => expect(p.onApplied).toHaveBeenCalled());
    });

    it('asks import.preview for the chosen collapse before previewing', async () => {
      render(Import, props());
      await paste('{}');
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
      await screen.findByRole('dialog');
      expect(send.mock.calls.filter((c) => c[0].type === 'import.preview').at(-1)![0]).toEqual({ type: 'import.preview', source: 'auto-group-tabs', data: {} });
    });

    it('no effects: imports straight through (R52)', async () => {
      previewReply = { ok: true, data: { ...effects, closes: [] } };
      render(Import, props());
      await paste('{}');
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
      await waitFor(() => expect(applied()).toHaveLength(1));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a failed preview shows the error and imports nothing', async () => {
      previewReply = { ok: false, error: 'boom' };
      render(Import, props());
      await paste('{}');
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
      expect(await screen.findByText('Could not preview: boom')).toBeTruthy();
      expect(applied()).toHaveLength(0);
    });
  });
});
