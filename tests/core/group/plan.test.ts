import { describe, expect, it } from 'vitest';
import { managedGroupIds, planGroups, syncCreationOrder, type PlanContext } from '../../../src/core/group/plan';
import { FakeBrowserPort } from '../../../src/platform/fake-port';
import type { Config, GroupColor, GroupRule, Op, Snapshot, TabSnap } from '../../../src/core/types';
import { withGroupRules } from '../../helpers/config';

type NewTab = Omit<TabSnap, 'index' | 'groupId'> & Partial<Pick<TabSnap, 'index' | 'groupId'>>;

const A = 'https://a.com/x';
const B = 'https://b.com/x';
const C = 'https://c.com/x';
const OTHER = 'https://other.com/';

const rule = (id: string, url: string, title: string, o: Partial<GroupRule> = {}, color: GroupColor = 'blue'): GroupRule => ({
  id, name: id, enabled: true, match: { url }, group: { title, color }, ...o,
});
const cfg = (...groupRules: GroupRule[]): Config => (withGroupRules(groupRules));
const ctx = (o: Partial<PlanContext> = {}): PlanContext => ({
  leaveAlone: new Set(), managedTitles: new Set(), creationOrder: new Map(), ...o,
});

function world(windows: number[] = [1]): FakeBrowserPort {
  const f = new FakeBrowserPort();
  for (const w of windows) f.addWindow(w);
  return f;
}
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, incognito: false, discarded: false,
  active: false, audible: false, ...o,
});
const snap = (f: FakeBrowserPort): Snapshot => structuredClone(f.state);
const order = (f: FakeBrowserPort, w = 1): number[] => {
  f.assertInvariants();
  return f.state.tabs.filter((t) => t.windowId === w).sort((a, b) => a.index - b.index).map((t) => t.id);
};
const groupOrder = (f: FakeBrowserPort, w = 1): string[] => {
  const ids: number[] = [];
  for (const t of f.state.tabs.filter((x) => x.windowId === w).sort((a, b) => a.index - b.index)) {
    if (t.groupId !== -1 && ids[ids.length - 1] !== t.groupId) ids.push(t.groupId);
  }
  return ids.map((id) => f.state.groups.find((g) => g.id === id)?.title ?? '?');
};
const touched = (ops: Op[]): number[] =>
  ops.flatMap((o) => ('tabIds' in o ? o.tabIds : 'tabId' in o ? [o.tabId] : []));

/** Applies ops the way the reconciler will (moveTabs then regroup; new groups get title/color/collapsed). */
async function apply(f: FakeBrowserPort, ops: Op[]): Promise<void> {
  for (const op of ops) {
    switch (op.kind) {
      case 'group': {
        if (op.existingGroupId !== undefined) {
          await f.group(op.tabIds, { groupId: op.existingGroupId, windowId: op.windowId });
        } else {
          const gid = await f.group(op.tabIds, { windowId: op.windowId });
          await f.updateGroup(gid, { title: op.title, color: op.color, collapsed: op.collapsed ?? false });
        }
        break;
      }
      case 'ungroup': await f.ungroup(op.tabIds); break;
      case 'moveTabs':
        await f.moveTabs(op.tabIds, op.windowId, -1);
        await f.group(op.tabIds, { groupId: op.groupId, windowId: op.windowId });
        break;
      case 'moveGroup': await f.moveGroup(op.groupId, op.index); break;
      case 'updateGroup': {
        const p: { color?: GroupColor; collapsed?: boolean } = {};
        if (op.color !== undefined) p.color = op.color;
        if (op.collapsed !== undefined) p.collapsed = op.collapsed;
        await f.updateGroup(op.groupId, p);
        break;
      }
      default: throw new Error(`unexpected op ${op.kind}`);
    }
    f.assertInvariants();
  }
}
/** Plan/apply until no ops; returns each pass's ops (the final pass is always []). */
async function converge(f: FakeBrowserPort, config: Config, c: PlanContext = ctx()): Promise<Op[][]> {
  const passes: Op[][] = [];
  for (let i = 0; i < 4; i++) {
    const ops = planGroups(snap(f), config, c);
    passes.push(ops);
    if (ops.length === 0) return passes;
    await apply(f, ops);
  }
  throw new Error(`did not converge: ${JSON.stringify(passes)}`);
}

