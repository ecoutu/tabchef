// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
const send = vi.fn();
vi.mock('../../src/ui/send', () => ({ send: (r: unknown) => send(r) }));
import NewRule from '../../src/entrypoints/options/NewRule.svelte';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config, GroupRule, TabSnap } from '../../src/core/types';
import { withGroupRules } from '../helpers/config';

afterEach(cleanup);

const PR = 'https://github.com/acme/api/pull/123/files?x=1';
const tab = (id: number, url: string): TabSnap => ({ id, windowId: 1, index: id, url, title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false });
const TABS = [
  tab(1, 'https://github.com/acme/api/pull/123/files'),
  tab(2, 'https://github.com/acme/api/pull/7'),
  tab(3, 'https://github.com/acme/api/issues/9'),
  tab(4, 'https://github.com/acme/web/'),
  tab(5, 'https://example.com/'),
];
const props = (over: Record<string, unknown> = {}) => ({
  url: PR, kind: 'group', config: defaultConfig() as Config, tabs: TABS, saving: false, onSave: vi.fn(), ...over,
});
const patternBox = () => screen.getByRole('textbox', { name: 'URL pattern' }) as HTMLInputElement;
const saveBtn = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

describe('NewRule (M2 T16)', () => {
  it('lists the suggested patterns, selects the most specific, and shows its live count', () => {
    render(NewRule, props());
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['github.com/acme/api/pull/*', 'github.com/acme/api/*', 'github.com/acme/*', 'github.com/*']);
    expect(radios[0]!.checked).toBe(true);
    expect(patternBox().value).toBe('github.com/acme/api/pull/*');
    expect(screen.getByText('Matches 2 open tabs')).toBeTruthy();
  });

  it('picking another candidate or editing the pattern updates the count', async () => {
    render(NewRule, props());
    await fireEvent.click(screen.getByRole('radio', { name: 'github.com/acme/api/*' }));
    expect(patternBox().value).toBe('github.com/acme/api/*');
    expect(screen.getByText('Matches 3 open tabs')).toBeTruthy();
    await fireEvent.input(patternBox(), { target: { value: 'example.com/*' } });
    expect(screen.getByText('Matches 1 open tab')).toBeTruthy();
    // An edited pattern no longer selects a candidate.
    expect((screen.getAllByRole('radio') as HTMLInputElement[]).some((r) => r.checked)).toBe(false);
  });

  it('shows the editor hints for the pattern (exact path; R32 look-alike host)', async () => {
    render(NewRule, props());
    await fireEvent.input(patternBox(), { target: { value: 'github.com/acme' } });
    expect(screen.getByText(/matches only exactly this path/)).toBeTruthy();
    await fireEvent.input(patternBox(), { target: { value: 'github.com*' } });
    expect(screen.getByText(/also matches look-alike hosts/)).toBeTruthy();
  });

  it('an invalid or empty pattern disables Save', async () => {
    render(NewRule, props());
    await fireEvent.input(patternBox(), { target: { value: '/(/' } });
    expect(screen.getByText(/invalid regex/)).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    await fireEvent.input(patternBox(), { target: { value: '' } });
    expect(saveBtn().disabled).toBe(true);
  });

  it('group, new group: Save hands App a config with the new rule first in priority', async () => {
    const p = props();
    render(NewRule, p);
    await fireEvent.click(screen.getByRole('radio', { name: 'github.com/acme/api/*' }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Group title' }), { target: { value: 'API' } });
    await fireEvent.change(screen.getByRole('combobox', { name: 'Color' }), { target: { value: 'green' } });
    await fireEvent.click(saveBtn());
    const c = p.onSave.mock.calls[0]![0] as Config;
    const r = c.rules.at(-1)!;
    expect(r.match).toEqual({ url: 'github.com/acme/api/*' });
    expect(r.actions).toEqual([{ group: { title: 'API', color: 'green' } }]);
    expect(c.order[0]).toBe(`user/${r.id}`);
  });

  it('group, existing group rule: Save adds the pattern to that rule', async () => {
    const g: GroupRule = { id: 'gh', name: 'GitHub', enabled: true, match: { url: 'github.com/acme/web/*' }, group: { title: 'GH', color: 'blue' } };
    const config = withGroupRules([g]);
    const p = props({ config });
    render(NewRule, p);
    await fireEvent.change(screen.getByRole('combobox', { name: 'Group' }), { target: { value: 'gh' } });
    expect(screen.queryByRole('textbox', { name: 'Group title' })).toBeNull();
    await fireEvent.click(saveBtn());
    const c = p.onSave.mock.calls[0]![0] as Config;
    expect(c.rules).toHaveLength(config.rules.length);
    expect(c.rules.find((r) => r.id === 'gh')!.match).toEqual({ url: ['github.com/acme/web/*', 'github.com/acme/api/pull/*'] });
  });

  it('close: close settings, Save builds a close rule', async () => {
    const p = props({ kind: 'close' });
    render(NewRule, p);
    expect(screen.queryByRole('combobox', { name: 'Group' })).toBeNull();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Close after' }), { target: { value: '10m' } });
    await fireEvent.change(screen.getByRole('combobox', { name: 'Close mode' }), { target: { value: 'suggest' } });
    await fireEvent.click(saveBtn());
    const r = (p.onSave.mock.calls[0]![0] as Config).rules.at(-1)!;
    expect(r.actions).toEqual([{ close: { after: '10m', mode: 'suggest' } }]);
  });

  it('close: an invalid duration disables Save', async () => {
    render(NewRule, props({ kind: 'close' }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Close after' }), { target: { value: 'soon' } });
    expect(saveBtn().disabled).toBe(true);
  });

  it('allowDup: pre-selects the whole site and builds a dedupe-off rule', async () => {
    const p = props({ kind: 'allowDup' });
    render(NewRule, p);
    expect(patternBox().value).toBe('github.com/*');
    expect(screen.getByText('Matches 4 open tabs')).toBeTruthy();
    await fireEvent.click(saveBtn());
    const r = (p.onSave.mock.calls[0]![0] as Config).rules.at(-1)!;
    expect(r.match).toEqual({ url: 'github.com/*' });
    expect(r.actions).toEqual([{ dedupe: { mode: 'off' } }]);
  });

  it('a URL with no suggestions (chrome://) leaves only the free edit box', () => {
    render(NewRule, props({ url: 'chrome://settings' }));
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(patternBox().value).toBe('');
    expect(saveBtn().disabled).toBe(true);
  });

  it('an unknown kind says so and offers no Save', () => {
    render(NewRule, props({ kind: 'bogus' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Unknown rule kind/);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('Save is disabled while saving', () => {
    render(NewRule, props({ saving: true }));
    expect(saveBtn().disabled).toBe(true);
  });
});
