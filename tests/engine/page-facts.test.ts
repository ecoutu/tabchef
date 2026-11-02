import { describe, expect, it, vi } from 'vitest';
import { PAGE_FACTS_KEY, PAGE_HOLD_MS, PageFacts, usesPageFacts } from '../../src/engine/page-facts';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Rule } from '../../src/core/lang/types';
import { programOf } from '../helpers/config';
import { createContentHandler } from '../../src/engine/messages';
import { GITHUB_PR_PAGE } from '../../src/core/adapters/github-pr-page';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const facts = (o: Partial<{ texts: string[]; extracts: Record<string, string>; formEdited: boolean }> = {}) =>
  ({ texts: [], extracts: {}, formEdited: false, ...o });

function memSession(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: vi.fn(async (k: string) => data[k]),
    set: vi.fn(async (k: string, v: unknown) => { data[k] = structuredClone(v); }),
  };
}

const rule = (id: string, match: Rule['match'], extra: Partial<Rule> = {}): Rule => ({
  id, name: id, enabled: true, match, actions: [{ close: {} }], ...extra,
});
const prog = (...rules: Rule[]) => programOf({ ...defaultConfig(), rules, order: rules.map((r) => `user/${r.id}`) });

describe('PageFacts store', () => {
  it('get/set/clear per tab', async () => {
    const pf = new PageFacts({ session: memSession() });
    await pf.ready;
    expect(pf.get(1)).toBeUndefined();
    pf.set(1, facts({ texts: ['x'] }));
    expect(pf.get(1)).toEqual(facts({ texts: ['x'] }));
    pf.clear(1);
    expect(pf.get(1)).toBeUndefined();
  });

  it('a navigation (onCommitted) clears the facts', async () => {
    const pf = new PageFacts({ session: memSession() });
    pf.set(4, facts({ formEdited: true }));
    pf.onCommitted(4);
    expect(pf.get(4)).toBeUndefined();
  });

  it('mirrors to storage.session and restores on a new worker', async () => {
    const session = memSession();
    const a = new PageFacts({ session });
    await a.ready;
    a.set(1, facts({ texts: ['hi'], formEdited: true }));
    a.set(2, facts());
    a.clear(2);
    await a.idle();
    expect(session.data[PAGE_FACTS_KEY]).toEqual([[1, facts({ texts: ['hi'], formEdited: true })]]);
    const b = new PageFacts({ session });
    await b.ready;
    expect(b.get(1)).toEqual(facts({ texts: ['hi'], formEdited: true }));
  });

  it('a set or clear before the stored mirror loads wins over the stored value', async () => {
    const session = memSession({ [PAGE_FACTS_KEY]: [[1, facts({ texts: ['old'] })], [2, facts({ texts: ['old'] })]] });
    const pf = new PageFacts({ session });
    pf.set(1, facts({ texts: ['new'] }));
    pf.clear(2);
    await pf.ready;
    expect(pf.get(1)).toEqual(facts({ texts: ['new'] }));
    expect(pf.get(2)).toBeUndefined();
  });

  it('ignores a malformed stored mirror', async () => {
    const pf = new PageFacts({ session: memSession({ [PAGE_FACTS_KEY]: [[1, { texts: 'nope' }], 'x'] }) });
    await pf.ready;
    expect(pf.get(1)).toBeUndefined();
  });
});

