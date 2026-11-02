// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPageWatch, WATCH_SCAN_MS, MAX_EXTRACT_CHARS } from '../../src/engine/page-watch';
import type { PageFactsMessage, WatchConfigMessage } from '../../src/engine/messages';

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
});
