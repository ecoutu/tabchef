// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPageWatch, WATCH_SCAN_MS, MAX_EXTRACT_CHARS } from '../../src/engine/page-watch';
import { isPageFactsMessage, MAX_FACT_ITEMS, MAX_FACT_TEXT, type PageFactsMessage, type WatchConfigMessage } from '../../src/engine/messages';

type Sent = { type: string; [k: string]: unknown };

function setup(config: Omit<WatchConfigMessage, 'type'>, body = '') {
  document.body.innerHTML = body;
  const sent: Sent[] = [];
  const send = vi.fn(async (m: Sent) => {
    sent.push(structuredClone(m));
    return m.type === 'watch.hello' ? ({ type: 'watch.config', ...config } satisfies WatchConfigMessage) : undefined;
  });
  const w = startPageWatch({ doc: document, win: window, send });
  const facts = () => sent.filter((m): m is Sent & PageFactsMessage => m.type === 'page.facts');
  return { sent, facts, w };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('page watch content script', () => {
  it('says hello first, then reports only the matched needles, never the page text', async () => {
    const { sent, facts, w } = setup({ needles: ['you left the meeting', 'rejoin later'], selectors: [] },
      '<main><h1>You left the meeting</h1><p>secret stuff 1234</p></main>');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]).toEqual({ type: 'watch.hello', formEdited: false });
    expect(facts()).toEqual([{ type: 'page.facts', texts: ['you left the meeting'], extracts: {}, formEdited: false }]);
    expect(JSON.stringify(sent)).not.toContain('secret');
    w.stop();
  });

  it('a DOM mutation adding the text after 2 s → one message; re-scans are throttled to once per second', async () => {
    const { facts, w } = setup({ needles: ['call ended'], selectors: [] }, '<div id="app">In call</div>');
    await vi.advanceTimersByTimeAsync(0);
    expect(facts()).toHaveLength(1);
    expect(facts()[0]!.texts).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    const app = document.getElementById('app')!;
    app.textContent = 'Call ended';
    await vi.advanceTimersByTimeAsync(0);
    expect(facts()).toHaveLength(2);
    expect(facts()[1]!.texts).toEqual(['call ended']);
    // A burst inside the next second: removing and re-adding the text is seen as no change.
    app.textContent = 'In call';
    await vi.advanceTimersByTimeAsync(100);
    app.textContent = 'Call ended';
    await vi.advanceTimersByTimeAsync(WATCH_SCAN_MS);
    expect(facts()).toHaveLength(2);
    w.stop();
  });

  it('never reports more than the worker guard accepts: needles over MAX_FACT_TEXT, more than MAX_FACT_ITEMS items, long keys (I2)', async () => {
    const long = 'y'.repeat(MAX_FACT_TEXT + 1);
    const many = Array.from({ length: MAX_FACT_ITEMS + 20 }, (_, i) => `n${i}`);
    const keys = Array.from({ length: MAX_FACT_ITEMS + 5 }, (_, i) => ({ key: `r.k${i}`, selector: 'p' }));
    const { facts, w } = setup(
      { needles: [long, ...many], selectors: [{ key: 'r.'.padEnd(MAX_FACT_TEXT + 1, 'z'), selector: 'p' }, ...keys] },
      `<p>v</p>${long} ${many.join(' ')}`,
    );
    await vi.advanceTimersByTimeAsync(0);
    const m = facts()[0]!;
    expect(m.texts).toHaveLength(MAX_FACT_ITEMS);
    expect(m.texts).not.toContain(long);
    expect(Object.keys(m.extracts)).toHaveLength(MAX_FACT_ITEMS);
    expect(Object.keys(m.extracts).every((k) => k.length <= MAX_FACT_TEXT)).toBe(true);
    expect(isPageFactsMessage(m)).toBe(true);
    w.stop();
  });

  it('extracts selector text (trimmed, capped) and attributes under the rule-key names', async () => {
    const long = 'x'.repeat(MAX_EXTRACT_CHARS + 50);
    const { facts, w } = setup({
      needles: [],
      selectors: [
        { key: 'r1.branch', selector: '.head-ref' },
        { key: 'r1.who', selector: 'img.avatar', attr: 'alt' },
        { key: 'r1.long', selector: '#long' },
        { key: 'r1.missing', selector: '.nope' },
        { key: 'r1.bad', selector: '[[[' },
      ],
    }, `<span class="head-ref">\n  feat/ABC-1 </span><img class="avatar" alt="octocat"><p id="long">${long}</p>`);
    await vi.advanceTimersByTimeAsync(0);
    expect(facts()[0]!.extracts).toEqual({ 'r1.branch': 'feat/ABC-1', 'r1.who': 'octocat', 'r1.long': 'x'.repeat(MAX_EXTRACT_CHARS) });
    w.stop();
  });

  it('typing in a textarea → formEdited: true (sent at once); a form submit clears it', async () => {
    const { facts, w } = setup({ needles: [], selectors: [] }, '<form><textarea id="t"></textarea></form><div id="ce" contenteditable="true"></div>');
    await vi.advanceTimersByTimeAsync(0);
    expect(facts().at(-1)!.formEdited).toBe(false);
    const ta = document.getElementById('t') as HTMLTextAreaElement;
    ta.value = 'hello';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(facts().at(-1)).toMatchObject({ formEdited: true });
    const n = facts().length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(facts()).toHaveLength(n); // unchanged facts are not re-sent
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(facts().at(-1)).toMatchObject({ formEdited: false });
    document.getElementById('ce')!.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(facts().at(-1)).toMatchObject({ formEdited: true });
    w.stop();
  });

  it('input on a non-editable element does not count', async () => {
    const { facts, w } = setup({ needles: [], selectors: [] }, '<div id="d"></div>');
    await vi.advanceTimersByTimeAsync(0);
    document.getElementById('d')!.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(facts().every((m) => !m.formEdited)).toBe(true);
    w.stop();
  });

  it('a back/forward-cache restore says hello again with the current formEdited and re-sends the facts', async () => {
    const { sent, facts, w } = setup({ needles: ['x'], selectors: [] }, '<textarea id="t"></textarea> x');
    await vi.advanceTimersByTimeAsync(0);
    document.getElementById('t')!.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    const n = facts().length;
    const ev = new Event('pageshow') as Event & { persisted: boolean };
    Object.defineProperty(ev, 'persisted', { value: true });
    window.dispatchEvent(ev);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((m) => m.type === 'watch.hello').at(-1)).toEqual({ type: 'watch.hello', formEdited: true });
    expect(facts()).toHaveLength(n + 1);
    expect(facts().at(-1)).toEqual({ type: 'page.facts', texts: ['x'], extracts: {}, formEdited: true });
    w.stop();
  });

  it('a failed hello (worker unreachable) still watches form edits with an empty config', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const sent: Sent[] = [];
    const send = vi.fn(async (m: Sent) => { sent.push(m); if (m.type === 'watch.hello') throw new Error('no receiver'); });
    const w = startPageWatch({ doc: document, win: window, send });
    await vi.advanceTimersByTimeAsync(0);
    document.getElementById('t')!.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((m) => m.type === 'page.facts').at(-1)).toMatchObject({ formEdited: true, texts: [] });
    w.stop();
  });

  describe('same-document navigation (SPA): fresh hello, new config, stale facts dropped', () => {
    // jsdom pages are same-origin with http://localhost:3000; pushState may only change the path.
    const REPO = 'http://localhost:3000/o/r';
    const PR = 'http://localhost:3000/o/r/pull/1';
    function spa(nav?: EventTarget) {
      history.replaceState(null, '', REPO);
      document.body.innerHTML = '<textarea id="t"></textarea><span class="repo">o/r</span>';
      const sent: Sent[] = [];
      const send = vi.fn(async (m: Sent) => {
        sent.push(structuredClone(m));
        if (m.type !== 'watch.hello') return undefined;
        // The worker answers for the URL the page is on (watchConfigFor).
        return location.href === PR
          ? { type: 'watch.config', needles: [], selectors: [{ key: 'pr.branch', selector: '.head-ref' }] }
          : { type: 'watch.config', needles: [], selectors: [{ key: 'repo.name', selector: '.repo' }] };
      });
      const w = startPageWatch({ doc: document, win: window, send, ...(nav && { nav }) });
      const facts = () => sent.filter((m): m is Sent & PageFactsMessage => m.type === 'page.facts');
      const hellos = () => sent.filter((m) => m.type === 'watch.hello');
      return { sent, facts, hellos, w };
    }
    const toPr = () => {
      history.pushState(null, '', PR);
      document.body.innerHTML = '<textarea id="t"></textarea><span class="head-ref">feat/ABC-1</span>';
    };
    afterEach(() => { history.replaceState(null, '', 'http://localhost:3000/'); });

    it('detected by the throttled scan: re-hello, PR config applies, repo extract and the old form edit are dropped', async () => {
      const { facts, hellos, w } = spa();
      await vi.advanceTimersByTimeAsync(0);
      document.getElementById('t')!.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(facts().at(-1)).toMatchObject({ extracts: { 'repo.name': 'o/r' }, formEdited: true });
      await vi.advanceTimersByTimeAsync(2000);
      toPr();
      await vi.advanceTimersByTimeAsync(0);
      expect(hellos()).toHaveLength(2);
      expect(hellos()[1]).toEqual({ type: 'watch.hello', formEdited: false }); // edits belong to the old URL
      expect(facts().at(-1)).toEqual({ type: 'page.facts', texts: [], extracts: { 'pr.branch': 'feat/ABC-1' }, formEdited: false });
      w.stop();
    });

    it('detected at once by the Navigation API (currententrychange) and by popstate', async () => {
      const nav = new EventTarget();
      const { facts, hellos, w } = spa(nav);
      await vi.advanceTimersByTimeAsync(0);
      // No DOM mutation needed: the URL change alone re-hellos and reports fresh (empty) facts.
      history.pushState(null, '', PR);
      nav.dispatchEvent(new Event('currententrychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(hellos()).toHaveLength(2);
      expect(facts().at(-1)).toEqual({ type: 'page.facts', texts: [], extracts: {}, formEdited: false });
      history.back(); // jsdom: async, fires popstate
      await vi.waitFor(() => expect(location.href).toBe(REPO));
      await vi.advanceTimersByTimeAsync(0);
      expect(hellos()).toHaveLength(3);
      expect(facts().at(-1)).toMatchObject({ extracts: { 'repo.name': 'o/r' } });
      w.stop();
    });

    it('no facts are reported between the new hello and its answer (the worker just cleared them)', async () => {
      const { sent, w } = spa();
      await vi.advanceTimersByTimeAsync(0);
      const orig = sent.length;
      toPr();
      window.dispatchEvent(new PopStateEvent('popstate'));
      document.getElementById('t')!.dispatchEvent(new Event('input', { bubbles: true }));
      // The answer is async: until it lands, the edit is not reported on its own; it rides on the fresh facts.
      expect(sent.slice(orig).map((m) => m.type)).toEqual(['watch.hello']);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.slice(orig).map((m) => m.type)).toEqual(['watch.hello', 'page.facts']);
      expect(sent.at(-1)).toMatchObject({ formEdited: true, extracts: { 'pr.branch': 'feat/ABC-1' } });
      w.stop();
    });
  });
});

