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

  it('hidden by default; hover shows it and leaving hides it; keyboard focus shows it', async () => {
    render(Help, { label: 'Mode', text: 'x' });
    const btn = screen.getByRole('button', { name: 'About Mode' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    const wrap = btn.parentElement!;
    expect(tip.hidden).toBe(true);
    await fireEvent.mouseEnter(wrap);
    expect(tip.hidden).toBe(false);
    await fireEvent.mouseLeave(wrap);
    expect(tip.hidden).toBe(true);
    await fireEvent.focus(btn);
    expect(tip.hidden).toBe(false);
    await fireEvent.blur(btn);
    expect(tip.hidden).toBe(true);
  });

  it('open by focus or hover: the first click or Enter closes it, the next opens it, so each one visibly toggles', async () => {
    render(Help, { label: 'Mode', text: 'x' });
    const btn = screen.getByRole('button', { name: 'About Mode' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    await fireEvent.focus(btn);
    expect(tip.hidden).toBe(false);
    await fireEvent.click(btn); // Enter on a focused button activates it as a click
    expect(tip.hidden).toBe(true);
    await fireEvent.click(btn);
    expect(tip.hidden).toBe(false);
    await fireEvent.click(btn);
    expect(tip.hidden).toBe(true);
    await fireEvent.blur(btn);
    await fireEvent.mouseEnter(btn.parentElement!);
    expect(tip.hidden).toBe(false);
    await fireEvent.click(btn);
    expect(tip.hidden).toBe(true);
  });

  it('a tap (touch) on a tip that hover/focus emulation already showed pins it open', async () => {
    render(Help, { label: 'Mode', text: 'x' });
    const btn = screen.getByRole('button', { name: 'About Mode' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    // Chrome on Android fires mouseenter and focus before the tap's click.
    await fireEvent.mouseEnter(btn.parentElement!);
    await fireEvent.focus(btn);
    const tap = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(tap, 'pointerType', { value: 'touch' });
    await fireEvent(btn, tap);
    expect(tip.hidden).toBe(false);
    await fireEvent.mouseLeave(btn.parentElement!);
    expect(tip.hidden).toBe(false);
    const again = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(again, 'pointerType', { value: 'touch' });
    await fireEvent(btn, again);
    expect(tip.hidden).toBe(true);
  });

  it('two tips get distinct ids', () => {
    render(Help, { label: 'A', text: 'a' });
    render(Help, { label: 'B', text: 'b' });
    const ids = screen.getAllByRole('tooltip', { hidden: true }).map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});
