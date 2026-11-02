// @vitest-environment jsdom
// The YAML view of one rule (M2 T15): edits the same Rule object as the form; errors carry their line.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import RuleYaml from '../../src/entrypoints/options/RuleYaml.svelte';
import { ruleToYaml } from '../../src/ui/rules-model';
import type { Rule } from '../../src/core/types';

afterEach(cleanup);

const rule: Rule = { id: 'a', name: 'A', enabled: true, match: { url: 'a.com/*' }, actions: [{ group: { title: 'A', color: 'blue' } }] };
const props = (r: Rule = rule, onChange = vi.fn<(r: Rule) => string | undefined>(() => undefined)) => ({ rule: r, onChange, onValidity: vi.fn() });
const area = () => screen.getByRole('textbox', { name: 'Rule YAML' }) as HTMLTextAreaElement;

describe('RuleYaml', () => {
  it('shows the rule as YAML', () => {
    render(RuleYaml, props());
    expect(area().value).toBe(ruleToYaml(rule));
  });

  it('valid YAML edits the rule through onChange', async () => {
    const p = props();
    render(RuleYaml, p);
    await fireEvent.input(area(), { target: { value: ruleToYaml({ ...rule, name: 'Renamed' }) } });
    expect(p.onChange).toHaveBeenLastCalledWith({ ...rule, name: 'Renamed' });
    expect(p.onValidity).toHaveBeenLastCalledWith(true);
  });

  it('invalid YAML shows each error with its line and keeps the last valid rule', async () => {
    const p = props();
    render(RuleYaml, p);
    await fireEvent.input(area(), { target: { value: "id: x\nname: X\nenabled: true\nactions: [{ eval: x }]\nmatch: { url: 'a.com/*' }\n" } });
    expect(screen.getByText('Line 4: actions/0: must NOT have additional properties: eval')).toBeTruthy();
    expect(screen.getByText(/last valid version is kept/)).toBeTruthy();
    expect(p.onChange).not.toHaveBeenCalled();
    expect(p.onValidity).toHaveBeenLastCalledWith(false);
  });

  it('shows an error onChange returns (e.g. an id that collides)', async () => {
    const p = props(rule, vi.fn(() => 'Another rule already has id "b"'));
    render(RuleYaml, p);
    await fireEvent.input(area(), { target: { value: ruleToYaml({ ...rule, id: 'b' }) } });
    expect(screen.getByText('Another rule already has id "b"')).toBeTruthy();
    expect(p.onValidity).toHaveBeenLastCalledWith(false);
  });

  it('hints on exact-path patterns and open-ended host globs (R32, T15/T16 follow-up)', () => {
    render(RuleYaml, props({ ...rule, match: { any: [{ url: 'https://github.com/:repo' }, { url: 'https://github.com*' }] } }));
    expect(screen.getByText('https://github.com/:repo: matches only exactly this path; add * to include deeper pages')).toBeTruthy();
    expect(screen.getByText(/https:\/\/github\.com\*: also matches look-alike hosts such as github\.com\.evil\.com/)).toBeTruthy();
  });

  it('resyncs when the rule changes from outside', async () => {
    const r = render(RuleYaml, props());
    await r.rerender({ rule: { ...rule, name: 'Outside' } });
    expect(area().value).toContain('name: Outside');
  });
});
