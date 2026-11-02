// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
vi.mock('../../src/ui/permissions', async (orig) => ({
  ...(await orig<typeof import('../../src/ui/permissions')>()),
  readPermissions: async () => ({ scripting: false, notifications: false, origins: [] }),
  onPermissionsChanged: () => () => {},
}));
import Dedupe from '../../src/entrypoints/options/Dedupe.svelte';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Config } from '../../src/core/types';

afterEach(cleanup);

const props = (config: Config, over = {}) => ({ config, dirty: true, saving: false, serverErrors: [] as string[], onChange: vi.fn(), onSave: vi.fn(), ...over });
const withDedupe = (d: Partial<Config['dedupe']>): Config => ({ ...defaultConfig(), dedupe: { ...defaultConfig().dedupe, ...d } });
const last = (fn: ReturnType<typeof vi.fn>): Config => fn.mock.calls.at(-1)![0] as Config;

describe('Dedupe options (T18 controls)', () => {
  it('global matchTitle checkbox', async () => {
    const p = props(defaultConfig());
    render(Dedupe, p);
    const cb = screen.getByLabelText(/same page title/) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    await fireEvent.click(cb);
    expect(last(p.onChange).dedupe.matchTitle).toBe(true);
  });

  it('adds, edits and removes a fragment override (pattern + keep/strip)', async () => {
    const p = props(withDedupe({ fragmentOverrides: [{ pattern: 'a.com/*', keepFragment: true }] }));
    render(Dedupe, p);
    await fireEvent.click(screen.getByRole('button', { name: 'Add fragment override' }));
    expect(last(p.onChange).dedupe.fragmentOverrides).toEqual([{ pattern: 'a.com/*', keepFragment: true }, { pattern: '', keepFragment: true }]);
    await fireEvent.input(screen.getByLabelText('Fragment override 1 pattern'), { target: { value: 'b.com/*' } });
    expect(last(p.onChange).dedupe.fragmentOverrides).toEqual([{ pattern: 'b.com/*', keepFragment: true }]);
    await fireEvent.change(screen.getByLabelText('Fragment override 1 action'), { target: { value: 'strip' } });
    expect(last(p.onChange).dedupe.fragmentOverrides).toEqual([{ pattern: 'a.com/*', keepFragment: false }]);
    await fireEvent.click(screen.getByRole('button', { name: 'Remove fragment override 1' }));
    expect(last(p.onChange).dedupe.fragmentOverrides).toEqual([]);
  });

  it('adds and edits a title override (pattern + compare/ignore titles)', async () => {
    const p = props(withDedupe({ titleOverrides: [{ pattern: 'github.com/acme*', matchTitle: false }] }));
    render(Dedupe, p);
    expect((screen.getByLabelText('Title override 1 action') as HTMLSelectElement).value).toBe('ignore');
    await fireEvent.change(screen.getByLabelText('Title override 1 action'), { target: { value: 'compare' } });
    expect(last(p.onChange).dedupe.titleOverrides).toEqual([{ pattern: 'github.com/acme*', matchTitle: true }]);
    await fireEvent.click(screen.getByRole('button', { name: 'Add title override' }));
    expect(last(p.onChange).dedupe.titleOverrides).toHaveLength(2);
  });

  it('an invalid override pattern shows its error and disables Save; hints show for look-alike hosts', () => {
    render(Dedupe, props(withDedupe({ fragmentOverrides: [{ pattern: '/(/', keepFragment: true }], titleOverrides: [{ pattern: 'github.com*', matchTitle: true }] })));
    expect(screen.getByText(/invalid regex/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/look-alike hosts/)).toBeTruthy();
  });

  it('shows server errors for the override lists', () => {
    render(Dedupe, props(defaultConfig(), { serverErrors: ['/dedupe/titleOverrides/0/pattern pattern too long'] }));
    expect(screen.getByText(/0\/pattern pattern too long/)).toBeTruthy();
  });

  it('every setting has a help tip (outside its label, so it never toggles the control)', () => {
    render(Dedupe, props(defaultConfig()));
    for (const name of ['Mode', 'Scope', 'Ignore #fragment', 'Ignore trailing slash', 'Kept tab follows the new #fragment',
      'Include incognito windows', 'Same page title', 'Strip query parameters', 'Allow duplicates', 'Always switch']) {
      const btn = screen.getByRole('button', { name: `About ${name}` });
      expect(btn.closest('label'), name).toBeNull();
      expect(document.getElementById(btn.getAttribute('aria-describedby')!)?.textContent?.length, name).toBeGreaterThan(20);
    }
  });
});

