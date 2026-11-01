// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));

import Duplicates from '../../src/entrypoints/popup/tabs/Duplicates.svelte';

const tab = (id: number, over = {}) => ({ id, windowId: 1, index: id, url: 'https://x.test/a', title: 'Page A', pinned: false,
  groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...over });
const data = (over = {}) => ({
  sets: [{ key: 'k1', tabs: [tab(1), tab(2), tab(3)], closable: 2 }],
  pending: [], ...over,
});

beforeEach(() => { send.mockReset(); });
afterEach(cleanup);

describe('Duplicates', () => {
  it('renders open N× and close N-1, and closeExtras fires with the key', async () => {
    send.mockResolvedValue({ ok: true, data: 2 });
    const onChange = vi.fn();
    render(Duplicates, { data: data(), onChange });
    expect(screen.getByText('open 3×')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /close 2/ }));
    expect(send).toHaveBeenCalledWith({ type: 'dupes.closeExtras', key: 'k1' });
    expect(onChange).toHaveBeenCalled();
  });

  it('shows closable count, and no button at 0', () => {
    render(Duplicates, { data: data({ sets: [{ key: 'a', tabs: [tab(1), tab(2, { pinned: true })], closable: 0 }] }), onChange: vi.fn() });
    expect(screen.queryByRole('button', { name: /^close \d/ })).toBeNull();
  });

  it('clicking the title focuses the oldest tab', async () => {
    send.mockResolvedValue({ ok: true, data: null });
    render(Duplicates, { data: data(), onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Page A' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.focus', tabId: 1 });
  });

  it('close all duplicates sends dupes.closeAll', async () => {
    send.mockResolvedValue({ ok: true, data: 2 });
    render(Duplicates, { data: data(), onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Close all duplicates' }));
    expect(send).toHaveBeenCalledWith({ type: 'dupes.closeAll' });
  });

  it('pending asks render with Switch / Keep both and resolve', async () => {
    send.mockResolvedValue({ ok: true, data: null });
    render(Duplicates, { data: data({ pending: [{ newTabId: 9, existingTabId: 1, key: 'k1', at: 0 }] }), onChange: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(send).toHaveBeenCalledWith({ type: 'dupes.resolve', newTabId: 9, existingTabId: 1, choice: 'switch' });
    await fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));
    expect(send).toHaveBeenLastCalledWith({ type: 'dupes.resolve', newTabId: 9, existingTabId: 1, choice: 'keep' });
  });

  it('shows an inline error on {ok:false} and does not throw', async () => {
    send.mockResolvedValue({ ok: false, error: 'boom' });
    const onChange = vi.fn();
    render(Duplicates, { data: data(), onChange });
    await fireEvent.click(screen.getByRole('button', { name: /close 2/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });

  it('uses a placeholder, not an img, when there is no favicon; img when present', () => {
    const { container } = render(Duplicates, { data: data({ sets: [{ key: 'k', tabs: [tab(1, { favIconUrl: 'https://x.test/f.ico' }), tab(2)], closable: 1 }] }), onChange: vi.fn() });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://x.test/f.ico');
    cleanup();
    const r = render(Duplicates, { data: data(), onChange: vi.fn() });
    expect(r.container.querySelector('img')).toBeNull();
    expect(r.container.querySelector('.fav-ph')).not.toBeNull();
  });
  it('has no per-set Lock button (it would lock the kept tab); extras get Lock toggles in an expandable list (CR#4)', async () => {
    render(Duplicates, { data: data(), onChange: vi.fn() });
    expect(screen.queryByRole('button', { name: /^(Lock|Unlock)\b/ })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show 3 tabs' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('button', { name: /^Lock copy/ }).map((b) => b.getAttribute('aria-label')))
      .toEqual(['Lock copy 2: Page A', 'Lock copy 3: Page A']);
  });

  it('locking an extra reduces "close N" by one; Unlock sends tab.unlock (CR#4)', async () => {
    let locked: number[] = [];
    const view = () => data({ locked: [...locked], sets: [{ key: 'k1', tabs: [tab(1), tab(2), tab(3)], closable: 2 - locked.length }] });
    send.mockImplementation((r: { type: string; tabId: number }) => {
      if (r.type === 'tab.lock') locked.push(r.tabId);
      if (r.type === 'tab.unlock') locked = locked.filter((x) => x !== r.tabId);
      return Promise.resolve({ ok: true, data: null });
    });
    // eslint-disable-next-line prefer-const
    let rerender: (p: { data: ReturnType<typeof data> }) => Promise<void>;
    const onChange = () => { void rerender({ data: view() }); };
    ({ rerender } = render(Duplicates, { data: view(), onChange }));
    expect(screen.getByRole('button', { name: 'close 2' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Show 3 tabs' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Lock copy 2: Page A' }));
    expect(send).toHaveBeenCalledWith({ type: 'tab.lock', tabId: 2 });
    expect(await screen.findByRole('button', { name: 'close 1' })).toBeTruthy();
    const unlock = screen.getByRole('button', { name: 'Unlock copy 2: Page A' });
    expect(unlock.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(unlock);
    expect(send).toHaveBeenLastCalledWith({ type: 'tab.unlock', tabId: 2 });
    expect(await screen.findByRole('button', { name: 'close 2' })).toBeTruthy();
  });
});
