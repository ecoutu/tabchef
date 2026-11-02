// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import type { WhyEntry } from '../../src/core/safety/why-log';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import History from '../../src/entrypoints/options/History.svelte';

const why: WhyEntry[] = [
  { tabId: 1, ruleId: 'user/b', action: 'grouped', detail: 'Moved to B by rule B', at: 1000 },
  { tabId: 1, ruleId: 'user/a', action: 'would-group', detail: 'Would move to A by rule A (dry run)', at: 2000, dryRun: true },
];

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (req: { type: string }) => {
    if (req.type === 'why.all') return { ok: true, data: why };
    if (req.type === 'recent.list') return { ok: true, data: [] };
    return { ok: true, data: null };
  });
});
afterEach(() => { cleanup(); });

describe('History (dry run, M2 T12)', () => {
  it('marks dry-run entries with a chip and filters to them', async () => {
    render(History);
    await screen.findByText(/Moved to B/);
    expect(screen.getAllByText('dry run')).toHaveLength(1);
    await fireEvent.click(screen.getByLabelText('Dry run only'));
    expect(screen.queryByText(/Moved to B/)).toBeNull();
    expect(screen.getByText(/Would move to A/)).toBeTruthy();
  });
});

describe('History → conflict view (M2 T14)', () => {
  it('links each tab row to #/explain/<tabId>', async () => {
    render(History);
    await screen.findByText(/Moved to B/);
    const links = screen.getAllByRole('link', { name: 'Why is this tab here? (tab 1)' }) as HTMLAnchorElement[];
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute('href')).toBe('#/explain/1');
  });
});