describe('PageFacts retired documents (a commit replaced them)', () => {
  it('a commit retires the previous document; a re-commit of it (bfcache) brings it back; clear() forgets the tab', () => {
    const pf = new PageFacts({ session: memSession() });
    pf.onCommitted(1, 'https://a.test/', 'doc-a');
    expect(pf.isRetiredDocument(1, 'doc-a')).toBe(false);
    pf.onCommitted(1, 'https://b.test/', 'doc-b');
    expect(pf.isRetiredDocument(1, 'doc-a')).toBe(true);
    expect(pf.isRetiredDocument(1, 'doc-b')).toBe(false);
    expect(pf.isRetiredDocument(2, 'doc-a')).toBe(false);
    expect(pf.isRetiredDocument(1, undefined)).toBe(false);
    pf.onCommitted(1, 'https://a.test/', 'doc-a'); // back/forward-cache restore of A
    expect(pf.isRetiredDocument(1, 'doc-a')).toBe(false);
    expect(pf.isRetiredDocument(1, 'doc-b')).toBe(true);
    pf.clear(1);
    expect(pf.isRetiredDocument(1, 'doc-b')).toBe(false);
  });

  it('keeps only the last few retired documents per tab', () => {
    const pf = new PageFacts({ session: memSession() });
    for (let i = 0; i < 7; i++) pf.onCommitted(1, undefined, `doc-${i}`);
    expect(pf.isRetiredDocument(1, 'doc-5')).toBe(true);
    expect(pf.isRetiredDocument(1, 'doc-2')).toBe(true);
    expect(pf.isRetiredDocument(1, 'doc-1')).toBe(false); // dropped from the cap of 4
  });
});

describe('PageFacts early reports (from a document not current yet)', () => {
  const report = (formEdited: boolean, texts: string[] = []) => ({ facts: facts({ texts, formEdited }), formEdited, url: 'https://a.test/' });

  it('a commit adopts its document\'s buffered report (facts set, hold ended, onAdopt told); others stay buffered', () => {
    const onAdopt = vi.fn();
    const pf = new PageFacts({ session: memSession(), onAdopt });
    pf.onCommitted(1, 'https://a.test/', 'doc-a');
    pf.buffer(1, 'doc-b', report(true, ['x']));
    expect(pf.get(1)).toBeUndefined();
    pf.onCommitted(1, 'https://a.test/', 'doc-b');
    expect(pf.get(1)).toEqual(facts({ texts: ['x'], formEdited: true }));
    expect(pf.awaiting(1)).toBe(false);
    expect(onAdopt).toHaveBeenCalledWith(1, report(true, ['x']));
    pf.onCommitted(1, 'https://a.test/', 'doc-c');
    expect(onAdopt).toHaveBeenCalledTimes(1); // adopted once, then gone
  });

  it('keeps the latest report of at most 2 documents per tab; tab removal drops them', () => {
    const onAdopt = vi.fn();
    const pf = new PageFacts({ session: memSession(), onAdopt });
    pf.buffer(1, 'doc-x', report(true));
    pf.buffer(1, 'doc-y', report(true));
    pf.buffer(1, 'doc-y', report(false, ['later'])); // the latest report of a document replaces its earlier one
    pf.buffer(1, 'doc-z', report(true));
    pf.onCommitted(1, undefined, 'doc-x');
    expect(onAdopt).not.toHaveBeenCalled(); // dropped by the cap
    pf.onCommitted(1, undefined, 'doc-y');
    expect(onAdopt).toHaveBeenLastCalledWith(1, report(false, ['later']));
    pf.buffer(2, 'doc-q', report(true));
    pf.clear(2);
    pf.onCommitted(2, undefined, 'doc-q');
    expect(onAdopt).toHaveBeenCalledTimes(1);
  });
});

describe('usesPageFacts (R44)', () => {
  it('true for a pageText condition (nested too) or a selector extract; false otherwise', () => {
    expect(usesPageFacts(rule('a', { pageText: 'x' }))).toBe(true);
    expect(usesPageFacts(rule('b', { all: [{ url: 'a.com/*' }, { not: { pageText: ['x'] } }] }))).toBe(true);
    expect(usesPageFacts(rule('c', { url: 'a.com/*' }, { extract: { v: { selector: 'h1' } } }))).toBe(true);
    expect(usesPageFacts(rule('d', { url: 'a.com/*' }, { extract: { v: { from: 'url', regex: '(x)' } } }))).toBe(false);
    expect(usesPageFacts(rule('e', { opener: { pageText: 'x' } }))).toBe(false); // an opener's page is never watched
    expect(usesPageFacts(rule('f', { url: 'a.com/*' }, { extract: { v: { adapter: 'github.prPage', field: 'state' } } }))).toBe(true);
  });
});

