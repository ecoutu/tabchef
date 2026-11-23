import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
vi.mock('../../src/ui/send', () => ({ send: vi.fn() }));
import Rules from '../../src/entrypoints/options/Rules.svelte';
import { defaultConfig } from '../../src/core/config/defaults';
import { customizeRule } from '../../src/ui/rules-model';
import { builtinRecipes } from '../../src/recipes/load';
import type { Config, GroupRule, TabSnap } from '../../src/core/types';
import { withGroupRules } from '../helpers/config';

afterEach(() => {
  cleanup();
  document.body.style.paddingBottom = '';
  window.scrollTo(0, 0);
});

const rule = (id: string): GroupRule => ({ id, name: `Rule ${id}`, enabled: true, match: { url: `${id}.com/*` }, group: { title: id, color: 'blue' } });
const props = (config: Config) => ({ config, saved: defaultConfig(), tabs: [] as TabSnap[], dirty: true, saving: false, serverErrors: [] as string[], onChange: vi.fn(), onSave: vi.fn() });

describe('Rules in a real browser', () => {
  // jsdom has no layout and no scrollIntoView (Rules calls it optionally), so tests/ui/Rules.test.ts can only check the
  // focus move. Here the page really scrolls: focus() alone scrolls the name field into view without centering the row
  // (208px off center when scrollIntoView is removed).
  it('Edit copy scrolls the customized copy to the middle of the viewport and focuses its name', async () => {
    const many = withGroupRules(Array.from({ length: 12 }, (_, i) => rule(`r${i}`)));
    const config = customizeRule({ ...many, recipes: many.recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true } : r)) }, 'finished/oauth-callback', builtinRecipes());
    render(Rules, props(config));
    await fireEvent.click(screen.getByRole('button', { name: /Finished · 3 rules/ }));
    document.body.style.paddingBottom = '200vh'; // room to center a row near the end of the list
    window.scrollTo(0, 0);

    const copy = screen.getByRole('group', { name: /Close OAuth callback tabs \(custom\)$/ });
    expect(copy.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight); // starts off-screen
    const btn = screen.getByRole('group', { name: /Close OAuth callback tabs$/ }).querySelector('button.customize') as HTMLButtonElement;
    expect(btn.textContent).toBe('Edit copy');
    btn.click(); // a DOM click: Playwright's click would scroll the button into view first
    await tick();

    expect(document.activeElement).toBe(copy.querySelector('input.name'));
    const r = copy.getBoundingClientRect();
    // scrollIntoView centres in the scrollport, which excludes scrollbars: window.innerHeight includes them.
    const viewport = document.documentElement.clientHeight;
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(viewport);
    expect(Math.abs(r.top + r.height / 2 - viewport / 2)).toBeLessThanOrEqual(1);
  });
});
