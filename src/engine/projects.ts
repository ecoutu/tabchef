// Projects (M3 T15): the ProjectStore (storage.local `projects`, not synced) and the ProjectService, which resolves
// project membership each reconcile pass (T14's pure resolveProjects + projectTargets, planned as PlanContext.overrides,
// M3-R66), persists sticky membership with its rule in RuntimeState.projectTabs, and runs the user's project actions:
// add / remove a tab, open a linked PR, close the project's tabs. Ticket status and linked PRs come from the
// SourceService's public API only (M3-R68); linked PRs are refreshed at most every LINKED_REFRESH_MS per project.
import { liveProgram } from '../core/lang/dry-run';
import { projectGroupTitle, projectTargets, resolveProjects, type ResolveResult, type StickyMap } from '../core/projects/resolve';
import type { RecentlyClosed } from '../core/safety/recently-closed';
import type { GroupTarget } from '../core/group/evaluate';
import type { Program, TabFacts } from '../core/lang/types';
import type { Project, ProjectAssignment, ProjectCardData, ProjectDef } from '../core/projects/types';
import type { PrInfo, PrState, SourceEntry } from '../core/sources/types';
import type { Snapshot, TabSnap } from '../core/types';
import { normalizeUrl } from '../core/url/normalize';
import type { BrowserPort } from '../platform/browser-port';
import type { KeyValueArea } from './connections/secret-store';
import type { PageFacts } from './page-facts';
import type { WhyLog } from './reconciler';
import type { SafetyService } from './safety';
import type { SourceService } from './sources';
import { saveState, type LiveState } from './state';

export const PROJECTS_KEY = 'projects';
/** Projects with no open tab for this long (browser running time) are pruned on startup. */
export const PRUNE_AFTER_MS = 7 * 24 * 3600_000;
/** Linked-PR searches per project at most this often (spec: 15 min). */
export const LINKED_REFRESH_MS = 15 * 60_000;
/** Closed time is added to the store at most this often (pruning works in days). */
const CLOSED_FLUSH_MS = 3600_000;
/** At most this much closed time is counted between two passes (the browser may not have been running). */
const MAX_TICK_MS = 15 * 60_000;
export const CLOSED_CLOCK_KEY = 'projects.closedClock';
/** The last pass that saw open tabs, and closed time per project not yet added to its stored `closedFor`. */
interface ClosedClock { lastTick?: number; pending: Record<string, number> }

const PILLS = new Set<PrState>(['open', 'draft', 'merged', 'closed']);
const CATEGORIES = new Set(['new', 'indeterminate', 'done']);
const PR_OWNER = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+\/pull\/\d+/;
const urlOf = (t: TabSnap): string => (t.pendingUrl ? t.pendingUrl : t.url);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isProject = (x: unknown): x is Project => isObj(x) && typeof x.id === 'string' && typeof x.recipeId === 'string'
  && typeof x.key === 'string' && Array.isArray(x.manual) && Array.isArray(x.excluded) && Array.isArray(x.linked);

