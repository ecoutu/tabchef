// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import type { ExplainView } from '../../src/engine/messages';

const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Explain from '../../src/entrypoints/options/Explain.svelte';

const view: ExplainView = {
  tab: { id: 5, title: 'PR #1', url: 'https://github.com/acme/web/pull/1', groupTitle: 'Github Acme' },
  hasPageFacts: false,
  rules: [
    { key: 'user/d', name: 'Trial', actions: ['group'], won: ['group'], lostTo: {}, dryRun: true, matched: true },
    { key: 'user/acme', name: 'Github Acme', actions: ['group'], won: ['group'], lostTo: {}, matched: true },
    { key: 'user/other', name: 'Github Other', actions: ['group'], won: [], lostTo: { group: 'user/acme' }, matched: true },
    { key: 'meet/left', name: 'Left meeting', actions: ['close'], won: [], lostTo: {}, matched: false, paused: 'Paused: needs access to https://meet.google.com/*' },
    { key: 'user/pt', name: 'Page text', actions: ['close'], won: [], lostTo: {}, matched: false, needsPage: true },
  ],
};

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (req: { type: string; tabId?: number }) =>
    (req.type === 'explain.tab' && req.tabId === 5 ? { ok: true, data: view } : { ok: false, error: 'tab not found' }));
});
afterEach(cleanup);

describe('Explain (M2 T14)', () => {
  it('asks for the tab and lists why it is here', async () => {
    render(Explain, { tabId: 5 });
    await screen.findByText('Github Acme', { selector: '.name' });
    expect(send).toHaveBeenCalledWith({ type: 'explain.tab', tabId: 5 });
    expect(screen.getByText(/In group "Github Acme"/)).toBeTruthy();
    const other = screen.getByRole('listitem', { name: 'Github Other' });
    expect(other.textContent).toContain('Lost group to Github Acme');
    expect(screen.getByRole('listitem', { name: 'Github Acme' }).textContent).toContain('Won group');
  });

  it('labels dry-run, paused and needs-page rules', async () => {
    render(Explain, { tabId: 5 });
    const trial = await screen.findByRole('listitem', { name: 'Trial' });
    expect(trial.textContent).toContain('dry run: logged only');
    expect(trial.textContent).toContain('Would win group');
    expect(screen.getByRole('listitem', { name: 'Left meeting' }).textContent).toContain('Paused: needs access to https://meet.google.com/*');
    expect(screen.getByRole('listitem', { name: 'Page text' }).textContent).toContain('needs page facts');
  });

  it('shows the error for an unknown tab', async () => {
    render(Explain, { tabId: 9 });
    expect((await screen.findByRole('alert')).textContent).toContain('tab not found');
  });
});
