// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import RuleFields from '../../src/entrypoints/options/RuleFields.svelte';
import { ruleForm } from '../../src/ui/rules-model';
import type { Rule } from '../../src/core/lang/types';

afterEach(cleanup);

const rule: Rule = {
  id: 'r', name: 'R', enabled: true, match: { url: 'github.com/:owner/:repo*' },
  actions: [{ group: { title: '{repo}', color: 'blue' } }, { close: { after: '3s', mode: 'suggest' } }],
};

describe('RuleFields help tips', () => {
  it('every field of the rule form has a help tip beside (not inside) its label', () => {
    render(RuleFields, { rule, form: ruleForm(rule)!, index: 0, tabs: [], serverErrors: [], onPatch: vi.fn() });
    for (const name of ['URL patterns', 'Title pattern', 'Group tabs', 'Group name', 'Color', 'Group order', 'Collapsed',
      'Strict', 'Merge across windows', 'Dedupe override', 'Close tabs', 'Close after', 'Close mode', 'Dry run']) {
      const btn = screen.getByRole('button', { name: `About ${name}` });
      expect(btn.closest('label'), name).toBeNull();
      expect(document.getElementById(btn.getAttribute('aria-describedby')!)?.textContent?.length, name).toBeGreaterThan(20);
    }
  });

  it('the controls still work through their labels', async () => {
    const onPatch = vi.fn();
    render(RuleFields, { rule, form: ruleForm(rule)!, index: 0, tabs: [], serverErrors: [], onPatch });
    await fireEvent.click(screen.getByRole('checkbox', { name: /Strict/ }));
    expect(onPatch).toHaveBeenLastCalledWith({ group: expect.objectContaining({ strict: false }) });
    await fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'red' } });
    expect(onPatch).toHaveBeenLastCalledWith({ group: expect.objectContaining({ color: 'red' }) });
  });
});
