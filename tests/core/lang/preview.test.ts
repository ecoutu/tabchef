// Preview before apply (M2 T13): previewChange diffs what the engine would do under two Programs. Rulings R27, R30.
import { describe, expect, it } from 'vitest';
import { hasEffects, previewChange, previewCounts, previewRule, previewText, type PreviewContext } from '../../../src/core/lang/preview';
import { defaultConfig } from '../../../src/core/config/defaults';
import { builtinRecipeRefs } from '../../../src/core/config/defaults';
import type { Config, GroupSnap, Snapshot, TabSnap } from '../../../src/core/types';
import type { Action, GroupAction, Program, Rule, TabFacts } from '../../../src/core/lang/types';
import { programOf } from '../../helpers/config';
import { customizeRule, setRecipeRuleOn } from '../../../src/ui/rules-model';

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
    expect(hasEffects(r)).toBe(false); // R52: dry-run entries alone do not open the dialog
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

describe('previewChange: rules sharing a group title', () => {
  const A = rule('a', 'a.com/*', [group('Work')]);

  it('each move names the rule that matched the tab', () => {
    const B = rule('b', 'b.com/*', [group('Work')]);
    const s = snapOf([tab(1, 'https://a.com/x'), tab(2, 'https://b.com/x'), tab(3, 'https://b.com/y')]);
    const r = previewChange(s, prog([]), prog([A, B]), noFacts, ctx());
    expect(r.moves.map((m) => [m.tabId, m.ruleKey])).toEqual([[1, 'user/a'], [2, 'user/b'], [3, 'user/b']]);
    expect(previewCounts(r).moves).toBe(3);
    // Across windows: one moveTabs op takes window 2's tabs into window 1's group (merge).
    const m = (id: string, url: string) => rule(id, url, [group('Work', { merge: true })]);
    const w = snapOf([tab(1, 'https://a.com/x', { groupId: 9 }), tab(4, 'https://a.com/y', { windowId: 2 }), tab(2, 'https://b.com/x', { windowId: 2 })], [grp(9, 'Work')]);
    w.windows.push({ id: 2, type: 'normal', focused: false });
    const r2 = previewChange(w, prog([]), prog([m('a', 'a.com/*'), m('b', 'b.com/*')]), noFacts, ctx({ managedTitles: new Set(['Work']) }));
    expect(r2.moves.filter((x) => x.tabId !== 1).map((x) => [x.tabId, x.ruleKey])).toEqual([[4, 'user/a'], [2, 'user/b']]);
  });

  it('a dry-run rule\'s would-move into the group a live rule holds is listed (R30)', () => {
    const D = rule('d', 'd.com/*', [group('Work')], { dryRun: true });
    const s = snapOf([tab(1, 'https://a.com/x', { groupId: 9 }), tab(2, 'https://d.com/x')], [grp(9, 'Work')]);
    const r = previewChange(s, prog([A]), prog([A, D]), noFacts, ctx({ managedTitles: new Set(['Work']) }));
    expect(r.moves).toEqual([{ tabId: 2, title: 't2', from: undefined, to: 'Work', ruleKey: 'user/d', dryRun: true }]);
    expect(previewCounts(r).moves).toBe(0);
  });
});

describe('previewRule ("test against my open tabs")', () => {
  const CL = rule('cl', 'example.com/*', [{ close: { after: '7d' } }]);
  const snap = () => snapOf([tab(1, 'https://example.com/a'), tab(2, 'https://other.org/')]);

  it('moves: the rule\'s share of the change; the other rules\' moves are left out', () => {
    const OT = rule('ot', 'other.org/*', [group('ot')]);
    const r = previewRule(snap(), prog([]), prog([EX, OT]), 'user/ex', noFacts, ctx());
    expect(r.moves.map((m) => [m.tabId, m.to])).toEqual([[1, 'ex']]);
    expect(r).toMatchObject({ groupsCreated: ['ex'], unchanged: 1, dryRun: false });
  });

  it('closes: what the rule would close, even when `before` already runs it', () => {
    expect(previewRule(snap(), prog([]), prog([CL]), 'user/cl', noFacts, ctx()).closes.map((c) => c.tabId)).toEqual([1]);
    expect(previewRule(snap(), prog([CL]), prog([CL]), 'user/cl', noFacts, ctx()).closes.map((c) => c.tabId)).toEqual([1]);
    expect(previewChange(snap(), prog([CL]), prog([CL]), noFacts, ctx()).closes).toEqual([]);
  });

  it('rules sharing a group title: each rule gets the tabs it matches, not the higher-ranked one', () => {
    const A = rule('a', 'a.com/*', [group('Work')]);
    const B = rule('b', 'b.com/*', [group('Work')]);
    const s = snapOf([tab(1, 'https://a.com/x'), tab(2, 'https://b.com/x'), tab(3, 'https://b.com/y')]);
    const ids = (key: string) => previewRule(s, prog([]), prog([A, B]), key, noFacts, ctx()).moves.map((m) => m.tabId);
    expect(ids('user/a')).toEqual([1]);
    expect(ids('user/b')).toEqual([2, 3]);
    // Across windows (moveTabs into the existing group), too.
    const w = snapOf([tab(1, 'https://a.com/x', { groupId: 9 }), tab(4, 'https://a.com/y', { windowId: 2 }), tab(2, 'https://b.com/x', { windowId: 2 })], [grp(9, 'Work')]);
    w.windows.push({ id: 2, type: 'normal', focused: false });
    const merged = (key: string) => previewRule(w, prog([]), prog([{ ...A, actions: [group('Work', { merge: true })] }, { ...B, actions: [group('Work', { merge: true })] }]), key, noFacts, ctx({ managedTitles: new Set(['Work']) })).moves.map((m) => m.tabId);
    expect(merged('user/b')).toEqual([2]);
    expect(merged('user/a')).toEqual([4]);
  });

  it('a customized copy above its recipe rule: each gets the tabs it matches', () => {
    const KEY = 'github-prs/group-by-repo';
    const base = customizeRule(setRecipeRuleOn(cfgOf([], { recipes: builtinRecipeRefs({ duplicates: false }) }), KEY, true), KEY);
    const copy = base.rules[0]!;
    const c: Config = { ...base, rules: [{ ...copy, match: { url: 'github.com/:owner/:repo/pull/*' } }] };
    const s = snapOf([tab(1, 'https://github.com/acme/api/pull/1'), tab(2, 'https://github.com/acme/api/issues/2')]);
    const ids = (key: string) => previewRule(s, prog([]), programOf(c), key, noFacts, ctx()).moves.map((m) => [m.tabId, m.to]);
    expect(ids(`user/${copy.id}`)).toEqual([[1, 'api']]);
    expect(ids(KEY)).toEqual([[2, 'api']]);
  });

  it('closes: a rule above that closes the tab first takes it', () => {
    const above = rule('above', 'example.com/*', [{ close: { after: '1d' } }]);
    expect(previewRule(snap(), prog([]), prog([above, CL]), 'user/cl', noFacts, ctx()).closes).toEqual([]);
  });
});
