// @vitest-environment jsdom
// #40 (subset, M4 T9): History names project closes in plain words, not the raw reason / action codes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import type { WhyEntry } from '../../src/core/safety/why-log';
import type { RecentlyClosedItem } from '../../src/core/safety/recently-closed';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import History from '../../src/entrypoints/options/History.svelte';
import { actionLabel, reasonLabel } from '../../src/ui/history-labels';

const why: WhyEntry[] = [{ tabId: 4, action: 'project-leave', detail: 'Removed from ABC-1 manually', at: 1000 }];
const recent: RecentlyClosedItem[] = [{ id: 'rc1', url: 'https://a.example/', title: 'A', windowId: 1, reason: 'project-closed', at: 1000 }];

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    if (req.type === 'why.all') return { ok: true, data: why };
    if (req.type === 'recent.list') return { ok: true, data: recent };
    return { ok: true, data: null };
  });
});
afterEach(() => { cleanup(); });

describe('history labels (#40)', () => {
  it('maps the two project codes to plain words and leaves the rest as they are', () => {
    expect(reasonLabel('project-closed')).toBe('closed with its project');
    expect(actionLabel('project-leave')).toBe('removed from its project');
    expect(reasonLabel('rule')).toBe('rule');
    expect(actionLabel('grouped')).toBe('grouped');
  });

  it('Recently closed and the Why log show them, never the raw codes', async () => {
    render(History);
    expect((await screen.findByText(/closed with its project/)).textContent).not.toContain('project-closed');
    expect(screen.getByText(/removed from its project/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/project-closed|project-leave/);
  });
});
