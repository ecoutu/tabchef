// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import Rules from '../../src/entrypoints/options/Rules.svelte';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config, GroupRule, TabSnap } from '../../src/core/types';
import { withGroupRules } from '../helpers/config';

afterEach(cleanup);

const rule = (id: string, url: string | string[]): GroupRule => ({ id, name: `Rule ${id}`, enabled: true, match: { url }, group: { title: id, color: 'blue' } });
const cfg = (...rules: GroupRule[]): Config => withGroupRules(rules);
const tab = (id: number, url: string): TabSnap => ({ id, windowId: 1, index: id, url, title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false });
const props = (config: Config, over = {}) => ({ config, tabs: [] as TabSnap[], dirty: true, saving: false, serverErrors: [] as string[], onChange: vi.fn(), onSave: vi.fn(), ...over });

describe('Rules', () => {
  it('shows "invalid regex" for /(/ and disables Save', () => {
    render(Rules, props(cfg(rule('a', '/(/'))));
    expect(screen.getByText(/invalid regex/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Save when valid and dirty, and calls onSave', async () => {
    const p = props(cfg(rule('a', 'a.com/*')));
    render(Rules, p);
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    expect(p.onSave).toHaveBeenCalled();
  });

  it('Save is disabled when nothing changed', () => {
    render(Rules, props(cfg(rule('a', 'a.com/*')), { dirty: false }));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the live match count', () => {
    render(Rules, props(cfg(rule('a', 'github.com/acme/*')), { tabs: [tab(1, 'https://github.com/acme/x'), tab(2, 'https://other.com/')] }));
    expect(screen.getByText('Matches 1 open tab')).toBeTruthy();
  });

  it('Move down reorders via onChange; first Move up and last Move down are disabled', async () => {
    const p = props(cfg(rule('a', 'a.com/*'), rule('b', 'b.com/*')));
    render(Rules, p);
    const ups = screen.getAllByRole('button', { name: 'Move up' }) as HTMLButtonElement[];
    const downs = screen.getAllByRole('button', { name: 'Move down' }) as HTMLButtonElement[];
    expect(ups[0]!.disabled).toBe(true);
    expect(downs.at(-1)!.disabled).toBe(true); // the last row is a recipe rule (github-prs) since T15
    await fireEvent.click(downs[0]!);
    expect(p.onChange.mock.calls[0]![0].order).toEqual(['user/b', 'user/a']);
  });

  it('Add rule appends a rule', async () => {
    const p = props(cfg());
    render(Rules, p);
    await fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(p.onChange.mock.calls[0]![0].rules).toHaveLength(1);
  });

  it('shows server errors inline next to the matching field', () => {
    render(Rules, props(cfg(rule('a', 'a.com/*')), { serverErrors: ['/rules/0/actions/0/group/color must be equal to one of the allowed values'] }));
    expect(screen.getByText(/must be equal to one of the allowed values/)).toBeTruthy();
  });

  it('lists rules in order (priority), not array order', () => {
    render(Rules, props({ ...cfg(rule('a', 'a.com/*'), rule('b', 'b.com/*')), order: ['user/b', 'user/a'] }));
    const names = (screen.getAllByRole('textbox', { name: 'Rule name' }) as HTMLInputElement[]).map((x) => x.value);
    expect(names).toEqual(['Rule b', 'Rule a']);
  });

  it('shows a rule the form cannot express as a read-only summary with "Edit in YAML", still deletable (T1 minor)', async () => {
    const odd = { id: 'odd', name: 'Odd rule', enabled: true, match: { title: '*x*' }, actions: [{ showInView: { view: 'v' } }] };
    const p = props({ ...defaultConfig(), rules: [odd], order: ['user/odd'] } as Config);
    render(Rules, p);
    expect(screen.getByText('Odd rule')).toBeTruthy();
    expect(screen.getByText('Match: title *x*')).toBeTruthy();
    expect(screen.getByText('Show in view v')).toBeTruthy();
    expect(document.body.textContent).not.toContain('"showInView"'); // no raw JSON
    expect(screen.queryByRole('textbox', { name: 'Rule name' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(p.onChange.mock.calls[0]![0].rules).toEqual([]);
  });

  it('"Edit in YAML" opens the YAML view; a valid edit changes the rule', async () => {
    const odd = { id: 'odd', name: 'Odd rule', enabled: true, match: { title: '*x*' }, actions: [{ showInView: { view: 'v' } }] };
    const p = props({ ...defaultConfig(), rules: [odd], order: ['user/odd'] } as Config);
    render(Rules, p);
    await fireEvent.click(screen.getByRole('button', { name: 'Edit in YAML' }));
    const area = screen.getByRole('textbox', { name: 'Rule YAML' }) as HTMLTextAreaElement;
    await fireEvent.input(area, { target: { value: area.value.replace('name: Odd rule', 'name: Renamed') } });
    expect(p.onChange.mock.calls.at(-1)![0].rules[0].name).toBe('Renamed');
  });

  it('toggles a form rule to YAML and back; invalid YAML blocks Save', async () => {
    render(Rules, props(cfg(rule('a', 'a.com/*'))));
    await fireEvent.click(screen.getByRole('button', { name: 'YAML' }));
    const area = screen.getByRole('textbox', { name: 'Rule YAML' }) as HTMLTextAreaElement;
    await fireEvent.input(area, { target: { value: 'id: [' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Fix YAML errors to save.')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Form' }));
    expect(screen.getByRole('textbox', { name: 'Rule name' })).toBeTruthy();
  });

  it('the form edits title match, close, dry run (M2 T15 form fields)', async () => {
    const p = props(cfg(rule('a', 'a.com/*')));
    render(Rules, p);
    await fireEvent.input(screen.getByLabelText('Title pattern (optional)'), { target: { value: '*Inbox*' } });
    expect(p.onChange.mock.calls.at(-1)![0].rules[0].match).toEqual({ all: [{ url: 'a.com/*' }, { title: '*Inbox*' }] });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Close tabs' }));
    expect(p.onChange.mock.calls.at(-1)![0].rules[0].actions).toEqual([{ group: { title: 'a', color: 'blue' } }, { close: { after: '3s', mode: 'suggest' } }]);
    await fireEvent.click(screen.getByRole('checkbox', { name: /Dry run/ }));
    expect(p.onChange.mock.calls.at(-1)![0].rules[0].dryRun).toBe(true);
  });

  it('hints under URL patterns: exact path and open-ended host', () => {
    render(Rules, props(cfg(rule('a', ['https://github.com/:repo', 'https://github.com*']))));
    expect(screen.getByText('https://github.com/:repo: matches only exactly this path; add * to include deeper pages')).toBeTruthy();
    expect(screen.getByText(/look-alike hosts such as github\.com\.evil\.com/)).toBeTruthy();
  });

  it('help text states order is priority', () => {
    render(Rules, props(cfg()));
    expect(screen.getByText(/Order is priority and tab-bar order/)).toBeTruthy();
  });
});

describe('Rules: test against my open tabs (M2 T13)', () => {
  it('sends preview.change for that rule alone and shows "N tabs would move · M would close" inline', async () => {
    send.mockReset();
    send.mockResolvedValue({ ok: true, data: {
      moves: [{ tabId: 1, title: 'x', to: 'a' }, { tabId: 2, title: 'y', to: 'a' }], closes: [], groupsCreated: ['a'], unchanged: 0, anchorsOpened: 0, dryRun: false,
    } });
    const config = cfg(rule('a', 'a.com/*'), rule('b', 'b.com/*'));
    render(Rules, props(config));
    await fireEvent.click(screen.getAllByRole('button', { name: 'Test against my open tabs' })[0]!);
    expect(await screen.findByText('2 tabs would move · 0 would close')).toBeTruthy();
    expect(send).toHaveBeenCalledWith({ type: 'preview.change', config, only: 'user/a' });
  });

  it('shows the error when the preview fails', async () => {
    send.mockReset();
    send.mockResolvedValue({ ok: false, error: 'unknown rule' });
    render(Rules, props(cfg(rule('a', 'a.com/*'))));
    await fireEvent.click(screen.getAllByRole('button', { name: 'Test against my open tabs' })[0]!);
    expect(await screen.findByText('Could not test: unknown rule')).toBeTruthy();
  });
});

describe('Rules: shadowed-rule warnings (M2 T14)', () => {
  it('asks rules.shadowed for the draft and shows "Likely" inline under the shadowed rule', async () => {
    const config = cfg(rule('a', 'x.com/*'), rule('b', 'x.com/b/*'));
    send.mockReset();
    send.mockImplementation(async (req: { type: string }) =>
      (req.type === 'rules.shadowed' ? { ok: true, data: [{ key: 'user/b', shadowedBy: 'user/a', name: 'Rule a' }] } : { ok: false, error: 'x' }));
    render(Rules, props(config));
    const note = await screen.findByText('Likely never matches: rule "Rule a" above catches these first.');
    expect(send).toHaveBeenCalledWith({ type: 'rules.shadowed', config });
    expect(note.closest('[role="group"]')!.getAttribute('aria-label')).toBe('Rule 2: Rule b');
  });

  it('shows nothing when the request fails', async () => {
    send.mockReset();
    send.mockResolvedValue({ ok: false, error: 'invalid config' });
    render(Rules, props(cfg(rule('a', 'x.com/*'))));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Likely never matches/)).toBeNull();
  });
});

describe('Rules: recipe rules as locked rows (M2 T15)', () => {
  const withFinished = (c: Config): Config => ({ ...c, recipes: c.recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true } : r)) });

  it('lists recipe rules after user rules, locked: summary, no editor, no Delete', () => {
    render(Rules, props(withFinished(cfg(rule('a', 'a.com/*')))));
    const rows = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(rows).toEqual(['Rule 1: Rule a', 'Rule 2: Group GitHub tabs by repository', 'Rule 3: Close OAuth callback tabs', 'Rule 4: Close Meet tabs after the call ends', 'Rule 5: Close redirect landing tabs']);
    const oauth = screen.getByRole('group', { name: 'Rule 3: Close OAuth callback tabs' });
    expect(oauth.textContent).toContain('Finished');
    expect(oauth.textContent).toContain('Locked');
    expect(oauth.textContent).toContain('Close after 3s (auto)');
    expect(oauth.querySelector('textarea, input[aria-label="Rule name"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('a recipe row can be moved above a user rule (order)', async () => {
    const p = props(withFinished(cfg(rule('a', 'a.com/*'))));
    render(Rules, p);
    const row = screen.getByRole('group', { name: 'Rule 2: Group GitHub tabs by repository' });
    await fireEvent.click(row.querySelector('button[aria-label="Move up"]')!);
    const order = p.onChange.mock.calls.at(-1)![0].order as string[];
    expect(order.indexOf('github-prs/group-by-repo')).toBeLessThan(order.indexOf('user/a'));
  });

  it('Customize copies the rule into a user rule just above it', async () => {
    const p = props(withFinished(cfg(rule('a', 'a.com/*'))));
    render(Rules, p);
    const row = screen.getByRole('group', { name: 'Rule 3: Close OAuth callback tabs' });
    await fireEvent.click(row.querySelector('button.customize')!);
    const c = p.onChange.mock.calls.at(-1)![0] as Config;
    expect(c.rules.map((r) => r.id)).toEqual(['a', 'finished-oauth-callback']);
    expect(c.order.indexOf('user/finished-oauth-callback')).toBe(c.order.indexOf('finished/oauth-callback') - 1);
  });

  it('Test on a recipe row passes a config that enables its recipe (only mode, R53)', async () => {
    send.mockReset();
    send.mockResolvedValue({ ok: true, data: { moves: [], closes: [{ tabId: 1, title: 'cb', ruleKey: 'finished/oauth-callback', afterMs: 3000 }], groupsCreated: [], unchanged: 0, anchorsOpened: 0, dryRun: false } });
    const config = withFinished(cfg(rule('a', 'a.com/*')));
    render(Rules, props(config));
    const row = screen.getByRole('group', { name: 'Rule 3: Close OAuth callback tabs' });
    await fireEvent.click(row.querySelector('button.test')!);
    expect(await screen.findByText('0 tabs would move · 1 would close')).toBeTruthy();
    const req = send.mock.calls.map((c) => c[0]).find((r) => r.type === 'preview.change');
    expect(req.only).toBe('finished/oauth-callback');
    expect(req.config.recipes.find((r: { id: string }) => r.id === 'finished').enabled).toBe(true);
  });

  it('Test on a read-only (non-form) user rule (R53)', async () => {
    send.mockReset();
    send.mockResolvedValue({ ok: true, data: { moves: [], closes: [], groupsCreated: [], unchanged: 0, anchorsOpened: 0, dryRun: false } });
    const odd = { id: 'odd', name: 'Odd rule', enabled: true, match: { title: '*x*' }, actions: [{ showInView: { view: 'v' } }] };
    render(Rules, props({ ...defaultConfig(), rules: [odd], order: ['user/odd'] } as Config));
    const row = screen.getByRole('group', { name: 'Rule 1: Odd rule' });
    await fireEvent.click(row.querySelector('button.test')!);
    expect(await screen.findByText('0 tabs would move · 0 would close')).toBeTruthy();
    expect(send.mock.calls.map((c) => c[0]).find((r) => r.type === 'preview.change').only).toBe('user/odd');
  });
});
