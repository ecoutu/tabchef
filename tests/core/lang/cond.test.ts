import { describe, it, expect } from 'vitest';
import { evalCond, evalShow, usesAge } from '../../../src/core/lang/cond';
import type { Cond, Rule, TabFacts } from '../../../src/core/lang/types';
import type { TabSnap } from '../../../src/core/types';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const tab = (over: Partial<TabSnap> = {}): TabSnap => ({
  id: 1, windowId: 1, index: 0, url: 'https://github.com/acme/api/pull/7', title: 'Fix it by acme · Pull Request #7',
  pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...over,
});
const facts = (over: Partial<TabFacts> = {}, t: Partial<TabSnap> = {}): TabFacts => ({ tab: tab(t), ...over });
const ev = (c: Cond, f: TabFacts = facts(), now = NOW) => evalCond(c, f, now);
const T: Cond = { pinned: false };
const F: Cond = { pinned: true };
const P: Cond = { pageText: 'x' }; // needs the page when f.page is undefined

describe('evalCond: all / any / not truth tables', () => {
  it('all', () => {
    expect(ev({ all: [] }).ok).toBe(true);
    expect(ev({ all: [T] }).ok).toBe(true);
    expect(ev({ all: [T, T] }).ok).toBe(true);
    expect(ev({ all: [T, F] }).ok).toBe(false);
    expect(ev({ all: [F, T] }).ok).toBe(false);
    expect(ev({ all: [F, F] }).ok).toBe(false);
  });
  it('any', () => {
    expect(ev({ any: [] }).ok).toBe(false);
    expect(ev({ any: [T] }).ok).toBe(true);
    expect(ev({ any: [T, F] }).ok).toBe(true);
    expect(ev({ any: [F, T] }).ok).toBe(true);
    expect(ev({ any: [F, F] }).ok).toBe(false);
  });
  it('not', () => {
    expect(ev({ not: T }).ok).toBe(false);
    expect(ev({ not: F }).ok).toBe(true);
    expect(ev({ not: { not: T } }).ok).toBe(true);
  });
  it('needsPage propagates only when the page could change the result', () => {
    expect(ev({ all: [T, P] })).toEqual({ ok: false, captures: {}, needsPage: true });
    expect(ev({ all: [F, P] })).toEqual({ ok: false, captures: {}, needsPage: false });
    expect(ev({ all: [P, F] })).toEqual({ ok: false, captures: {}, needsPage: false });
    expect(ev({ any: [T, P] })).toEqual({ ok: true, captures: {}, needsPage: false });
    expect(ev({ any: [F, P] })).toEqual({ ok: false, captures: {}, needsPage: true });
    expect(ev({ not: P })).toEqual({ ok: false, captures: {}, needsPage: true });
  });
});

describe('evalCond: captures', () => {
  it('merges url captures across all', () => {
    expect(ev({ all: [{ url: 'github.com/:owner/:repo*' }, { title: '*Pull*' }] })).toEqual({ ok: true, captures: { owner: 'acme', repo: 'api' }, needsPage: false });
  });
  it('first match wins for any, and for url arrays', () => {
    const f = facts({}, { url: 'https://github.com/acme/api/issues/1' });
    expect(ev({ any: [{ url: 'github.com/:org/*' }, { url: 'github.com/:owner/:repo/*' }] }, f).captures).toEqual({ org: 'acme' });
    expect(ev({ url: ['gitlab.com/:x/*', 'github.com/:org/:repo/*', 'github.com/:owner/*'] }, f).captures).toEqual({ org: 'acme', repo: 'api' });
  });
  it('a false all or a not yields no captures', () => {
    expect(ev({ all: [{ url: 'github.com/:owner/*' }, F] }).captures).toEqual({});
    expect(ev({ not: { url: 'gitlab.com/:owner/*' } })).toEqual({ ok: true, captures: {}, needsPage: false });
  });
  it('title regex named groups capture', () => {
    expect(ev({ title: '/Pull Request #(?<num>\\d+)/' }).captures).toEqual({ num: '7' });
  });
});

