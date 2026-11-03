// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/svelte';
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

  it('an imported file that only needs load-path repairs (over-long urlTransform) previews, shows the removal and applies repaired', async () => {
    const saved = cfgWith('a');
    const old = { ...saved, dedupe: { ...saved.dedupe, urlTransforms: [{ pattern: 'a'.repeat(600), replacement: '' }] } };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(Backups, props({ saved }));
    await pick(file(JSON.stringify(old)));
    await screen.findByText(/1 Duplicates setting\(s\) removed: urlTransforms\/0/);
    await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
    const set = send.mock.calls.map((c) => c[0] as { type: string; config?: Config }).find((r) => r.type === 'config.set');
    expect(set?.config?.dedupe.urlTransforms).toEqual([]);
  });

  it('a restore that needed repairs shows the repair warning', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'config.backups') return { ok: true, data: [{ at: 1000, config: cfgWith('x') }] };
      if (req.type === 'config.status') return { ok: true, data: { syncing: false, warning: '1 Duplicates setting(s) removed: urlTransforms/0 (regex too long (max 500 characters))' } };
      return { ok: true, data: null };
    });
    render(Backups, props());
    await fireEvent.click(await screen.findByRole('button', { name: /Restore backup/ }));
    await screen.findByText(/Restored .*1 Duplicates setting\(s\) removed/);
  });

  it('rejects files over 5 MB before reading them', async () => {
    render(Backups, props());
    const f = file('{}', 5 * 1024 * 1024 + 1);
    const text = vi.spyOn(f, 'text');
    await pick(f);
    await waitFor(() => expect(screen.getByText('File too large (max 5 MB).')).toBeTruthy());
    expect(text).not.toHaveBeenCalled();
  });

  describe('M1/R68: restore and file import go through the preview', () => {
    const effects = { moves: [], closes: [{ tabId: 3, title: 'Callback', ruleKey: 'user/x', afterMs: 3000 }], groupsCreated: [], unchanged: 0, anchorsOpened: 0, dryRun: false };
    let previewReply: unknown;
    beforeEach(() => {
      previewReply = { ok: true, data: effects };
      send.mockImplementation(async (req: { type: string }) => {
        if (req.type === 'config.backups') return { ok: true, data: [{ at: 1000, config: cfgWith('x') }] };
        if (req.type === 'preview.change') return previewReply;
        return { ok: true, data: null };
      });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
    });
    const sent = (type: string) => send.mock.calls.map((c) => c[0] as { type: string; config?: Config }).filter((r) => r.type === type);

    it('restore previews the backup as it would load; with effects, Cancel sends nothing and Apply restores', async () => {
      const p = props();
      render(Backups, p);
      await fireEvent.click(await screen.findByRole('button', { name: /Restore backup/ }));
      await fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(sent('config.restore')).toHaveLength(0);
      expect(sent('preview.change')[0]!.config).toEqual(cfgWith('x'));
      await fireEvent.click(screen.getByRole('button', { name: /Restore backup/ }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(sent('config.restore')).toEqual([{ type: 'config.restore', at: 1000 }]));
      await waitFor(() => expect(p.onApplied).toHaveBeenCalled());
    });

    it('restore with no effects goes straight through (R52)', async () => {
      previewReply = { ok: true, data: { ...effects, closes: [] } };
      render(Backups, props());
      await fireEvent.click(await screen.findByRole('button', { name: /Restore backup/ }));
      await waitFor(() => expect(sent('config.restore')).toHaveLength(1));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a failed restore preview shows the error and restores nothing', async () => {
      previewReply = { ok: false, error: 'boom' };
      render(Backups, props());
      await fireEvent.click(await screen.findByRole('button', { name: /Restore backup/ }));
      expect(await screen.findByText('Could not preview: boom')).toBeTruthy();
      expect(sent('config.restore')).toHaveLength(0);
    });

    it('file import previews the repaired config; Cancel sends nothing, Apply stores it, a failure stores nothing', async () => {
      const p = props();
      render(Backups, p);
      await pick(file(JSON.stringify(cfgWith('a', 'b'))));
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
      await fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(sent('config.set')).toHaveLength(0);
      expect(sent('preview.change')[0]!.config).toEqual(cfgWith('a', 'b'));
      await fireEvent.click(screen.getByRole('button', { name: 'Apply import' }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(sent('config.set')).toHaveLength(1));
      await waitFor(() => expect(p.onApplied).toHaveBeenCalled());
      cleanup();
      send.mockClear();
      previewReply = { ok: false, error: 'boom' };
      render(Backups, props());
      await pick(file(JSON.stringify(cfgWith('a', 'b'))));
      await fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
      expect(await screen.findByText('Could not preview: boom')).toBeTruthy();
      expect(sent('config.set')).toHaveLength(0);
    });
  });
});

