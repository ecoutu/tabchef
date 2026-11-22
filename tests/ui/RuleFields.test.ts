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
      'Strict', 'Merge across windows', 'Duplicates', 'Close tabs', 'Close after', 'Close mode', 'Dry run']) {
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

describe('RuleFields: a rule matching no URL (#240)', () => {
  const none: Rule = { id: 'n', name: 'N', enabled: true, match: { all: [{ url: [] }, { title: '*Inbox*' }] }, actions: [{ group: { title: 'G', color: 'blue' } }] };

  it('says the rule matches no tab until a URL pattern is added, and routes title errors to match/all/1/title', () => {
    render(RuleFields, { rule: none, form: ruleForm(none)!, index: 0, tabs: [], serverErrors: ['/rules/0/match/all/1/title bad'], onPatch: vi.fn() });
    expect((screen.getByRole('textbox', { name: /^URL patterns/ }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('note').textContent).toMatch(/no URL patterns.*matches no tab/i);
    expect(screen.getByText('title bad')).toBeTruthy();
  });

  it('shows a server error on its URL condition (match/all/0/url) under the URL field', () => {
    render(RuleFields, { rule: none, form: ruleForm(none)!, index: 0, tabs: [], serverErrors: ['/rules/0/match/all/0/url bad'], onPatch: vi.fn() });
    expect(screen.getByRole('alert').textContent).toBe('bad');
  });

  it('keeps url [] while its URL field holds only spaces, newlines or a pattern typed and deleted', async () => {
    const onPatch = vi.fn();
    const form = ruleForm(none)!;
    const { rerender } = render(RuleFields, { rule: none, form, index: 0, tabs: [], serverErrors: [], onPatch });
    const box = screen.getByRole('textbox', { name: /^URL patterns/ });
    await fireEvent.input(box, { target: { value: ' ' } });
    expect(onPatch).toHaveBeenLastCalledWith({ url: [] });
    await fireEvent.input(box, { target: { value: ' \n' } });
    expect(onPatch).toHaveBeenLastCalledWith({ url: [] });
    await fireEvent.input(box, { target: { value: 'a' } });
    expect(onPatch).toHaveBeenLastCalledWith({ url: 'a' });
    await rerender({ rule: none, form: { ...form, url: 'a' }, index: 0, tabs: [], serverErrors: [], onPatch });
    await fireEvent.input(box, { target: { value: '' } });
    expect(onPatch).toHaveBeenLastCalledWith({ url: [] });
  });

  it('keeps url [] when the first edit types a pattern and the next deletes it', async () => {
    const onPatch = vi.fn();
    const form = ruleForm(none)!;
    const { rerender } = render(RuleFields, { rule: none, form, index: 0, tabs: [], serverErrors: [], onPatch });
    const box = screen.getByRole('textbox', { name: /^URL patterns/ });
    await fireEvent.input(box, { target: { value: 'a' } });
    await rerender({ rule: none, form: { ...form, url: 'a' }, index: 0, tabs: [], serverErrors: [], onPatch });
    await fireEvent.input(box, { target: { value: '' } });
    expect(onPatch).toHaveBeenLastCalledWith({ url: [] });
  });

  it('keeps url [] for a rule reloaded in place as url: [] after an earlier edit', async () => {
    const onPatch = vi.fn();
    const withUrl: Rule = { ...none, match: { all: [{ url: 'x.com/*' }, { title: '*Inbox*' }] } };
    const { rerender } = render(RuleFields, { rule: withUrl, form: ruleForm(withUrl)!, index: 0, tabs: [], serverErrors: [], onPatch });
    const box = screen.getByRole('textbox', { name: /^URL patterns/ });
    await fireEvent.input(box, { target: { value: 'y.com/*' } });
    await rerender({ rule: none, form: ruleForm(none)!, index: 0, tabs: [], serverErrors: [], onPatch });
    await fireEvent.input(box, { target: { value: ' ' } });
    expect(onPatch).toHaveBeenLastCalledWith({ url: [] });
  });

  it('clearing the real patterns of a rule still gives no URL condition', async () => {
    const onPatch = vi.fn();
    const withUrl: Rule = { ...none, match: { all: [{ url: 'a.com/*' }, { title: '*Inbox*' }] } };
    render(RuleFields, { rule: withUrl, form: ruleForm(withUrl)!, index: 0, tabs: [], serverErrors: [], onPatch });
    await fireEvent.input(screen.getByRole('textbox', { name: /^URL patterns/ }), { target: { value: '' } });
    expect(onPatch).toHaveBeenLastCalledWith({ url: '' });
  });

  it('an empty URL field on an ordinary rule shows no such note', () => {
    const titled: Rule = { ...none, match: { title: '*Inbox*' } };
    render(RuleFields, { rule: titled, form: ruleForm(titled)!, index: 0, tabs: [], serverErrors: [], onPatch: vi.fn() });
    expect(screen.queryByRole('note')).toBeNull();
  });
});