describe('evalCond: leaf conditions', () => {
  it('url uses pendingUrl first; an array means any pattern', () => {
    expect(ev({ url: 'gitlab.com/*' }, facts({}, { pendingUrl: 'https://gitlab.com/x' })).ok).toBe(true);
    expect(ev({ url: 'github.com/*' }, facts({}, { pendingUrl: 'https://gitlab.com/x' })).ok).toBe(false);
    expect(ev({ url: ['gitlab.com/*', 'github.com/*'] }).ok).toBe(true);
    expect(ev({ url: [] }).ok).toBe(false);
  });
  it('url patterns that do not compile are false, not a throw', () => {
    expect(ev({ url: '/(/' }).ok).toBe(false);
    expect(ev({ url: 'a.com/(x)' }).ok).toBe(false);
  });
  it('urls longer than 2048 characters are truncated before matching', () => {
    const long = 'https://a.com/' + 'x'.repeat(3000);
    expect(ev({ url: '/^.{2048}$/s' }, facts({}, { url: long })).ok).toBe(true);
    expect(ev({ url: 'a.com/*y' }, facts({}, { url: long + 'y' })).ok).toBe(false);
  });
  it('title is a case-insensitive anchored glob or a regex', () => {
    expect(ev({ title: '*pull request*' }).ok).toBe(true);
    expect(ev({ title: 'Pull*' }).ok).toBe(false);
    expect(ev({ title: '/^fix/i' }).ok).toBe(true);
    expect(ev({ title: '/^fix/' }).ok).toBe(false);
  });
  it('opener evaluates against f.opener; false without one', () => {
    expect(ev({ opener: { url: 'github.com/*' } })).toEqual({ ok: false, captures: {}, needsPage: false });
    const opener = tab({ id: 2, url: 'https://jira.acme.dev/browse/ABC-1', title: 'ABC-1' });
    expect(ev({ opener: { url: 'jira.acme.dev/browse/:key' } }, facts({ opener })).captures).toEqual({ key: 'ABC-1' });
    expect(ev({ opener: { title: 'nope' } }, facts({ opener })).ok).toBe(false);
    expect(ev({ opener: { pageText: 'x' } }, facts({ opener })).needsPage).toBe(false);
  });
  it('group is an exact title match', () => {
    expect(ev({ group: 'Work' }, facts({ groupTitle: 'Work' })).ok).toBe(true);
    expect(ev({ group: 'Work' }, facts({ groupTitle: 'work' })).ok).toBe(false);
    expect(ev({ group: 'Work' }, facts()).ok).toBe(false);
  });
  it('pinned and audible', () => {
    expect(ev({ pinned: true }, facts({}, { pinned: true })).ok).toBe(true);
    expect(ev({ audible: true }).ok).toBe(false);
    expect(ev({ audible: false }).ok).toBe(true);
  });
  it('age: gt, lt, both on an exact creation time', () => {
    const at = (ago: number, exact = true) => facts({}, { created: { at: NOW - ago, exact } });
    expect(ev({ age: { gt: '10m' } }, at(11 * MIN)).ok).toBe(true);
    expect(ev({ age: { gt: '10m' } }, at(9 * MIN)).ok).toBe(false);
    expect(ev({ age: { lt: '10m' } }, at(9 * MIN)).ok).toBe(true);
    expect(ev({ age: { lt: '10m' } }, at(11 * MIN)).ok).toBe(false);
    expect(ev({ age: { gt: '5m', lt: '10m' } }, at(7 * MIN)).ok).toBe(true);
    expect(ev({ age: { gt: '5m', lt: '10m' } }, at(11 * MIN)).ok).toBe(false);
    expect(ev({ age: { gt: '5m', lt: '10m' } }, at(3 * MIN)).ok).toBe(false);
    expect(ev({ age: { gt: '10m' } }, at(9 * MIN)).unknown).toBeUndefined(); // exact: a definite false
    expect(ev({ age: { gt: 'soon' } }, facts({}, { created: { at: 0, exact: true } })).ok).toBe(false);
  });
  it('age: absent created is unknown (M3-R3)', () => {
    expect(ev({ age: { gt: '0s' } }, facts())).toEqual({ ok: false, captures: {}, needsPage: false, unknown: true });
  });
  it('age: a lower-bound creation time makes gt true or unknown, and lt false or unknown (M3-R3)', () => {
    const lb = (ago: number) => facts({}, { created: { at: NOW - ago, exact: false } });
    const U = { ok: false, captures: {}, needsPage: false, unknown: true };
    const NO = { ok: false, captures: {}, needsPage: false };
    expect(ev({ age: { gt: '10m' } }, lb(11 * MIN))).toEqual({ ok: true, captures: {}, needsPage: false });
    expect(ev({ age: { gt: '10m' } }, lb(10 * MIN))).toEqual(U);
    expect(ev({ age: { gt: '10m' } }, lb(9 * MIN))).toEqual(U);
    expect(ev({ age: { lt: '10m' } }, lb(10 * MIN))).toEqual(NO);
    expect(ev({ age: { lt: '10m' } }, lb(11 * MIN))).toEqual(NO);
    expect(ev({ age: { lt: '10m' } }, lb(9 * MIN))).toEqual(U);
    expect(ev({ age: { gt: '5m', lt: '10m' } }, lb(7 * MIN))).toEqual(U); // gt true, lt unknown
    expect(ev({ age: { gt: '5m', lt: '10m' } }, lb(11 * MIN))).toEqual(NO); // lt definitely false
    expect(ev({ age: { gt: '5m', lt: '10m' } }, lb(3 * MIN))).toEqual(U);
  });
  describe('age under not / any / all (three-valued, M3-R3)', () => {
    const A: Cond = { age: { lt: '1h' } };
    const G: Cond = { age: { gt: '1h' } };
    const cases: [string, TabFacts][] = [
      ['absent', facts()],
      ['a lower bound below the threshold', facts({}, { created: { at: NOW - 30 * MIN, exact: false } })],
    ];
    it.each(cases)('unknown (%s) never matches, including under not', (_label, f) => {
      for (const c of [A, G]) {
        expect(ev(c, f).ok).toBe(false);
        expect(ev({ not: c }, f).ok).toBe(false);
        expect(ev({ not: { not: c } }, f).ok).toBe(false);
        expect(ev({ all: [{ url: 'github.com/*' }, { not: c }] }, f).ok).toBe(false);
        expect(ev({ not: { any: [F, c] } }, f).ok).toBe(false);
        expect(ev({ not: { all: [T, c] } }, f).ok).toBe(false);
        expect(ev({ any: [T, c] }, f).ok).toBe(true); // a definite true still wins
        expect(ev({ not: { all: [F, c] } }, f).ok).toBe(true); // a definite false still decides
      }
    });
    it('a lower bound past the threshold decides: gt true, lt false, and not negates them', () => {
      const f = facts({}, { created: { at: NOW - 2 * 60 * MIN, exact: false } });
      expect(ev(G, f).ok).toBe(true);
      expect(ev({ not: G }, f).ok).toBe(false);
      expect(ev({ not: A }, f).ok).toBe(true);
      expect(ev({ any: [F, G] }, f).ok).toBe(true);
      expect(ev({ all: [T, { not: A }] }, f).ok).toBe(true);
    });
    it('an exact time is plain two-valued logic', () => {
      const young = facts({}, { created: { at: NOW - 30 * MIN, exact: true } });
      expect(ev({ not: A }, young).ok).toBe(false);
      expect(ev({ not: G }, young).ok).toBe(true);
      expect(ev({ all: [T, { not: G }] }, young).ok).toBe(true);
      expect(ev({ any: [F, A] }, young).ok).toBe(true);
    });
    it('the opener age is known from the opener snapshot', () => {
      const opener = tab({ id: 2, created: { at: NOW - 2 * 60 * MIN, exact: true } });
      expect(ev({ opener: G }, facts({ opener })).ok).toBe(true);
      expect(ev({ opener: A }, facts({ opener })).ok).toBe(false);
      expect(ev({ not: { opener: A } }, facts({ opener })).ok).toBe(true);
      expect(ev({ not: { opener: A } }, facts({ opener: tab({ id: 2 }) })).ok).toBe(false); // opener age unknown
    });
  });
  it('pageText: needs the page when absent; case-insensitive substring; any needle, any text', () => {
    expect(ev({ pageText: 'you left the meeting' })).toEqual({ ok: false, captures: {}, needsPage: true });
    const page = { texts: ['Header', 'You left the meeting'], extracts: {}, formEdited: false };
    expect(ev({ pageText: 'you left the meeting' }, facts({ page }))).toEqual({ ok: true, captures: {}, needsPage: false });
    expect(ev({ pageText: ['nope', 'LEFT THE'] }, facts({ page })).ok).toBe(true);
    expect(ev({ pageText: ['nope', 'zzz'] }, facts({ page }))).toEqual({ ok: false, captures: {}, needsPage: false });
  });
  it('pageText: folds typographic quotes on both needle and text (R65)', () => {
    const curly = { texts: ['You’ve left the “call”'], extracts: {}, formEdited: false };
    expect(ev({ pageText: "you've left the \"call\"" }, facts({ page: curly })).ok).toBe(true);
    const straight = { texts: ["You've left the call"], extracts: {}, formEdited: false };
    expect(ev({ pageText: 'you‘ve left the call' }, facts({ page: straight })).ok).toBe(true);
  });
  it('unknown or malformed conditions are false and never throw', () => {
    expect(ev({ bogus: 1 } as unknown as Cond)).toEqual({ ok: false, captures: {}, needsPage: false });
    expect(ev({} as unknown as Cond).ok).toBe(false);
    expect(ev(null as unknown as Cond).ok).toBe(false);
    expect(ev({ all: 'x' } as unknown as Cond).ok).toBe(false);
    expect(ev({ url: 1 } as unknown as Cond).ok).toBe(false);
  });
});