describe('PageFacts.awaiting (hold while the page facts are on their way)', () => {
  it('true only after a commit, until the facts arrive or PAGE_HOLD_MS pass; expiry asks for a reconcile once', async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const onHoldExpired = vi.fn();
      const pf = new PageFacts({ session: memSession(), now: () => t, onHoldExpired });
      expect(pf.awaiting(1)).toBe(false); // never committed while this worker ran
      pf.onCommitted(1);
      expect(pf.awaiting(1)).toBe(true);
      pf.set(1, facts());
      expect(pf.awaiting(1)).toBe(false);

      pf.onCommitted(2);
      expect(pf.awaiting(2)).toBe(true);
      expect(pf.awaiting(2)).toBe(true);
      t = PAGE_HOLD_MS;
      await vi.advanceTimersByTimeAsync(PAGE_HOLD_MS);
      expect(pf.awaiting(2)).toBe(false);
      expect(onHoldExpired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a commit arms the hold only where the watch is registered (covers); a hello always arms it', () => {
    const covered = new Set(['https://meet.google.com/x']);
    const pf = new PageFacts({ session: memSession(), now: () => 0, covers: (u) => covered.has(u) });
    pf.onCommitted(1, 'https://meet.google.com/x');
    expect(pf.awaiting(1)).toBe(true);
    pf.onCommitted(2, 'https://ungranted.example/'); // no scripting, an ungranted host or a non-http page
    expect(pf.awaiting(2)).toBe(false);
    pf.onCommitted(3, 'chrome://newtab/');
    expect(pf.awaiting(3)).toBe(false);
    pf.onCommitted(4); // watch.hello: the watch is evidently running there
    expect(pf.awaiting(4)).toBe(true);
  });

  it('a commit still clears the previous facts where no hold is armed', () => {
    const pf = new PageFacts({ session: memSession(), now: () => 0, covers: () => false });
    pf.set(5, facts({ texts: ['x'] }));
    pf.onCommitted(5, 'https://a.example/');
    expect(pf.get(5)).toBeUndefined();
    expect(pf.awaiting(5)).toBe(false);
  });

  it('a removed tab is no longer awaited', () => {
    const pf = new PageFacts({ session: memSession(), now: () => 0 });
    pf.onCommitted(3);
    pf.clear(3);
    expect(pf.awaiting(3)).toBe(false);
  });
});

