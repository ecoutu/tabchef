// Preview before apply (M2 T13): previewChange diffs what the engine would do under two Programs. Rulings R27, R30.
import { describe, expect, it } from 'vitest';
import { emptyProgram, hasEffects, previewChange, previewCounts, previewText, type PreviewContext } from '../../../src/core/lang/preview';
import { defaultConfig } from '../../../src/core/config/defaults';
import { builtinRecipeRefs } from '../../../src/core/config/defaults';
import type { Config, GroupSnap, Snapshot, TabSnap } from '../../../src/core/types';
import type { Action, GroupAction, Program, Rule, TabFacts } from '../../../src/core/lang/types';
import { programOf } from '../../helpers/config';

const tab = (id: number, url: string, o: Partial<TabSnap> = {}): TabSnap => ({
  id, windowId: 1, index: id, url, title: `t${id}`, pinned: false, groupId: -1, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});
const grp = (id: number, title: string, o: Partial<GroupSnap> = {}): GroupSnap => ({ id, windowId: 1, title, color: 'blue', collapsed: false, ...o });
const snapOf = (tabs: TabSnap[], groups: GroupSnap[] = []): Snapshot => ({ tabs, groups, windows: [{ id: 1, type: 'normal', focused: true }] });
const group = (title: string, o: Partial<GroupAction> = {}): Action => ({ group: { title, color: 'blue', ...o } });
const rule = (id: string, url: string, actions: Action[], o: Partial<Rule> = {}): Rule => ({ id, name: id.toUpperCase(), enabled: true, match: { url }, actions, ...o });
/** Only the given user rules: no built-in recipes (they would add their own rules). */
const cfgOf = (rules: Rule[], o: Partial<Config> = {}): Config => ({
  ...defaultConfig(), recipes: builtinRecipeRefs({ duplicates: false, 'github-prs': false }), rules, order: rules.map((r) => `user/${r.id}`), ...o,
});
const prog = (rules: Rule[], o: Partial<Config> = {}): Program => programOf(cfgOf(rules, o));
const noFacts = (): Partial<TabFacts> => ({});
const ctx = (o: Partial<PreviewContext> = {}): PreviewContext => ({ leaveAlone: new Set(), managedTitles: new Set(), creationOrder: new Map(), ...o });

const EX = rule('ex', 'example.com/*', [group('ex')]);