describe('evalShow (view `show`, M2 T17)', () => {
  const fields: Record<string, unknown> = { 'tab.url': 'http://localhost:3000/cb', 'tab.id': 7, 'extract.repo': 'api' };
  const f = (n: string) => fields[n];
  it('comparisons', () => {
    expect(evalShow({ field: 'tab.url', op: 'matches', value: 'localhost' }, f)).toBe(true);
    expect(evalShow({ field: 'tab.url', op: 'matches', value: '^https://' }, f)).toBe(false);
    expect(evalShow({ field: 'extract.repo', op: '==', value: 'api' }, f)).toBe(true);
    expect(evalShow({ field: 'extract.repo', op: '!=', value: 'api' }, f)).toBe(false);
    expect(evalShow({ field: 'tab.id', op: '<', value: 8 }, f)).toBe(true);
    expect(evalShow({ field: 'tab.id', op: '>', value: 8 }, f)).toBe(false);
    expect(evalShow({ field: 'tab.id', op: '>', value: '8' }, f)).toBe(false); // mixed types never compare
    expect(evalShow({ field: 'extract.repo', op: 'in', value: ['web', 'api'] }, f)).toBe(true);
    expect(evalShow({ field: 'extract.none', op: '==', value: 'api' }, f)).toBe(false);
  });
  it('all / any / not', () => {
    const T = { field: 'tab.id', op: '==', value: 7 } as const;
    const F = { field: 'tab.id', op: '==', value: 8 } as const;
    expect(evalShow({ all: [T, F] }, f)).toBe(false);
    expect(evalShow({ any: [T, F] }, f)).toBe(true);
    expect(evalShow({ not: F }, f)).toBe(true);
  });
  it('malformed input is false, never a throw', () => {
    expect(evalShow({ field: 'tab.url', op: 'matches', value: '(' }, f)).toBe(false);
    expect(evalShow(null as never, f)).toBe(false);
    expect(evalShow({ field: 'tab.url', op: 'eq', value: 1 } as never, f)).toBe(false);
  });
});

describe('usesAge (M3-R5: gates the age.tick alarm)', () => {
  const rule = (match: Cond): Rule => ({ id: 'r', name: 'r', enabled: true, match, actions: [{ close: {} }] });
  it('true for an age condition anywhere in the tree, including under opener', () => {
    expect(usesAge(rule({ age: { gt: '1h' } }))).toBe(true);
    expect(usesAge(rule({ all: [{ url: 'a.com/*' }, { not: { age: { lt: '1h' } } }] }))).toBe(true);
    expect(usesAge(rule({ any: [{ pinned: true }, { all: [{ age: { gt: '1d' } }] }] }))).toBe(true);
    expect(usesAge(rule({ opener: { not: { age: { gt: '1m' } } } }))).toBe(true);
  });
  it('false without one', () => {
    expect(usesAge(rule({ url: 'a.com/*' }))).toBe(false);
    expect(usesAge(rule({ all: [{ title: 'age' }, { not: { pageText: 'age' } }, { opener: { group: 'G' } }] }))).toBe(false);
    expect(usesAge(rule({ any: [] }))).toBe(false);
  });
});