const AB = cfg(rule('a', 'a.com/*', 'A'), rule('b', 'b.com/*', 'B', {}, 'red'));

describe('planGroups: config order', () => {
  it('tabs opened B then A: group ops are emitted A before B', () => {
    const f = world();
    f.addTab(tab(1, B));
    f.addTab(tab(2, A));
    expect(planGroups(snap(f), AB, ctx())).toEqual([
      { kind: 'group', tabIds: [2], windowId: 1, title: 'A', color: 'blue', collapsed: false, ruleId: 'user/a' },
      { kind: 'group', tabIds: [1], windowId: 1, title: 'B', color: 'red', collapsed: false, ruleId: 'user/b' },
    ]);
  });

  it('multi-pass: pass 1 creates groups only, pass 2 only moves, pass 3 is [] and order matches config', async () => {
    const f = world();
    f.addTab(tab(1, B));
    f.addTab(tab(2, A));
    const passes = await converge(f, AB);
    expect(passes).toHaveLength(3);
    expect(passes[0]!.every((o) => o.kind === 'group')).toBe(true);
    expect(passes[1]!.length).toBeGreaterThan(0);
    expect(passes[1]!.every((o) => o.kind === 'moveGroup')).toBe(true);
    expect(passes[2]).toEqual([]);
    expect(groupOrder(f)).toEqual(['A', 'B']);
    expect(order(f)).toEqual([2, 1]);
  });

  it('converges with pinned tabs, unmatched tabs and interleaved rules (pinned left, groups in config order, ungrouped right)', async () => {
    const f = world();
    const config = cfg(rule('a', 'a.com/*', 'A'), rule('b', 'b.com/*', 'B'), rule('c', 'c.com/*', 'C'));
    f.addTab(tab(1, A, { pinned: true }));
    f.addTab(tab(2, OTHER));
    f.addTab(tab(3, C));
    f.addTab(tab(4, B));
    f.addTab(tab(5, OTHER));
    f.addTab(tab(6, A));
    f.addTab(tab(7, C));
    const passes = await converge(f, config);
    expect(passes.length).toBeLessThanOrEqual(3);
    expect(groupOrder(f)).toEqual(['A', 'B', 'C']);
    const o = order(f);
    expect(o[0]).toBe(1);
    expect(o.slice(1, 5)).toEqual([6, 4, 3, 7]);
    expect(o.slice(5).sort()).toEqual([2, 5]);
    expect(touched(passes.flat())).not.toContain(1);
  });

  it('a snapshot that is already correct yields []', () => {
    const f = world();
    f.addTab(tab(1, A, { pinned: true }));
    f.addTab(tab(2, A, { groupId: 10 }));
    f.addTab(tab(3, A, { groupId: 10 }));
    f.addTab(tab(4, B, { groupId: 11 }));
    f.addTab(tab(5, OTHER));
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: true });
    f.addGroup({ id: 11, windowId: 1, title: 'B', color: 'red', collapsed: false });
    f.assertInvariants();
    expect(planGroups(snap(f), AB, ctx({ managedTitles: new Set(['A', 'B']) }))).toEqual([]);
  });

  it('moveGroup index accounts for pinned tabs and is applied correctly by the fake', async () => {
    const f = world();
    f.addTab(tab(1, A, { pinned: true }));
    f.addTab(tab(2, B, { groupId: 11 }));
    f.addTab(tab(3, A, { groupId: 10 }));
    f.addTab(tab(4, A, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    f.addGroup({ id: 11, windowId: 1, title: 'B', color: 'red', collapsed: false });
    const ops = planGroups(snap(f), AB, ctx());
    expect(ops).toEqual([{ kind: 'moveGroup', groupId: 10, index: 1 }]);
    await apply(f, ops);
    expect(order(f)).toEqual([1, 3, 4, 2]);
    expect(planGroups(snap(f), AB, ctx())).toEqual([]);
  });

  it('structural ops in one window suppress moves there only', () => {
    const f = world([1, 2]);
    f.addTab(tab(1, B));
    f.addTab(tab(2, A));
    f.addTab(tab(3, B, { windowId: 2, groupId: 21 }));
    f.addTab(tab(4, A, { windowId: 2, groupId: 20 }));
    f.addGroup({ id: 20, windowId: 2, title: 'A', color: 'blue', collapsed: false });
    f.addGroup({ id: 21, windowId: 2, title: 'B', color: 'red', collapsed: false });
    const ops = planGroups(snap(f), AB, ctx());
    expect(ops.filter((o) => o.kind === 'moveGroup')).toEqual([{ kind: 'moveGroup', groupId: 20, index: 0 }]);
    expect(ops.filter((o) => o.kind === 'group').map((o) => (o as { windowId: number }).windowId)).toEqual([1, 1]);
  });
});

