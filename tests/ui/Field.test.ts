// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import Field from '../../src/entrypoints/options/Field.svelte';

afterEach(cleanup);
const control = (html: string) => createRawSnippet(() => ({ render: () => html }));

describe('Field', () => {
  it('labels its control (stacked: text above) and puts the help tip beside the label, not inside', () => {
    render(Field, { label: 'Color', help: 'The group color.', children: control('<select><option>blue</option></select>') });
    expect(screen.getByLabelText('Color').tagName).toBe('SELECT');
    const btn = screen.getByRole('button', { name: 'About Color' });
    expect(btn.closest('label')).toBeNull();
  });

  it('inline: the control comes first (checkbox), helpLabel names the tip', () => {
    render(Field, { label: 'Strict (ungroup when URL stops matching)', helpLabel: 'Strict', inline: true, help: 'x', children: control('<input type="checkbox">') });
    expect(screen.getByRole('checkbox', { name: /ungroup when URL stops matching/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About Strict' })).toBeTruthy();
  });

  it('without help, no tip', () => {
    render(Field, { label: 'Name', children: control('<input>') });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