describe('PageFacts.watchConfigFor', () => {
  const meet = rule('meet', { all: [{ url: 'meet.google.com/*' }, { pageText: ['You left the meeting', 'Call ended'] }] });
  const pr = rule('pr', { url: 'github.com/:o/:r/pull/*' }, {
    extract: { branch: { selector: '.head-ref' }, avatar: { selector: 'img.avatar', attr: 'alt' }, num: { from: 'url', regex: 'pull/(\\d+)' } },
  });
  const anywhere = rule('any', { pageText: 'Session expired' });
  const notGh = rule('ng', { all: [{ not: { url: 'github.com/*' } }, { pageText: 'nope' }] });
  const opener = rule('op', { all: [{ url: 'github.com/*' }, { opener: { pageText: 'never' } }] });
  const p = prog(meet, pr, anywhere, notGh, opener);
  const pf = new PageFacts({ session: memSession() });

  it('returns only the needles and selectors of rules whose URL condition matches this URL', () => {
    expect(pf.watchConfigFor('https://meet.google.com/abc-defg-hij', p)).toEqual({
      needles: ['You left the meeting', 'Call ended', 'Session expired', 'nope'], selectors: [],
    });
    expect(pf.watchConfigFor('https://github.com/acme/api/pull/7', p)).toEqual({
      needles: ['Session expired'],
      selectors: [{ key: 'user/pr.branch', selector: '.head-ref' }, { key: 'user/pr.avatar', selector: 'img.avatar', attr: 'alt' }],
    });
  });

  it('dedupes needles across rules', () => {
    const p2 = prog(rule('a', { pageText: 'x' }), rule('b', { any: [{ pageText: ['x', 'y'] }] }));
    expect(pf.watchConfigFor('https://e.com/', p2).needles).toEqual(['x', 'y']);
  });

  it('adds the adapter selectors of matching rules only where the adapter URL matches, once per field, best fallback last', () => {
    const a = rule('a', { url: 'github.com/*' }, { extract: { s: { adapter: 'github.prPage', field: 'state' }, b: { adapter: 'github.prPage', field: 'branch' } } });
    const b = rule('b', { url: '*' }, { extract: { st: { adapter: 'github.prPage', field: 'state' }, j: { adapter: 'jira.issuePage', field: 'status' } } });
    const p2 = prog(a, b);
    const key = (s: { key: string }) => s.key;
    const sel = (s: { selector: string; attr?: string }) => ({ selector: s.selector, ...(s.attr !== undefined && { attr: s.attr }) });
    const cfg = pf.watchConfigFor('https://github.com/acme/api/pull/7/files', p2);
    // The watch keeps the last value it finds per key, so the first-listed fallback goes last.
    expect(cfg.selectors.filter((s) => s.key === 'adapter:github.prPage.state').map(sel)).toEqual([...GITHUB_PR_PAGE.selectors.state].reverse());
    expect(cfg.selectors.filter((s) => s.key === 'adapter:github.prPage.branch').map(sel)).toEqual([...GITHUB_PR_PAGE.selectors.branch].reverse());
    expect(new Set(cfg.selectors.map(key))).toEqual(new Set(['adapter:github.prPage.state', 'adapter:github.prPage.branch']));
    expect(pf.watchConfigFor('https://github.com/acme/api/issues/7', p2).selectors).toEqual([]);
    expect(new Set(pf.watchConfigFor('https://acme.atlassian.net/browse/ABC-1', p2).selectors.map(key))).toEqual(new Set(['adapter:jira.issuePage.status']));
  });

  it('a discarded or frozen tab gets an empty config (Review Focus #4)', () => {
    const url = 'https://github.com/acme/api/pull/7';
    expect(pf.watchConfigFor(url, p, { discarded: false, frozen: false }).selectors.length).toBeGreaterThan(0);
    expect(pf.watchConfigFor(url, p, { discarded: true })).toEqual({ needles: [], selectors: [] });
    expect(pf.watchConfigFor(url, p, { frozen: true })).toEqual({ needles: [], selectors: [] });
  });

  it('a hello from a discarded or frozen tab is answered with an empty config and nothing is pushed to the tab', async () => {
    fakeBrowser.reset();
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage');
    const exec = vi.spyOn(fakeBrowser.scripting, 'executeScript');
    const pageFacts = new PageFacts({ session: memSession() });
    const h = createContentHandler({
      runtimeId: 'ext', extensionOrigin: 'chrome-extension://ext', getProgram: async () => p, pageFacts,
      safety: { markFormEdited: vi.fn(), clearFormEdited: vi.fn() }, schedule: vi.fn(),
    });
    const url = 'https://github.com/acme/api/pull/7';
    for (const t of [{ discarded: true }, { frozen: true }]) {
      const sender = { id: 'ext', url, frameId: 0, tab: { id: 7, url, ...t } };
      expect(await h({ type: 'watch.hello', formEdited: false }, sender)).toEqual({ type: 'watch.config', needles: [], selectors: [] });
    }
    expect(send).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
