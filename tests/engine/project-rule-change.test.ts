// A settings change that stops a project tab's rule from matching moves the tab out of its project at once, while
// the tab stays at the same URL (no reload): the sticky entry carries a signature of the rule that assigned it, and
// only the tab's own candidate keeps it once that rule is gone or has changed. Wired as background.ts wires it: real
// ProgramCache + PermissionsManager + SourceService + ProjectService + Reconciler.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultConfig } from '../../src/core/config/defaults';
import { ProjectService, ProjectStore } from '../../src/engine/projects';
import { PermissionsManager } from '../../src/engine/permissions';
import { ProgramCache } from '../../src/engine/program-cache';
import { Reconciler } from '../../src/engine/reconciler';
import { SourceService } from '../../src/engine/sources';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Config } from '../../src/core/types';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const TICKET = 'https://acme.atlassian.net/browse/ABC-7';
const BOARD = 'https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-7';
const BOARD_CLOSED = 'https://acme.atlassian.net/jira/software/projects/ABC/boards/1';
const RECIPE = 'jira-ticket-title';

const area = () => {
  const d = new Map<string, unknown>();
  return {
    get: vi.fn(async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => d.has(x)).map((x) => [x, structuredClone(d.get(x))]))),
    set: vi.fn(async (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) d.set(k, structuredClone(v)); }),
    remove: vi.fn(async () => {}),
  };
};

const cfg = (o: { enabled?: boolean; params?: Record<string, unknown>; ruleEnabled?: Record<string, boolean> } = {}): Config => ({
  ...defaultConfig(),
  recipes: defaultConfig().recipes.map((r) => (r.id !== RECIPE ? r : {
    ...r, enabled: o.enabled ?? true, ...(o.params && { params: o.params }), ...(o.ruleEnabled && { ruleEnabled: o.ruleEnabled }),
  })),
});

async function world(cfg0: Config) {
  const port = new FakeBrowserPort();
  port.addWindow(1, { focused: true });
  const t = (id: number, url: string, title: string) => port.addTab({ id, windowId: 1, url, title, pinned: false, incognito: false, discarded: false, active: false, audible: false });
  t(1, TICKET, '[ABC-7] Login fails - Jira');
  t(2, BOARD, 'ABC board - Jira');
  const box = { cfg: cfg0 };
  const holder: { pm?: PermissionsManager } = {};
  const programs = new ProgramCache(async () => box.cfg, { builtins: builtinRecipes(), paused: () => holder.pm?.paused() ?? [], warn: () => {} });
  const getProgram = () => programs.get();
  const pm = new PermissionsManager(port, getProgram, { register: async () => [], unregister: async () => [], inject: async () => {} }, {
    connections: async () => [],
  });
  holder.pm = pm;
  await pm.onChanged();
  // eslint-disable-next-line prefer-const
  let r: Reconciler;
  const sources = new SourceService({
    conn: { fetch: vi.fn(), status: async () => [], defs: async () => [] },
    limiter: { canSend: async () => ({ ok: true }) },
    getProgram, levelFor: (...a) => pm.levelFor(...a),
    port: { snapshot: () => port.snapshot(), hasPermission: (q) => port.hasPermission(q) },
    facts: { get: () => undefined }, local: area(), now: () => NOW,
    onUpdated: () => { r.schedule('sourceUpdated'); },
  } as ConstructorParameters<typeof SourceService>[0]);
  const projects = new ProjectService({
    store: new ProjectStore(area()), port, getProgram, sources, facts: { get: () => undefined }, log: { add: () => {} },
    recentlyClosed: { add: () => 'rc' }, safety: { isProtected: (x) => x.pinned }, state: () => r.liveState(), now: () => NOW,
  });
  r = new Reconciler(port, getProgram, { projects, sources, now: () => NOW });
  const groupOf = (id: number) => port.state.groups.find((g) => g.id === port.state.tabs.find((x) => x.id === id)?.groupId)?.title ?? null;
  const groups = () => ({ ticket: groupOf(1), board: groupOf(2) });
  /** What background.ts does on store.onChange: reconciler.schedule('config') + permissions.onChanged(). */
  const setConfig = async (c: Config) => { box.cfg = c; await pm.onChanged(); await r.flush(); };
  const navigate = async (id: number, url: string) => { port.state.tabs.find((x) => x.id === id)!.url = url; await r.flush(); };
  const sticky = async () => [...(await r.liveState()).projectTabs].map(([id, s]) => `${id}:${s.projectId}:${s.ruleKey}`);
  await sources.refresh('alarm');
  await r.flush();
  return { port, r, groups, setConfig, navigate, sticky };
}

describe('a settings change while a project tab stays at the same URL', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('Group a board when it shows a ticket, on then off: the board leaves the ticket group, the ticket stays', async () => {
    const w = await world(cfg({ params: { boardPopups: false } }));
    expect(w.groups()).toEqual({ ticket: 'ABC-7', board: null });
    await w.setConfig(cfg({ params: { boardPopups: true } }));
    expect(w.groups()).toEqual({ ticket: 'ABC-7', board: 'ABC-7' });
    await w.setConfig(cfg({ params: { boardPopups: false } }));
    expect(w.groups()).toEqual({ ticket: 'ABC-7', board: null });
    expect(await w.sticky()).toEqual([`1:${RECIPE}:ABC-7:${RECIPE}/ticket`]);
  });

  it('with the setting off, the board reopening its popup stays out', async () => {
    const w = await world(cfg({ params: { boardPopups: true } }));
    await w.setConfig(cfg({ params: { boardPopups: false } }));
    await w.navigate(2, BOARD_CLOSED);
    await w.navigate(2, BOARD);
    expect(w.groups().board).toBe(null);
  });

  it('the ticket rule turned off: the ticket tab leaves its group', async () => {
    const w = await world(cfg());
    expect(w.groups().ticket).toBe('ABC-7');
    await w.setConfig(cfg({ ruleEnabled: { ticket: false } }));
    expect(w.groups().ticket).toBe(null);
  });

  it('the group color changed: both tabs stay in their group', async () => {
    const w = await world(cfg({ params: { boardPopups: true } }));
    await w.setConfig(cfg({ params: { boardPopups: true, color: 'red' } }));
    expect(w.groups()).toEqual({ ticket: 'ABC-7', board: 'ABC-7' });
  });
});
