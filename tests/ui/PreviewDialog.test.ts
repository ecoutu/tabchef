// @vitest-environment jsdom
// Preview before apply (M2 T13): the dialog. It only reports and calls back; App / the recipe UI send the change.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import type { PreviewResult } from '../../src/core/lang/preview';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import PreviewDialog from '../../src/entrypoints/options/PreviewDialog.svelte';

afterEach(() => { cleanup(); send.mockReset(); });

const result = (o: Partial<PreviewResult> = {}): PreviewResult => ({
  moves: [{ tabId: 1, title: 'Example A', to: 'ex', ruleKey: 'user/ex' }, { tabId: 2, title: 'Example B', from: 'old', to: 'ex' }],
  closes: [{ tabId: 3, title: 'Callback', ruleKey: 'finished/oauth-callback', afterMs: 3000 }],
  groupsCreated: ['ex'], unchanged: 4, anchorsOpened: 0, dryRun: false, ...o,
});
const props = (r: PreviewResult) => ({ result: r, onApply: vi.fn(), onCancel: vi.fn() });

describe('PreviewDialog', () => {
  it('shows the exact copy, the moves and the closes', () => {
    render(PreviewDialog, props(result()));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('2 tabs would move, 1 would close.')).toBeTruthy();
    expect(screen.getByText(/Example A/).textContent).toMatch(/no group → ex/);
    expect(screen.getByText(/Example B/).textContent).toMatch(/old → ex/);
    expect(screen.getByText(/Callback/).textContent).toMatch(/closes after 3 s/);
  });

  it('Apply calls onApply; Cancel calls onCancel and sends nothing', async () => {
    const p = props(result());
    render(PreviewDialog, p);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.onCancel).toHaveBeenCalledOnce();
    expect(p.onApply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(p.onApply).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('Escape cancels', async () => {
    const p = props(result());
    render(PreviewDialog, p);
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(p.onCancel).toHaveBeenCalledOnce();
  });

  it('labels dry-run entries "(dry run: logged only)" and leaves them out of the count (R30)', () => {
    render(PreviewDialog, props(result({
      moves: [{ tabId: 1, title: 'Trial', to: 'ex', dryRun: true }],
      closes: [{ tabId: 3, title: 'Cb', ruleKey: 'user/cb', afterMs: 500, dryRun: true }],
    })));
    expect(screen.getByText('0 tabs would move, 0 would close.')).toBeTruthy();
    expect(screen.getByText(/Trial/).textContent).toMatch(/\(dry run: logged only\)/);
    expect(screen.getByText(/Cb/).textContent).toMatch(/\(dry run: logged only\)/);
  });

  it('says so when global dry run is on, and counts anchor tabs that would open', () => {
    render(PreviewDialog, props(result({ dryRun: true, moves: [], closes: [], anchorsOpened: 2 })));
    expect(screen.getByText('Dry run is on: nothing would really move or close.')).toBeTruthy();
    expect(screen.getByText('2 anchor tabs would open.')).toBeTruthy();
  });
});