describe('planGroups: adoption by title + window', () => {
  const API = cfg(rule('api', 'a.com/*', 'api'));

  it('adopts an existing "api" group with a new id (999) after restart; no group is created', () => {
    const f = world();
    f.addTab(tab(1, A, { groupId: 999 }));
    f.addTab(tab(2, A));
    f.addGroup({ id: 999, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    const ops = planGroups(snap(f), API, ctx());
    expect(ops).toEqual([{ kind: 'group', tabIds: [2], windowId: 1, title: 'api', color: 'blue', existingGroupId: 999, ruleId: 'user/api' }]);
    expect(ops.some((o) => o.kind === 'group' && o.existingGroupId === undefined)).toBe(false);
  });

  it('adopted group with a different color gets updateGroup {color} only (never collapsed)', () => {
    const f = world();
    f.addTab(tab(1, A, { groupId: 999 }));
    f.addGroup({ id: 999, windowId: 1, title: 'api', color: 'red', collapsed: true });
    expect(planGroups(snap(f), API, ctx())).toEqual([{ kind: 'updateGroup', groupId: 999, color: 'blue' }]);
  });

  it('two "api" groups in one window merge into the lowest id', async () => {
    const f = world();
    f.addTab(tab(1, A, { groupId: 5 }));
    f.addTab(tab(2, A, { groupId: 3 }));
    f.addGroup({ id: 5, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    f.addGroup({ id: 3, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    const ops = planGroups(snap(f), API, ctx());
    expect(ops).toEqual([{ kind: 'group', tabIds: [1], windowId: 1, title: 'api', color: 'blue', existingGroupId: 3, ruleId: 'user/api' }]);
    await apply(f, ops);
    expect(f.state.groups.filter((g) => g.title === 'api').map((g) => g.id)).toEqual([3]);
    expect(f.state.tabs.map((t) => t.groupId)).toEqual([3, 3]);
  });

  it('same title in two windows → two separate groups (no cross-window merge)', () => {
    const f = world([1, 2]);
    f.addTab(tab(1, A));
    f.addTab(tab(2, A, { windowId: 2 }));
    expect(planGroups(snap(f), API, ctx())).toEqual([
      { kind: 'group', tabIds: [1], windowId: 1, title: 'api', color: 'blue', collapsed: false, ruleId: 'user/api' },
      { kind: 'group', tabIds: [2], windowId: 2, title: 'api', color: 'blue', collapsed: false, ruleId: 'user/api' },
    ]);
  });

  it('an existing "api" group in window 1 is not used for a tab in window 2', () => {
    const f = world([1, 2]);
    f.addTab(tab(1, A, { groupId: 10 }));
    f.addTab(tab(2, A, { windowId: 2 }));
    f.addGroup({ id: 10, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    expect(planGroups(snap(f), API, ctx())).toEqual([
      { kind: 'group', tabIds: [2], windowId: 2, title: 'api', color: 'blue', collapsed: false, ruleId: 'user/api' },
    ]);
  });

  it('ignores non-normal windows', () => {
    const f = world();
    f.addWindow(2, { type: 'popup' });
    f.addTab(tab(1, A, { windowId: 2 }));
    expect(planGroups(snap(f), API, ctx())).toEqual([]);
  });
});

describe('planGroups: hands off', () => {
  it('a leave-alone tab is never touched (even in a managed group it no longer matches)', () => {
    const f = world();
    f.addTab(tab(1, OTHER, { groupId: 10 }));
    f.addTab(tab(2, A));
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    const ops = planGroups(snap(f), AB, ctx({ leaveAlone: new Set([1, 2]), managedTitles: new Set(['A']) }));
    expect(touched(ops)).not.toContain(1);
    expect(touched(ops)).not.toContain(2);
    expect(ops).toEqual([]);
  });

  it('user-made group "misc" is never moved or ungrouped, keeps its matching tab, and ends up after managed groups', async () => {
    const f = world();
    f.addTab(tab(1, A, { groupId: 50 }));
    f.addTab(tab(2, OTHER, { groupId: 50 }));
    f.addTab(tab(3, A, { groupId: 10 }));
    f.addGroup({ id: 50, windowId: 1, title: 'misc', color: 'grey', collapsed: false });
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    const c = ctx({ managedTitles: new Set(['A']) });
    const ops = planGroups(snap(f), AB, c);
    expect(ops).toEqual([{ kind: 'moveGroup', groupId: 10, index: 0 }]);
    expect(touched(ops)).toEqual([]);
    await apply(f, ops);
    expect(groupOrder(f)).toEqual(['A', 'misc']);
    expect(f.state.tabs.filter((t) => t.groupId === 50).map((t) => t.id).sort()).toEqual([1, 2]);
    expect(planGroups(snap(f), AB, c)).toEqual([]);
  });

  it('pinned tabs never appear in ops', () => {
    const f = world();
    f.addTab(tab(1, A, { pinned: true }));
    f.addTab(tab(2, B, { pinned: true }));
    f.addTab(tab(3, A));
    const ops = planGroups(snap(f), AB, ctx());
    expect(touched(ops)).toEqual([3]);
  });

  it('exempt-url tabs in a managed group are not ungrouped', () => {
    const f = world();
    f.addTab(tab(1, 'chrome://settings', { groupId: 10 }));
    f.addTab(tab(2, A, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    expect(planGroups(snap(f), AB, ctx({ managedTitles: new Set(['A']) }))).toEqual([]);
  });
});

describe('planGroups: templated rules and sortGroups', () => {
  const repo = (o: Partial<GroupRule> = {}) => cfg(rule('gh', 'github.com/:org/:repo/*', '{repo}', o));
  const GH = (r: string) => `https://github.com/acme/${r}/pulls`;
  const twoGroups = () => {
    const f = world();
    f.addTab(tab(1, GH('api'), { groupId: 20 }));
    f.addTab(tab(2, GH('web'), { groupId: 21 }));
    f.addGroup({ id: 20, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    f.addGroup({ id: 21, windowId: 1, title: 'web', color: 'blue', collapsed: false });
    return f;
  };
  const created = new Map([['1|web', 1], ['1|api', 2]]);

  it('creation order: "web" created before "api" → web, api', async () => {
    const f = twoGroups();
    const c = ctx({ creationOrder: created });
    const ops = planGroups(snap(f), repo(), c);
    expect(ops).toEqual([{ kind: 'moveGroup', groupId: 21, index: 0 }]);
    await apply(f, ops);
    expect(groupOrder(f)).toEqual(['web', 'api']);
    expect(planGroups(snap(f), repo(), c)).toEqual([]);
  });

  it('alphabetical → api, web regardless of creation order', () => {
    const f = twoGroups();
    expect(planGroups(snap(f), repo({ sortGroups: 'alphabetical' }), ctx({ creationOrder: created }))).toEqual([]);
  });

  it('alphabetical reorders when needed', () => {
    const f = world();
    f.addTab(tab(1, GH('web'), { groupId: 21 }));
    f.addTab(tab(2, GH('api'), { groupId: 20 }));
    f.addGroup({ id: 20, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    f.addGroup({ id: 21, windowId: 1, title: 'web', color: 'blue', collapsed: false });
    expect(planGroups(snap(f), repo({ sortGroups: 'alphabetical' }), ctx({ creationOrder: created })))
      .toEqual([{ kind: 'moveGroup', groupId: 20, index: 0 }]);
  });

  it('new templated groups are emitted in tab order (web opened first)', () => {
    const f = world();
    f.addTab(tab(1, GH('web')));
    f.addTab(tab(2, GH('api')));
    expect(planGroups(snap(f), repo(), ctx()).map((o) => (o as { title: string }).title)).toEqual(['web', 'api']);
  });
});

describe('planGroups: strict', () => {
  const setup = () => {
    const f = world();
    f.addTab(tab(1, OTHER, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    return f;
  };
  const managed = () => ctx({ managedTitles: new Set(['api']) });

  it('strict: false → a tab that navigated away stays in its group', () => {
    expect(planGroups(snap(setup()), cfg(rule('api', 'a.com/*', 'api', { strict: false })), managed())).toEqual([]);
  });

  it('strict unset → ungroup', () => {
    expect(planGroups(snap(setup()), cfg(rule('api', 'a.com/*', 'api')), managed()))
      .toEqual([{ kind: 'ungroup', tabIds: [1], ruleId: 'user/api' }]);
  });

  it('strict-ungroup applies only to managed groups', () => {
    expect(planGroups(snap(setup()), cfg(rule('api', 'a.com/*', 'api')), ctx())).toEqual([]);
  });

  it('a group is managed after restart if another tab targets its title', () => {
    const f = setup();
    f.addTab(tab(2, A, { groupId: 10 }));
    expect(planGroups(snap(f), cfg(rule('api', 'a.com/*', 'api')), ctx()))
      .toEqual([{ kind: 'ungroup', tabIds: [1], ruleId: 'user/api' }]);
  });

  it('strict: false is taken from the rule of tabs still targeting the group', () => {
    const f = setup();
    f.addTab(tab(2, A, { groupId: 10 }));
    expect(planGroups(snap(f), cfg(rule('api', 'a.com/*', 'api', { strict: false })), ctx())).toEqual([]);
  });

  it('templated strict:false rule is resolved from the group title', () => {
    const f = world();
    f.addTab(tab(1, OTHER, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: 'widgets', color: 'blue', collapsed: false });
    const config = cfg(rule('gh', 'github.com/:org/:repo/*', '{repo}', { strict: false }));
    expect(planGroups(snap(f), config, ctx({ managedTitles: new Set(['widgets']) }))).toEqual([]);
  });

  it('strict: a tab that now matches another rule moves to that group', () => {
    const f = world();
    f.addTab(tab(1, B, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    expect(planGroups(snap(f), AB, ctx({ managedTitles: new Set(['A']) }))).toEqual([
      { kind: 'group', tabIds: [1], windowId: 1, title: 'B', color: 'red', collapsed: false, ruleId: 'user/b' },
    ]);
  });
});

describe('planGroups: merge', () => {
  const merged = cfg(rule('api', 'a.com/*', 'api', { merge: true }));

  it('merge: true → moveTabs into the window that already has "api"; no group in window 2', async () => {
    const f = world([1, 2]);
    f.addTab(tab(1, A, { groupId: 10 }));
    f.addTab(tab(2, A, { windowId: 2 }));
    f.addGroup({ id: 10, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    const ops = planGroups(snap(f), merged, ctx());
    expect(ops).toEqual([{ kind: 'moveTabs', tabIds: [2], windowId: 1, groupId: 10, ruleId: 'user/api' }]);
    await apply(f, ops);
    expect(f.state.tabs.find((t) => t.id === 2)).toMatchObject({ windowId: 1, groupId: 10 });
    expect(planGroups(snap(f), merged, ctx())).toEqual([]);
  });

  it('merge unset → separate group in window 2', () => {
    const f = world([1, 2]);
    f.addTab(tab(1, A, { groupId: 10 }));
    f.addTab(tab(2, A, { windowId: 2 }));
    f.addGroup({ id: 10, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    expect(planGroups(snap(f), cfg(rule('api', 'a.com/*', 'api')), ctx())).toEqual([
      { kind: 'group', tabIds: [2], windowId: 2, title: 'api', color: 'blue', collapsed: false, ruleId: 'user/api' },
    ]);
  });

  it('several windows have "api" → lowest group id wins', () => {
    const f = world([1, 2, 3]);
    f.addTab(tab(1, A, { groupId: 30 }));
    f.addTab(tab(2, A, { windowId: 2, groupId: 12 }));
    f.addTab(tab(3, A, { windowId: 3 }));
    f.addGroup({ id: 30, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    f.addGroup({ id: 12, windowId: 2, title: 'api', color: 'blue', collapsed: false });
    expect(planGroups(snap(f), merged, ctx())).toEqual([
      { kind: 'moveTabs', tabIds: [1], windowId: 2, groupId: 12, ruleId: 'user/api' },
      { kind: 'moveTabs', tabIds: [3], windowId: 2, groupId: 12, ruleId: 'user/api' },
    ]);
  });

  it('no group yet in any window → one group, created in the lowest window, pulling tabs from others', async () => {
    const f = world([1, 2]);
    f.addTab(tab(1, A, { windowId: 2 }));
    f.addTab(tab(2, A));
    const ops = planGroups(snap(f), merged, ctx());
    expect(ops).toEqual([{ kind: 'group', tabIds: [2, 1], windowId: 1, title: 'api', color: 'blue', collapsed: false, ruleId: 'user/api' }]);
    const passes = await converge(f, merged);
    expect(passes.length).toBeLessThanOrEqual(3);
    expect(f.state.groups.filter((g) => g.title === 'api')).toHaveLength(1);
  });
});

describe('planGroups: determinism', () => {
  it('same snapshot + config + ctx → identical ops, independent of snapshot array order', () => {
    const f = world([2, 1]);
    f.addTab(tab(1, B, { windowId: 2 }));
    f.addTab(tab(2, A, { windowId: 2 }));
    f.addTab(tab(3, B, { groupId: 11 }));
    f.addTab(tab(4, A, { groupId: 10 }));
    f.addTab(tab(5, OTHER, { groupId: 10 }));
    f.addGroup({ id: 11, windowId: 1, title: 'B', color: 'blue', collapsed: false });
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    const c = ctx({ managedTitles: new Set(['A', 'B']) });
    const s = snap(f);
    const first = planGroups(s, AB, c);
    expect(planGroups(structuredClone(s), AB, c)).toEqual(first);
    const shuffled: Snapshot = { tabs: [...s.tabs].reverse(), groups: [...s.groups].reverse(), windows: [...s.windows].reverse() };
    expect(planGroups(shuffled, AB, c)).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe('planGroups: merge disagreement (T8)', () => {
  const mixed = cfg(rule('n', 'a.com/n*', 'api'), rule('m', 'a.com/m*', 'api', { merge: true }));
  const N = 'https://a.com/n';
  const M = 'https://a.com/m';

  it('a non-merge and a merge rule with the same title never create two groups in one window', async () => {
    for (const [first, second] of [[N, M], [M, N]] as const) {
      const f = world();
      f.addTab(tab(1, first));
      f.addTab(tab(2, second));
      const ops = planGroups(snap(f), mixed, ctx());
      expect(ops).toEqual([{ kind: 'group', tabIds: [1, 2], windowId: 1, title: 'api', color: 'blue', collapsed: false, ruleId: 'user/n' }]);
      await converge(f, mixed);
      expect(f.state.groups.filter((g) => g.title === 'api')).toHaveLength(1);
    }
  });
});

describe('planGroups: empty titles (I1)', () => {
  it('never adopts or rewrites an untitled user group, even if a rule renders an empty title', () => {
    const f = world();
    f.addTab(tab(1, 'https://a.com/', { groupId: 10 }));
    f.addTab(tab(2, 'https://a.com/'));
    f.addGroup({ id: 10, windowId: 1, title: '', color: 'grey', collapsed: false });
    const config = cfg(rule('r', '/a\\.com\\/(?<x>z)?/', '{x}', {}, 'red'));
    expect(planGroups(snap(f), config, ctx())).toEqual([]);
    expect(planGroups(snap(f), config, ctx({ managedTitles: new Set(['']) }))).toEqual([]);
  });

  it('an untitled group is not managed even when managedTitles has ""', () => {
    const f = world();
    f.addTab(tab(1, OTHER, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: '', color: 'grey', collapsed: false });
    expect(planGroups(snap(f), AB, ctx({ managedTitles: new Set(['']) }))).toEqual([]);
    expect([...managedGroupIds(snap(f), AB, ctx({ managedTitles: new Set(['']) }))]).toEqual([]);
  });
});

describe('managedGroupIds (I2)', () => {
  it('a group is managed when its title is in managedTitles or a tab targets it', () => {
    const f = world();
    f.addTab(tab(1, A, { groupId: 10 }));
    f.addTab(tab(2, OTHER, { groupId: 11 }));
    f.addTab(tab(3, OTHER, { groupId: 12 }));
    f.addGroup({ id: 10, windowId: 1, title: 'A', color: 'blue', collapsed: false });
    f.addGroup({ id: 11, windowId: 1, title: 'B', color: 'blue', collapsed: false });
    f.addGroup({ id: 12, windowId: 1, title: 'mine', color: 'blue', collapsed: false });
    expect([...managedGroupIds(snap(f), AB, ctx())]).toEqual([10]);
    expect([...managedGroupIds(snap(f), AB, ctx({ managedTitles: new Set(['B']) }))].sort()).toEqual([10, 11]);
  });
});

describe('syncCreationOrder (I3)', () => {
  it('numbers managed groups lacking an order in tab-strip order, after known ones; drops vanished keys', () => {
    const f = world([1, 2]);
    f.addTab(tab(1, A, { groupId: 30 }));
    f.addTab(tab(2, A, { groupId: 20 }));
    f.addTab(tab(3, A, { windowId: 2, groupId: 40 }));
    f.addGroup({ id: 30, windowId: 1, title: 'z', color: 'blue', collapsed: false });
    f.addGroup({ id: 20, windowId: 1, title: 'y', color: 'blue', collapsed: false });
    f.addGroup({ id: 40, windowId: 2, title: 'x', color: 'blue', collapsed: false });
    const order = new Map([['1|y', 7], ['1|gone', 3]]);
    syncCreationOrder(snap(f), new Set([20, 30, 40]), order);
    expect([...order]).toEqual([['1|y', 7], ['1|z', 8], ['2|x', 9]]);
  });
});

describe('planGroups: ops carry the rule (I7)', () => {
  it('group, ungroup and moveTabs ops name the rule; ungroups are split per source group', () => {
    const f = world([1, 2]);
    f.addTab(tab(1, A));
    f.addTab(tab(2, OTHER, { groupId: 10 }));
    f.addTab(tab(3, OTHER, { groupId: 11 }));
    f.addGroup({ id: 10, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    f.addGroup({ id: 11, windowId: 1, title: 'B', color: 'red', collapsed: false });
    const config = cfg(rule('api', 'a.com/*', 'api', { merge: true }), rule('b', 'b.com/*', 'B', {}, 'red'));
    f.addTab(tab(4, A, { windowId: 2 }));
    const ops = planGroups(snap(f), config, ctx({ managedTitles: new Set(['api', 'B']) }));
    expect(ops).toEqual([
      { kind: 'ungroup', tabIds: [2], ruleId: 'user/api' },
      { kind: 'ungroup', tabIds: [3], ruleId: 'user/b' },
      { kind: 'group', tabIds: [1], windowId: 1, title: 'api', color: 'blue', existingGroupId: 10, ruleId: 'user/api' },
      { kind: 'moveTabs', tabIds: [4], windowId: 1, groupId: 10, ruleId: 'user/api' },
    ]);
  });
});

describe('syncCreationOrder: delayed deletion (CR#6)', () => {
  it('keeps numbers of titles still pending a retitle (the group is untitled meanwhile)', () => {
    const f = world();
    f.addTab(tab(1, A, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: '', color: 'blue', collapsed: false });
    const order = new Map([['1|A', 1]]);
    const absent = new Map<string, number>();
    for (let i = 0; i < 3; i++) syncCreationOrder(snap(f), new Set(), order, { pendingTitles: ['A'], absent, count: true });
    expect([...order]).toEqual([['1|A', 1]]);
    expect([...absent]).toEqual([]);
  });
  it('drops a key only after it was absent for 2 consecutive counted calls (flushes); a return resets it', () => {
    const f = world();
    const order = new Map([['1|gone', 3]]);
    const absent = new Map<string, number>();
    syncCreationOrder(snap(f), new Set(), order, { absent, count: true });
    syncCreationOrder(snap(f), new Set(), order, { absent, count: false }); // later pass of the same flush
    expect([...order]).toEqual([['1|gone', 3]]);
    f.addTab(tab(1, A, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: 'gone', color: 'blue', collapsed: false });
    syncCreationOrder(snap(f), new Set([10]), order, { absent, count: true }); // back: tombstone cleared
    expect([...absent]).toEqual([]);
    const empty = world();
    syncCreationOrder(snap(empty), new Set(), order, { absent, count: true });
    expect([...order]).toEqual([['1|gone', 3]]);
    syncCreationOrder(snap(empty), new Set(), order, { absent, count: true });
    expect([...order]).toEqual([]);
    expect([...absent]).toEqual([]);
  });
});

describe('planGroups: a title claimed by a merge rule is global (CR#9)', () => {
  const mixed = cfg(rule('m', 'a.com/m*', 'api', { merge: true }), rule('n', 'a.com/n*', 'api'));
  const N = 'https://a.com/n';
  const M = 'https://a.com/m';
  it('merge rule in window 1, non-merge rule with the same title in window 2 → one group globally, ≤2 passes', async () => {
    for (const [w1, w2] of [[M, N], [N, M]] as const) {
      const f = world([1, 2]);
      f.addTab(tab(1, w1));
      f.addTab(tab(2, w2, { windowId: 2 }));
      const passes = await converge(f, mixed);
      expect(passes.length).toBeLessThanOrEqual(3); // ≤2 passes with ops, then []
      expect(f.state.groups.filter((g) => g.title === 'api')).toHaveLength(1);
      expect(new Set(f.state.tabs.map((t) => t.groupId)).size).toBe(1);
    }
  });
  it('an existing non-merge group in window 2 is merged into the lowest-id group in window 1', async () => {
    const f = world([1, 2]);
    f.addTab(tab(1, M, { groupId: 10 }));
    f.addGroup({ id: 10, windowId: 1, title: 'api', color: 'blue', collapsed: false });
    f.addTab(tab(2, N, { windowId: 2, groupId: 20 }));
    f.addGroup({ id: 20, windowId: 2, title: 'api', color: 'blue', collapsed: false });
    const passes = await converge(f, mixed, ctx({ managedTitles: new Set(['api']) }));
    expect(passes.length).toBeLessThanOrEqual(3);
    expect(f.state.groups.filter((g) => g.title === 'api').map((g) => g.id)).toEqual([10]);
  });
});
