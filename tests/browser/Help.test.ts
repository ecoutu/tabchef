import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup, render, screen } from '@testing-library/svelte';
import Help from '../../src/entrypoints/options/Help.svelte';

afterEach(cleanup);

describe('Help tooltip in a real browser', () => {
  // jsdom has no layout, so tests/ui/Help.test.ts can only fire mouseenter/mouseleave. Here the pointer really moves, and
  // the tip's box is checked to start right at the button's bottom edge: a gap would leave .help-tip on the way down to
  // the tip, hiding it before the pointer gets there (WCAG 1.4.13 hoverable).
  it('hover shows the tip right below the button; the pointer can move onto it, and leaving hides it', async () => {
    render(Help, { label: 'Mode', text: 'How duplicates are handled.' });
    const btn = screen.getByRole('button', { name: 'About Mode' });
    const tip = screen.getByRole('tooltip', { hidden: true });
    const wrap = btn.parentElement!;
    expect(tip.checkVisibility()).toBe(false);

    await userEvent.hover(btn);
    expect(tip.checkVisibility()).toBe(true);
    const b = btn.getBoundingClientRect();
    const body = tip.querySelector('.tip-body')!.getBoundingClientRect();
    expect(body.top).toBeGreaterThan(b.bottom); // the visible box sits below the button…
    for (let y = Math.ceil(b.bottom); y <= body.top + 1; y++) {
      // …and every point between them is still inside .help-tip
      expect(wrap.contains(document.elementFromPoint(b.left + b.width / 2, y))).toBe(true);
    }

    // The gap check above is what catches an unhoverable gap: hover() jumps straight onto the tip, so this only checks
    // that the tip itself keeps the hover.
    await userEvent.hover(tip.querySelector('.tip-body')!);
    expect(tip.checkVisibility()).toBe(true);
    await userEvent.unhover(wrap);
    expect(tip.checkVisibility()).toBe(false);
  });
});
