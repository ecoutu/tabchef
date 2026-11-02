// "Preview then apply" (M2 T13, R5): the order rule edits use now and the recipe UI (T15) reuses.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defaultConfig } from '../../src/core/config/defaults';
import type { PreviewResult } from '../../src/core/lang/preview';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import { previewThenApply } from '../../src/ui/preview-flow';

const effects: PreviewResult = { moves: [{ tabId: 1, title: 't', to: 'ex' }], closes: [], groupsCreated: ['ex'], unchanged: 0, anchorsOpened: 0, dryRun: false };
const none: PreviewResult = { moves: [], closes: [], groupsCreated: [], unchanged: 3, anchorsOpened: 0, dryRun: false };

beforeEach(() => { send.mockReset(); });

describe('previewThenApply', () => {
  it('sends preview.change, asks, then applies on confirm', async () => {
    send.mockResolvedValue({ ok: true, data: effects });
    const order: string[] = [];
    const confirm = vi.fn(async () => { order.push('confirm'); return true; });
    const apply = vi.fn(async () => { order.push('apply'); return 'done'; });
    expect(await previewThenApply(defaultConfig(), confirm, apply)).toBe('done');
    expect(send).toHaveBeenCalledWith({ type: 'preview.change', config: defaultConfig() });
    expect(confirm).toHaveBeenCalledWith(effects);
    expect(order).toEqual(['confirm', 'apply']);
  });

  it('cancel: nothing is applied', async () => {
    send.mockResolvedValue({ ok: true, data: effects });
    const apply = vi.fn();
    expect(await previewThenApply(defaultConfig(), async () => false, apply)).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });

  it('no effects, only dry-run entries (R52), or a failed preview: applies straight away without asking', async () => {
    const dryOnly: PreviewResult = { ...none, moves: [{ tabId: 1, title: 't', to: 'ex', dryRun: true }], closes: [{ tabId: 2, title: 'c', ruleKey: 'user/c', afterMs: 1, dryRun: true }] };
    for (const r of [{ ok: true, data: none }, { ok: true, data: dryOnly }, { ok: false, error: 'invalid config' }]) {
      send.mockResolvedValue(r);
      const confirm = vi.fn();
      const apply = vi.fn(async () => 1);
      expect(await previewThenApply(defaultConfig(), confirm, apply)).toBe(1);
      expect(confirm).not.toHaveBeenCalled();
    }
  });
});
