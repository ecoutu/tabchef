// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));

import ListView from '../../src/entrypoints/popup/tabs/ListView.svelte';
import type { ViewRow, ViewSummary } from '../../src/engine/views';

const finished: ViewSummary = { id: 'finished', tab: 'Finished', kind: 'list', actions: ['focus', 'close', 'keep'], count: 1 };
const row = (tabId: number, o: Partial<ViewRow> = {}): ViewRow => ({
  tabId, windowId: 1, title: `Tab ${tabId}`, url: `http://localhost:3000/cb${tabId}`, pinned: false, ...o,
});
const sug = (tabId: number) => row(tabId, { suggested: true, reason: 'Close OAuth callback tabs', ruleKey: 'finished/oauth-callback' });

beforeEach(() => { send.mockReset(); send.mockResolvedValue({ ok: true, data: null }); });
afterEach(cleanup);

describe('ListView (M2 T17)', () => {
  it('rows: title focuses, Close and Keep act on the suggestion, then refresh', async () => {
    const onChange = vi.fn();
    render(ListView, { view: finished, rows: [sug(3)], onChange });
    expect(screen.getByText('Close OAuth callback tabs')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Tab 3' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.focus', tabId: 3 });
    await fireEvent.click(screen.getByRole('button', { name: 'Keep Tab 3' }));
    expect(send).toHaveBeenCalledWith({ type: 'view.keep', viewId: 'finished', tabId: 3 });
    await fireEvent.click(screen.getByRole('button', { name: 'Close Tab 3' }));
    expect(send).toHaveBeenCalledWith({ type: 'view.close', viewId: 'finished', tabId: 3 });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('only the declared actions are offered; Keep only on suggestions', () => {
    render(ListView, { view: { ...finished, actions: ['focus'] }, rows: [sug(3)], onChange: vi.fn() });
    expect(screen.queryByRole('button', { name: /^Close/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Keep/ })).toBeNull();
    cleanup();
    render(ListView, { view: finished, rows: [row(4)], onChange: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Keep Tab 4' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Tab 4' })).toBeTruthy();
  });

  it('close-all closes every row', async () => {
    render(ListView, { view: { ...finished, actions: ['close-all'] }, rows: [row(1), row(2)], onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Close all' }));
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: 'view.close', viewId: 'finished', tabId: 1 }, { type: 'view.close', viewId: 'finished', tabId: 2 },
    ]);
  });

  it('groups rows under their groupBy value', () => {
    render(ListView, { view: finished, rows: [row(1, { group: 'api' }), row(2, { group: 'api' }), row(3, { group: 'web' })], onChange: vi.fn() });
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['api', 'web']);
  });

  it('paused / notice reason and the empty state; errors are inline', async () => {
    render(ListView, { view: { ...finished, count: 0, paused: 'Paused: needs access to meet.google.com' }, rows: [], onChange: vi.fn() });
    expect(screen.getByText('Paused: needs access to meet.google.com')).toBeTruthy();
    expect(screen.getByText('Nothing here.')).toBeTruthy();
    cleanup();
    send.mockResolvedValue({ ok: false, error: 'tab is locked' });
    render(ListView, { view: finished, rows: [row(4)], onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Close Tab 4' }));
    expect((await screen.findByRole('alert')).textContent).toContain('tab is locked');
  });
});