/** Stored projects, cached after the first read. A failed read is retried and never overwritten. */
export class ProjectStore {
  private cache?: Promise<Map<string, Project>>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly local: Pick<KeyValueArea, 'get' | 'set'>) {}

  private load(): Promise<Map<string, Project>> {
    this.cache ??= this.local.get(PROJECTS_KEY).then((r) => {
      const v = r[PROJECTS_KEY];
      return new Map((Array.isArray(v) ? v.filter(isProject) : []).map((p) => [p.id, p]));
    }, (e: unknown) => {
      this.cache = undefined;
      throw e;
    });
    return this.cache;
  }

  async list(): Promise<Project[]> {
    return [...(await this.load()).values()].map((p) => structuredClone(p));
  }

  /** Stores (adds or replaces) each project, in one write. */
  put(...ps: Project[]): Promise<void> {
    return this.write((m) => { for (const p of ps) m.set(p.id, structuredClone(p)); });
  }

  remove(...ids: string[]): Promise<void> {
    return this.write((m) => { for (const id of ids) m.delete(id); });
  }

  private write(fn: (m: Map<string, Project>) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const m = await this.load();
      fn(m);
      await this.local.set({ [PROJECTS_KEY]: [...m.values()] });
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

export interface ProjectServiceDeps {
  store: ProjectStore;
  port: Pick<BrowserPort, 'snapshot' | 'createTab' | 'closeTab'>;
  getProgram: () => Promise<Program>;
  sources: Pick<SourceService, 'factsFor' | 'issues' | 'linkedFor'>;
  facts: Pick<PageFacts, 'get'>;
  log: WhyLog;
  recentlyClosed: Pick<RecentlyClosed, 'add'>;
  /** Pinned, locked, form-edited (and audible / exempt) tabs are never closed by closeGroup. */
  safety: Pick<SafetyService, 'isProtected'>;
  /** The reconciler's LiveState (Reconciler.liveState): sticky membership lives in its RuntimeState. */
  state: () => Promise<LiveState>;
  /** Re-plan after a user action (Reconciler.schedule). */
  schedule?: (reason: string) => void;
  /** After each pass: the open projects and their group titles (the context menu). */
  onProjectsChanged?: (projects: { id: string; title: string }[]) => void;
  /**
   * storage.session (survives worker restarts, cleared on browser restart): the closed-time clock, so browser running
   * time accrues across MV3 worker lifetimes. Without it the clock lives in memory.
   */
  session?: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
  now?: () => number;
}

interface Resolved { program: Program; defs: ProjectDef[]; projects: Project[]; assignments: Map<number, ProjectAssignment> }
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class ProjectService {
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private pruned = false;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One at a time: every method reads and writes the store and the sticky map. Never held across the network. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** The live planner overrides for this snapshot (Reconciler: PlanContext.overrides); dry-run rules fall through (R48). */
  targets(snap: Snapshot): Promise<Map<number, GroupTarget | null>> {
    return this.serial(async () => {
      const r = await this.resolve(snap);
      return projectTargets(r.assignments, r.projects, r.defs);
    });
  }

  /**
   * Side-effect free overrides of `program` (as given: the full Program for the dry-run pass, liveProgram for
   * previews): the stored projects and the current sticky map; nothing is stored, logged or persisted.
   */
  async previewTargets(snap: Snapshot, program: Program): Promise<Map<number, GroupTarget | null>> {
    const defs = program.projects ?? [];
    if (defs.length === 0) return new Map();
    const [st, stored] = await Promise.all([this.deps.state(), this.deps.store.list()]);
    const r = this.run(snap, program, stored, st.projectTabs);
    return projectTargets(r.assignments, [...stored, ...r.created], defs);
  }

  /** resolveProjects over `program` with this service's facts and prefixes. Pure apart from reading facts. */
  private run(snap: Snapshot, program: Program, stored: Project[], sticky: StickyMap): ResolveResult {
    const tabs = new Map(snap.tabs.map((t) => [t.id, t]));
    return resolveProjects({
      snap, program, now: this.now(), projects: stored, sticky,
      facts: (id): Partial<TabFacts> => {
        const t = tabs.get(id);
        const page = this.deps.facts.get(id);
        const source = t && this.deps.sources.factsFor(id, urlOf(t));
        return { ...(page && { page }), ...(source && { source }) };
      },
      allowPrefixes: (program.projects ?? []).flatMap((d) => strings(program.params?.[d.recipeId]?.projectPrefixes)),
      // A key the Jira API answered for confirms its prefix (Review Focus #5).
      knownPrefixes: new Set(stored.filter((p) => p.status?.via === 'api').map((p) => p.key.slice(0, Math.max(0, p.key.lastIndexOf('-'))))),
    });
  }

  /**
   * Live membership for `snap` (dry-run rules fall through, R48): stores created projects (with their summary) and
   * their closed time, prunes stale projects once, persists the sticky map and logs each tab that joined by rules.
   * Under global dry run (R50) nothing is stored, persisted or logged.
   */
  private async resolve(snap: Snapshot): Promise<Resolved> {
    const full = await this.deps.getProgram();
    const program = liveProgram(full);
    const defs = program.projects ?? [];
    if (defs.length === 0) {
      this.deps.onProjectsChanged?.([]);
      return { program, defs, projects: [], assignments: new Map() };
    }
    const [st, stored] = await Promise.all([this.deps.state(), this.deps.store.list()]);
    const r = this.run(snap, program, stored, st.projectTabs);
    let projects = [...stored, ...r.created];
    const open = new Set([...r.assignments.values()].map((a) => a.projectId));
    if (!full.dryRun) {
      const changed = new Set<Project>(r.created);
      for (const p of projects) {
        const summary = r.summaries.get(p.id);
        if (summary !== undefined && p.summary === undefined) { p.summary = summary; changed.add(p); }
      }
      const removed = await this.closedTime(snap, projects, open, changed);
      projects = projects.filter((p) => !removed.includes(p.id));
      if (changed.size) await this.deps.store.put(...[...changed].filter((p) => !removed.includes(p.id)));
      if (removed.length) await this.deps.store.remove(...removed);
      const byId = new Map(projects.map((p) => [p.id, p]));
      for (const [tabId, s] of r.sticky) {
        if (st.projectTabs.get(tabId)?.projectId === s.projectId) continue;
        const name = program.rules.find((x) => x.key === s.ruleKey)?.rule.name || s.ruleKey;
        this.log(tabId, `Joined ${byId.get(s.projectId)?.key ?? s.projectId} by rule ${name}`, s.ruleKey);
      }
      st.projectTabs = r.sticky;
    }
    const defOf = new Map(defs.map((d) => [d.recipeId, d]));
    // Under global dry run only stored projects are listed: addTab takes no unstored one.
    this.deps.onProjectsChanged?.((full.dryRun ? stored : projects).flatMap((p) => {
      const def = defOf.get(p.recipeId);
      return def && open.has(p.id) ? [{ id: p.id, title: projectGroupTitle(def, p) }] : [];
    }));
    return { program, defs, projects, assignments: r.assignments };
  }

  /**
   * Counts browser running time without an open tab per project (`closedFor`), only between passes that see open
   * tabs (a snapshot before session restore counts nothing), at most MAX_TICK_MS per gap. The clock (last tick and
   * pending time) is kept in storage.session, so it runs across worker restarts and stops with the browser; pending
   * time is added to the store hourly. The first such pass of a worker returns the projects closed for PRUNE_AFTER_MS.
   */
  private async closedTime(snap: Snapshot, projects: Project[], open: Set<string>, changed: Set<Project>): Promise<string[]> {
    if (snap.tabs.length === 0) return [];
    const now = this.now();
    const clock = await this.readClock();
    const dt = clock.lastTick === undefined ? 0 : Math.min(Math.max(0, now - clock.lastTick), MAX_TICK_MS);
    const pending: Record<string, number> = {};
    for (const p of projects) {
      if (open.has(p.id)) {
        if (p.closedFor !== undefined) { delete p.closedFor; changed.add(p); }
        continue;
      }
      const ms = (clock.pending[p.id] ?? 0) + dt;
      if (ms < CLOSED_FLUSH_MS) { if (ms > 0) pending[p.id] = ms; continue; }
      p.closedFor = (p.closedFor ?? 0) + ms;
      changed.add(p);
    }
    await this.writeClock({ lastTick: now, pending });
    if (this.pruned) return [];
    this.pruned = true;
    return projects.filter((p) => !open.has(p.id) && (p.closedFor ?? 0) + (pending[p.id] ?? 0) >= PRUNE_AFTER_MS).map((p) => p.id);
  }

  private memoryClock: ClosedClock = { pending: {} };
  private async readClock(): Promise<ClosedClock> {
    if (!this.deps.session) return this.memoryClock;
    try {
      const v = await this.deps.session.get(CLOSED_CLOCK_KEY);
      if (isObj(v) && isObj(v.pending)) {
        const pending = Object.fromEntries(Object.entries(v.pending).filter((e): e is [string, number] => typeof e[1] === 'number'));
        return { ...(typeof v.lastTick === 'number' && { lastTick: v.lastTick }), pending };
      }
    } catch (e) {
      console.warn('[tabchef] project clock read failed', e);
    }
    return { pending: {} };
  }
  private async writeClock(c: ClosedClock): Promise<void> {
    this.memoryClock = c;
    await this.deps.session?.set(CLOSED_CLOCK_KEY, c).catch((e: unknown) => console.warn('[tabchef] project clock write failed', e));
  }

  private log(tabId: number, detail: string, ruleId?: string, action = 'project-join'): void {
    this.deps.log.add({ tabId, ...(ruleId !== undefined && { ruleId }), action, detail, at: this.now() });
  }

  private norm(program: Program, url: string): string {
    return normalizeUrl(url, program.dedupe)?.key ?? url;
  }

  /** Adds the tab to `p.manual` (out of every other project's), clears its exclusion and re-plans. */
  private async join(program: Program, projects: Project[], p: Project, tabId: number, windowId: number, url: string): Promise<void> {
    const def = program.projects?.find((d) => d.recipeId === p.recipeId);
    if (!def?.join.includes('manual')) throw new Error('this project does not take tabs manually');
    const changed = projects.filter((q) => q !== p && q.manual.some((m) => m.tabId === tabId));
    for (const q of changed) q.manual = q.manual.filter((m) => m.tabId !== tabId);
    const key = this.norm(program, url);
    p.excluded = p.excluded.filter((u) => u !== key);
    p.manual = [...p.manual.filter((m) => m.tabId !== tabId), { url, windowId, tabId }];
    await this.deps.store.put(p, ...changed);
    this.log(tabId, `Joined ${p.key} manually`);
    this.deps.schedule?.('project');
  }

  private async project(id: string): Promise<{ program: Program; projects: Project[]; p: Project }> {
    const [program, projects] = await Promise.all([this.deps.getProgram(), this.deps.store.list()]);
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error('unknown project');
    return { program, projects, p };
  }

  /** Manual membership: wins over rules and clears the tab's exclusion. */
  addTab(tabId: number, projectId: string): Promise<void> {
    return this.serial(async () => {
      const t = (await this.deps.port.snapshot()).tabs.find((x) => x.id === tabId);
      if (!t) throw new Error('tab not found');
      const { program, projects, p } = await this.project(projectId);
      await this.join(program, projects, p, tabId, t.windowId, urlOf(t));
    });
  }

  /** Excludes the tab's URL from its project (the reconciler then ungroups it); it rejoins by rules once it navigates. */
  removeTab(tabId: number): Promise<void> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const t = snap.tabs.find((x) => x.id === tabId);
      const { program, assignments, projects } = await this.resolve(snap);
      const p = projects.find((x) => x.id === assignments.get(tabId)?.projectId);
      if (!t || !p) return;
      const key = this.norm(program, urlOf(t));
      p.manual = p.manual.filter((m) => m.tabId !== tabId && this.norm(program, m.url) !== key);
      if (!p.excluded.includes(key)) p.excluded.push(key);
      (await this.deps.state()).projectTabs.delete(tabId);
      await this.deps.store.put(p);
      this.log(tabId, `Removed from ${p.key} manually`, undefined, 'project-leave');
      this.deps.schedule?.('project');
    });
  }

  /** Opens one of the project's linked PRs in the background, in the project's window, as a manual member. */
  openLinked(projectId: string, url: string): Promise<number> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { program, assignments, projects } = await this.resolve(snap);
      const p = projects.find((x) => x.id === projectId);
      if (!p) throw new Error('unknown project');
      if (!p.linked.some((l) => l.url === url)) throw new Error('not a linked PR of this project');
      const windowId = snap.tabs.find((t) => assignments.get(t.id)?.projectId === projectId)?.windowId ?? p.manual.at(-1)?.windowId;
      const tabId = await this.deps.port.createTab({ url, active: false, ...(windowId !== undefined && { windowId }) });
      const at = windowId ?? (await this.deps.port.snapshot()).tabs.find((t) => t.id === tabId)?.windowId ?? -1;
      await this.join(program, projects, p, tabId, at, url);
      return tabId;
    });
  }

  /** Closes the project's tabs except protected ones; the project is removed when none remains. */
  closeGroup(projectId: string): Promise<{ closed: number; skipped: number }> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { assignments, projects } = await this.resolve(snap);
      const p = projects.find((x) => x.id === projectId);
      if (!p) throw new Error('unknown project');
      let closed = 0;
      let skipped = 0;
      for (const t of snap.tabs.filter((x) => assignments.get(x.id)?.projectId === projectId)) {
        if (this.deps.safety.isProtected(t)) { skipped++; continue; }
        try {
          await this.deps.port.closeTab(t.id);
        } catch {
          skipped++;
          continue;
        }
        const groupTitle = snap.groups.find((g) => g.id === t.groupId)?.title;
        this.deps.recentlyClosed.add({
          url: urlOf(t), title: t.title, ...(groupTitle && { groupTitle }), windowId: t.windowId, reason: 'project-closed', at: this.now(),
        });
        this.log(t.id, `Closed with project ${p.key}`, undefined, 'project-close');
        closed++;
      }
      if (skipped === 0) await this.deps.store.remove(projectId);
      this.deps.schedule?.('project');
      return { closed, skipped };
    });
  }

  /** tabs.onReplaced (discard / prerender swap): manual and sticky membership move to the new tab id. */
  onReplaced(added: number, removed: number): Promise<void> {
    return this.serial(async () => {
      const st = await this.deps.state();
      const e = st.projectTabs.get(removed);
      if (e) {
        st.projectTabs.delete(removed);
        st.projectTabs.set(added, e);
        await saveState(st);
      }
      const changed = (await this.deps.store.list()).filter((p) => p.manual.some((m) => m.tabId === removed));
      for (const p of changed) p.manual = p.manual.map((m) => (m.tabId === removed ? { ...m, tabId: added } : m));
      if (changed.length) await this.deps.store.put(...changed);
    });
  }

  /**
   * Open projects for the popup / side panel (`projects.list`). Membership is read under the queue, ticket status and
   * linked PRs are fetched outside it (a reconcile never waits on the network), then written under it again.
   */
  async cards(): Promise<ProjectCardData[]> {
    const plan = await this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { program, defs, projects, assignments } = await this.resolve(snap);
      const tabsOf = new Map<string, TabSnap[]>();
      for (const t of snap.tabs) {
        const id = assignments.get(t.id)?.projectId;
        if (id !== undefined) tabsOf.set(id, [...(tabsOf.get(id) ?? []), t]);
      }
      const defOf = new Map(defs.map((d) => [d.recipeId, d]));
      return { program, defOf, tabsOf, open: projects.filter((p) => tabsOf.has(p.id) && defOf.has(p.recipeId)) };
    });
    const { program, defOf, tabsOf, open } = plan;
    if (open.length === 0) return [];
    const now = this.now();
    const [linked, issues] = await Promise.all([this.fetchLinked(program, open, tabsOf, now), this.deps.sources.issues(open.map((p) => p.key))]);
    return this.serial(async () => {
      const current = new Map((await this.deps.store.list()).map((p) => [p.id, p]));
      const factsOf = (t: TabSnap): SourceEntry<Record<string, unknown>>[] => Object.values(this.deps.sources.factsFor(t.id, urlOf(t)) ?? {});
      const changed: Project[] = [];
      const cards = open.flatMap((o): ProjectCardData[] => {
        const p = current.get(o.id);
        if (!p) return []; // removed meanwhile (or never stored: global dry run)
        const tabs = tabsOf.get(p.id)!;
        const before = JSON.stringify(p);
        const l = linked.get(p.id);
        // A fetch started before the stored one is older: it never overwrites newer linked PRs.
        if (l && !(p.linkedFetchedAt !== undefined && p.linkedFetchedAt > now)) {
          p.linkedFetchedAt = now;
          if (l.prs) p.linked = l.prs.map((x) => ({ url: x.url, title: x.title ?? x.url, state: x.state }));
        }
        const issue = issues.get(p.key);
        if (p.summary === undefined && issue?.data?.summary) p.summary = issue.data.summary;
        const status = statusOf(issue?.data, issue?.via) ?? tabs.flatMap(factsOf).map((e) => statusOf(e.data, e.via)).find((x) => x) ?? p.status;
        if (status) p.status = status;
        if (JSON.stringify(p) !== before) changed.push(p);
        const openUrls = new Set(tabs.map((t) => this.norm(program, urlOf(t))));
        return [{
          id: p.id, key: p.key, title: projectGroupTitle(defOf.get(p.recipeId)!, p), ...(p.summary !== undefined && { summary: p.summary }),
          ...(status && { status }), done: status?.category === 'done',
          tabs: tabs.map((t) => {
            const pr = factsOf(t).find((e) => PILLS.has(e.data?.state as PrState));
            return {
              tabId: t.id, windowId: t.windowId, title: t.title, url: urlOf(t),
              ...(t.favIconUrl !== undefined && { favIconUrl: t.favIconUrl }), ...(t.lastAccessed !== undefined && { lastAccessed: t.lastAccessed }),
              ...(pr && { pill: pr.data!.state as PrState }), ...(pr?.stale && { stale: true }),
            };
          }),
          linked: p.linked.filter((x) => !openUrls.has(this.norm(program, x.url))),
        }];
      });
      if (changed.length) await this.deps.store.put(...changed);
      return cards;
    });
  }

  /**
   * Linked PRs of projects not searched for LINKED_REFRESH_MS, through SourceService.linkedFor: in the orgs of the
   * project's open PR tabs plus its recipe's `githubOrgs`. Every searched project is returned (`prs` undefined: no
   * results known, the previous list stays), so the 15-minute cap holds for keys without results too.
   */
  private async fetchLinked(program: Program, open: Project[], tabsOf: Map<string, TabSnap[]>, now: number): Promise<Map<string, { prs?: PrInfo[] }>> {
    const byOrgs = new Map<string, Project[]>();
    for (const p of open) {
      if (p.linkedFetchedAt !== undefined && now - p.linkedFetchedAt < LINKED_REFRESH_MS) continue;
      const orgs = [...tabsOf.get(p.id)!.flatMap((t) => PR_OWNER.exec(urlOf(t))?.[1] ?? []), ...strings(program.params?.[p.recipeId]?.githubOrgs)];
      const k = [...new Set(orgs.map((o) => o.toLowerCase()))].sort().join(',');
      byOrgs.set(k, [...(byOrgs.get(k) ?? []), p]);
    }
    const out = new Map<string, { prs?: PrInfo[] }>();
    for (const [k, ps] of byOrgs) {
      const found = await this.deps.sources.linkedFor(ps.map((p) => p.key), k ? k.split(',') : []);
      for (const p of ps) out.set(p.id, { ...(found.has(p.key) && { prs: found.get(p.key)! }) });
    }
    return out;
  }
}

/** A Jira status from source data (`status` + `statusCategory`), or undefined when either is missing. */
function statusOf(data: unknown, via: SourceEntry['via'] | undefined): Project['status'] {
  if (!isObj(data) || typeof data.status !== 'string' || !CATEGORIES.has(data.statusCategory as string) || (via !== 'api' && via !== 'page')) return undefined;
  return { name: data.status, category: data.statusCategory as 'new' | 'indeterminate' | 'done', via };
}
