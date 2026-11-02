// @vitest-environment jsdom
// The PR state pill and stale marker shared by the list views (T13) and the project cards (T17).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import PrPill from '../../src/ui/PrPill.svelte';

afterEach(cleanup);

describe('PrPill', () => {
  it('a state pill, and a stale marker labelled with the caller\'s copy', () => {
    const { container } = render(PrPill, { state: 'merged', stale: true, staleLabel: 'Last known state; GitHub unavailable' });
    expect(screen.getByText('merged').className).toContain('pill-merged');
    const marker = screen.getByTitle('Last known state; GitHub unavailable');
    expect(marker.getAttribute('aria-label')).toBe('Last known state; GitHub unavailable');
    expect(marker.textContent).toBe('stale');
    expect(container.querySelectorAll('.pr-stale')).toHaveLength(1);
  });

  it('nothing without a state or staleness', () => {
    const { container } = render(PrPill, { staleLabel: 'x' });
    expect(container.textContent?.trim()).toBe('');
  });
});
