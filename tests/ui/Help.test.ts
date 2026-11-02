// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import Help from '../../src/entrypoints/options/Help.svelte';

afterEach(cleanup);

describe('Help tooltip', () => {
  it('a "?" button described by its tip, so screen readers read the tip on focus', () => {
    render(Help, { label: 'Mode', text: 'How duplicates are handled.' });
    const btn = screen.getByRole('button', { name: 'About Mode' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip.textContent).toBe('How duplicates are handled.');
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('click toggles the tip open (for touch and mouse); Escape and blur close it', async () => {
    render(Help, { label: 'Mode', text: 'x' });
    const btn = screen.getByRole('button', { name: 'About Mode' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.keyDown(btn, { key: 'Escape' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(btn);
    await fireEvent.blur(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('two tips get distinct ids', () => {
    render(Help, { label: 'A', text: 'a' });
    render(Help, { label: 'B', text: 'b' });
    const ids = screen.getAllByRole('tooltip', { hidden: true }).map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});