describe('previewChange', () => {
  it('adding a rule example.com/* lists the 2 example.com tabs moving to "ex"', () => {
    const snap = snapOf([tab(1, 'https://example.com/a'), tab(2, 'https://other.org/'), tab(3, 'https://example.com/b')]);
    const r = previewChange(snap, prog([]), prog([EX]), noFacts, ctx());
    expect(r.moves.map((m) => ({ tabId: m.tabId, title: m.title, from: m.from, to: m.to }))).toEqual([
      { tabId: 1, title: 't1', from: undefined, to: 'ex' },
      { tabId: 3, title: 't3', from: undefined, to: 'ex' },
    ]);
    expect(r.closes).toEqual([]);
    expect(r.groupsCreated).toEqual(['ex']);
    expect(r.unchanged).toBe(1);
    expect(previewText(r)).toBe('2 tabs would move, 0 would close.');
    expect(hasEffects(r)).toBe(true);
  });

  it('enabling `finished` with a localhost callback tab open closes it after 3000 ms', () => {
    const snap = snapOf([tab(1, 'http://localhost:8080/auth/callback?code=x', { title: 'Callback' }), tab(2, 'https://example.com/')]);
    const off = defaultConfig();
    const on: Config = { ...off, recipes: off.recipes.map((x) => (x.id === 'finished' ? { ...x, enabled: true } : x)) };
    const r = previewChange(snap, programOf(off), programOf(on), noFacts, ctx());
    expect(r.closes).toEqual([{ tabId: 1, title: 'Callback', ruleKey: 'finished/oauth-callback', afterMs: 3000 }]);
    expect(r.moves).toEqual([]);
    expect(previewText(r)).toBe('0 tabs would move, 1 would close.');
  });

  it('a tab that already closes under `before` is not listed again', () => {
    const snap = snapOf([tab(1, 'http://localhost:8080/auth/callback')]);
    const on: Config = { ...defaultConfig(), recipes: builtinRecipeRefs({ finished: true }) };
    const r = previewChange(snap, programOf(on), programOf(on), noFacts, ctx());
    expect(r.closes).toEqual([]);
  });

  it('suggest-mode closes are not closes', () => {
    const snap = snapOf([tab(1, 'http://localhost:8080/auth/callback')]);
    const on: Config = { ...defaultConfig(), recipes: builtinRecipeRefs({ finished: true }).map((x) => (x.id === 'finished' ? { ...x, params: { mode: 'suggest' } } : x)) };
    const r = previewChange(snap, programOf(defaultConfig()), programOf(on), noFacts, ctx());
    expect(r.closes).toEqual([]);
  });

  it('a no-op change: no moves, no closes, no effects', () => {
    const snap = snapOf([tab(1, 'https://example.com/a', { groupId: 10 }), tab(2, 'https://other.org/')], [grp(10, 'ex')]);
    const p = prog([EX]);
    const r = previewChange(snap, p, prog([{ ...EX, name: 'renamed' }]), noFacts, ctx({ managedTitles: new Set(['ex']) }));
    expect(r.moves).toEqual([]);
    expect(r.closes).toEqual([]);
    expect(r.anchorsOpened).toBe(0);
    expect(r.unchanged).toBe(2);
    expect(hasEffects(r)).toBe(false);
  });

  it('removing a strict rule ungroups its tabs (from "ex", to nowhere)', () => {
    const snap = snapOf([tab(1, 'https://example.com/a', { groupId: 10 })], [grp(10, 'ex')]);
    const r = previewChange(snap, prog([EX]), prog([]), noFacts, ctx({ managedTitles: new Set(['ex']) }));
    expect(r.moves).toEqual([expect.objectContaining({ tabId: 1, from: 'ex', to: undefined })]);
  });

  it('respects leaveAlone from the plan context (a tab the user dragged out stays put)', () => {
    const snap = snapOf([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/b')]);
    const r = previewChange(snap, prog([]), prog([EX]), noFacts, ctx({ leaveAlone: new Set([2]) }));
    expect(r.moves.map((m) => m.tabId)).toEqual([1]);
  });

  it('does not mutate the snapshot or the plan context (pure)', () => {
    const snap = snapOf([tab(1, 'https://example.com/a')]);
    const c = ctx();
    const before = structuredClone(snap);
    previewChange(snap, prog([]), prog([EX]), noFacts, c);
    expect(snap).toEqual(before);
    expect(c.managedTitles.size).toBe(0);
    expect(c.creationOrder.size).toBe(0);
  });

  it('page facts reach the planner and close evaluation', () => {
    const pageRule = rule('meet', 'meet.example/*', [{ close: { after: '2s' } }], { match: { all: [{ url: 'meet.example/*' }, { pageText: 'ended' }] } });
    const snap = snapOf([tab(1, 'https://meet.example/x'), tab(2, 'https://meet.example/y')]);
    const facts = (id: number): Partial<TabFacts> => (id === 1 ? { page: { texts: ['ended'], extracts: {}, formEdited: false } } : {});
    const r = previewChange(snap, prog([]), prog([pageRule]), facts, ctx());
    expect(r.closes.map((c) => c.tabId)).toEqual([1]);
  });
});

describe('previewChange: anchors (T11)', () => {
  const ANCH = rule('ex', 'example.com/*', [group('ex', { anchors: ['https://example.com/home', 'https://example.com/docs'] })]);

  it('counts anchor tabs a newly created group would open (an open tab at the URL is reused, not opened)', () => {
    const snap = snapOf([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/docs')]);
    const r = previewChange(snap, prog([]), prog([ANCH]), noFacts, ctx());
    expect(r.anchorsOpened).toBe(1);
    expect(hasEffects(r)).toBe(true);
  });

  it('opens none for a group whose anchors were dismissed, or an adopted (existing) group', () => {
    const snap = snapOf([tab(1, 'https://example.com/a')]);
    expect(previewChange(snap, prog([]), prog([ANCH]), noFacts, ctx({ anchorsDismissed: new Set(['1|ex']) })).anchorsOpened).toBe(0);
    const adopted = snapOf([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/b', { groupId: 10 })], [grp(10, 'ex')]);
    expect(previewChange(adopted, prog([]), prog([ANCH]), noFacts, ctx()).anchorsOpened).toBe(0);
  });

  it('only non-http(s) anchors: none open', () => {
    const r = previewChange(snapOf([tab(1, 'https://example.com/a')]), prog([]),
      prog([rule('ex', 'example.com/*', [group('ex', { anchors: ['chrome://newtab/'] })])]), noFacts, ctx());
    expect(r.anchorsOpened).toBe(0);
  });
});

describe('previewChange: dry run (R30, R48)', () => {
  const snap = () => snapOf([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/b'), tab(3, 'http://localhost:1/x/callback')]);

  it('a new dry-run rule is listed labelled, excluded from the counts', () => {
    const r = previewChange(snap(), prog([]), prog([{ ...EX, dryRun: true }]), noFacts, ctx());
    expect(r.moves.map((m) => [m.tabId, m.to, m.dryRun])).toEqual([[1, 'ex', true], [2, 'ex', true]]);
    expect(r.moves[0]!.ruleKey).toBe('user/ex');
    expect(previewCounts(r)).toEqual({ moves: 0, closes: 0 });
    expect(previewText(r)).toBe('0 tabs would move, 0 would close.');
    expect(r.groupsCreated).toEqual([]);
    expect(hasEffects(r)).toBe(true); // shown, so the user sees what the dry-run rule would do
  });

  it('a dry-run close is labelled, not counted', () => {
    const cl = rule('cb', '*/x/callback', [{ close: { after: '1s' } }], { dryRun: true });
    const r = previewChange(snap(), prog([]), prog([cl]), noFacts, ctx());
    expect(r.closes).toEqual([{ tabId: 3, title: 't3', ruleKey: 'user/cb', afterMs: 1000, dryRun: true }]);
    expect(previewCounts(r).closes).toBe(0);
  });

  it('dry-run falls through: a lower live rule really moves the tab, the dry-run rule is labelled', () => {
    const live = rule('all', 'example.com/*', [group('all')]);
    const r = previewChange(snap(), prog([]), prog([{ ...EX, dryRun: true }, live]), noFacts, ctx());
    const real = r.moves.filter((m) => !m.dryRun);
    expect(real.map((m) => [m.tabId, m.to])).toEqual([[1, 'all'], [2, 'all']]);
    expect(r.moves.filter((m) => m.dryRun).map((m) => [m.tabId, m.from, m.to])).toEqual([[1, 'all', 'ex'], [2, 'all', 'ex']]);
    expect(previewCounts(r).moves).toBe(2);
  });

  it('switching a dry-run rule to live shows its real moves', () => {
    const r = previewChange(snap(), prog([{ ...EX, dryRun: true }]), prog([EX]), noFacts, ctx());
    expect(r.moves.map((m) => [m.tabId, m.to, m.dryRun])).toEqual([[1, 'ex', undefined], [2, 'ex', undefined]]);
    expect(previewCounts(r).moves).toBe(2);
  });

  it('an unchanged dry-run rule is not re-listed on an unrelated change', () => {
    const r = previewChange(snap(), prog([{ ...EX, dryRun: true }]), prog([{ ...EX, dryRun: true, name: 'x' }]), noFacts, ctx());
    expect(r.moves).toEqual([]);
    expect(hasEffects(r)).toBe(false);
  });

  it('switching a live rule to dry-run leaves its existing group alone (R49): no real move', () => {
    const s = snapOf([tab(1, 'https://example.com/a', { groupId: 10 })], [grp(10, 'ex')]);
    const r = previewChange(s, prog([EX]), prog([{ ...EX, dryRun: true }]), noFacts, ctx({ managedTitles: new Set(['ex']) }));
    expect(previewCounts(r).moves).toBe(0);
  });

  it('global dry run in `after`: nothing really moves or closes; would-moves are labelled; result.dryRun is set', () => {
    const cl = rule('cb', '*/x/callback', [{ close: { after: '1s' } }]);
    const r = previewChange(snap(), prog([]), prog([EX, cl], { dryRun: true }), noFacts, ctx());
    expect(r.dryRun).toBe(true);
    expect(previewCounts(r)).toEqual({ moves: 0, closes: 0 });
    expect(r.moves.every((m) => m.dryRun)).toBe(true);
    expect(r.moves).toHaveLength(2);
    expect(r.closes).toEqual([expect.objectContaining({ tabId: 3, dryRun: true })]);
    expect(r.anchorsOpened).toBe(0);
  });

  it('turning global dry run off shows the real moves', () => {
    const r = previewChange(snap(), prog([EX], { dryRun: true }), prog([EX]), noFacts, ctx());
    expect(r.dryRun).toBe(false);
    expect(previewCounts(r).moves).toBe(2);
  });
});

describe('emptyProgram ("test against my open tabs")', () => {
  it('previewChange(snap, emptyProgram, only this rule) shows what the rule alone does', () => {
    const snap = snapOf([tab(1, 'https://example.com/a'), tab(2, 'https://other.org/')]);
    const p = prog([EX]);
    const r = previewChange(snap, emptyProgram(p), p, noFacts, ctx());
    expect(previewCounts(r)).toEqual({ moves: 1, closes: 0 });
    expect(emptyProgram(p).rules).toEqual([]);
  });
});
