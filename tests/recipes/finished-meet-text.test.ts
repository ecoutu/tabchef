// @vitest-environment jsdom
// T10 minor, deferred to T20: Meet may render "You’ve left the call" with a curly apostrophe (U+2019), while the
// meet-ended default needle is typed with a straight one. Not checkable in e2e: the meet-ended rule needs the
// meet.google.com host grant, and optional permissions cannot be granted there (M1 ruling T18). This runs the real
// chain instead: the watch content script's needle matcher (page-watch) on a page, then the recipe's pageText rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileProgram } from '../../src/core/lang/compile';
import { evaluateTab } from '../../src/core/lang/evaluate';
import { defaultConfig } from '../../src/core/config/defaults';
import { startPageWatch } from '../../src/engine/page-watch';
import type { PageFactsMessage, WatchConfigMessage } from '../../src/engine/messages';
import { builtinRecipes } from '../../src/recipes/load';
import type { Config, TabSnap } from '../../src/core/types';
import type { Recipe } from '../../src/core/lang/types';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const needles = (builtinRecipes().finished as Recipe).params!.meetEndedTexts!.default as string[];

/** The needles the watch content script reports for a page whose body is `body`. */
async function reported(body: string): Promise<string[]> {
  document.body.innerHTML = body;
  const sent: PageFactsMessage[] = [];
  const w = startPageWatch({
    doc: document, win: window,
    send: async (m) => {
      if (m.type === 'page.facts') sent.push(structuredClone(m));
      return m.type === 'watch.hello' ? ({ type: 'watch.config', needles, selectors: [] } satisfies WatchConfigMessage) : undefined;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  w.stop();
  return sent.at(-1)?.texts ?? [];
}

/** The meet-ended close for a Meet tab whose watch reported `texts`. */
function meetClose(texts: string[]) {
  const c = defaultConfig();
  const cfg: Config = { ...c, recipes: c.recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true } : r)) };
  const tab: TabSnap = {
    id: 1, windowId: 1, index: 0, url: MEET_URL, title: 'Meet', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false,
  };
  return evaluateTab(compileProgram(cfg, builtinRecipes()).program, { tab, page: { texts, extracts: {}, formEdited: false } }, 0).close;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('finished recipe: Meet "left the call" apostrophes', () => {
  it('straight apostrophe on the page: the default needle matches and meet-ended closes', async () => {
    const texts = await reported("<main><h1>You've left the call</h1></main>");
    expect(texts).toEqual(["You've left the call"]);
    expect(meetClose(texts)).toMatchObject({ key: 'finished/meet-ended' });
  });

  // CONCERN (T20 report): the matcher is a plain case-insensitive substring test, so the straight-apostrophe needle
  // misses the curly text, and no other default needle covers that page. `it.fails` records today's behavior; it
  // turns red once the gap is fixed (then drop `.fails`).
  it.fails('curly apostrophe on the page (“You’ve left the call”): the default needles match', async () => {
    const texts = await reported('<main><h1>You’ve left the call</h1></main>');
    expect(texts).not.toEqual([]);
    expect(meetClose(texts)).toMatchObject({ key: 'finished/meet-ended' });
  });

  it('documents the gap directly: a curly-apostrophe page reports no needle, so meet-ended does not close', async () => {
    const texts = await reported('<main><h1>You’ve left the call</h1></main>');
    expect(texts).toEqual([]);
    expect(meetClose(texts)).toBeUndefined();
  });
});
