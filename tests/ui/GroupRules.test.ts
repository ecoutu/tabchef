// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import GroupRules from '../../src/entrypoints/options/GroupRules.svelte';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config, GroupRule, TabSnap } from '../../src/core/types';

afterEach(cleanup);

const rule = (id: string, url: string | string[]): GroupRule => ({ id, name: `Rule ${id}`, enabled: true, match: { url }, group: { title: id, color: 'blue' } });
const cfg = (...rules: GroupRule[]): Config => ({ ...defaultConfig(), groupRules: rules });
const tab = (id: number, url: string): TabSnap => ({ id, windowId: 1, index: id, url, title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false });
const props = (config: Config, over = {}) => ({ config, tabs: [] as TabSnap[], dirty: true, saving: false, serverErrors: [] as string[], onChange: vi.fn(), onSave: vi.fn(), ...over });

describe('GroupRules', () => {
  it('shows "invalid regex" for /(/ and disables Save', () => {
    render(GroupRules, props(cfg(rule('a', '/(/'))));
    expect(screen.getByText(/invalid regex/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Save when valid and dirty, and calls onSave', async () => {
    const p = props(cfg(rule('a', 'a.com/*')));
    render(GroupRules, p);
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    expect(p.onSave).toHaveBeenCalled();
  });

  it('Save is disabled when nothing changed', () => {
    render(GroupRules, props(cfg(rule('a', 'a.com/*')), { dirty: false }));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the live match count', () => {
    render(GroupRules, props(cfg(rule('a', 'github.com/acme/*')), { tabs: [tab(1, 'https://github.com/acme/x'), tab(2, 'https://other.com/')] }));
    expect(screen.getByText('Matches 1 open tab')).toBeTruthy();
  });

  it('Move down reorders via onChange; first Move up and last Move down are disabled', async () => {
    const p = props(cfg(rule('a', 'a.com/*'), rule('b', 'b.com/*')));
    render(GroupRules, p);
    const ups = screen.getAllByRole('button', { name: 'Move up' }) as HTMLButtonElement[];
    const downs = screen.getAllByRole('button', { name: 'Move down' }) as HTMLButtonElement[];
    expect(ups[0]!.disabled).toBe(true);
    expect(downs[1]!.disabled).toBe(true);
    await fireEvent.click(downs[0]!);
    expect(p.onChange.mock.calls[0]![0].groupRules.map((r: GroupRule) => r.id)).toEqual(['b', 'a']);
  });

  it('Add rule appends a rule', async () => {
    const p = props(cfg());
    render(GroupRules, p);
    await fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(p.onChange.mock.calls[0]![0].groupRules).toHaveLength(1);
  });

  it('shows server errors inline next to the matching field', () => {
    render(GroupRules, props(cfg(rule('a', 'a.com/*')), { serverErrors: ['/groupRules/0/group/color must be equal to one of the allowed values'] }));
    expect(screen.getByText(/must be equal to one of the allowed values/)).toBeTruthy();
  });

  it('help text states order is priority', () => {
    render(GroupRules, props(cfg()));
    expect(screen.getByText(/Order is priority and tab-bar order/)).toBeTruthy();
  });
});
