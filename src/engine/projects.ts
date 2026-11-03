// Projects (M3 T15): the ProjectService (store: project-store.ts, closed-time clock: project-clock.ts), which resolves
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
import type { JiraIssue, PrInfo, PrState, SourceEntry } from '../core/sources/types';
import type { Snapshot, TabSnap } from '../core/types';
import { normalizeUrl } from '../core/url/normalize';
import type { BrowserPort } from '../platform/browser-port';
import type { PageFacts } from './page-facts';
import type { WhyLog } from './reconciler';
import type { SafetyService } from './safety';
import type { SourceService } from './sources';
import { ProjectClock } from './project-clock';
import type { ProjectStore } from './project-store';
import { saveState, type LiveState } from './state';

export { PROJECTS_KEY, ProjectStore } from './project-store';
export { CLOSED_CLOCK_KEY, PRUNE_AFTER_MS } from './project-clock';
/** Linked-PR searches per project at most this often (spec: 15 min). */
export const LINKED_REFRESH_MS = 15 * 60_000;

const PILLS = new Set<PrState>(['open', 'draft', 'merged', 'closed']);
const CATEGORIES = new Set(['new', 'indeterminate', 'done']);
const PR_OWNER = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+\/pull\/\d+/;
const urlOf = (t: TabSnap): string => (t.pendingUrl ? t.pendingUrl : t.url);
const hostOf = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };
/** projectId → the host of its first tab joined by a `jira.issue` rule (its ticket tab, M3-R110). */
function ticketSites(program: Program, snap: Snapshot, assignments: Map<number, ProjectAssignment>): Map<string, string> {
  const jira = new Set(program.rules.filter((r) => r.rule.source?.query === 'jira.issue').map((r) => r.key));
  const tabs = new Map(snap.tabs.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const [id, a] of assignments) {
    const t = tabs.get(id);
    const host = t && a.ruleKey !== undefined && jira.has(a.ruleKey) ? hostOf(urlOf(t)) : undefined;
    if (host !== undefined && !out.has(a.projectId)) out.set(a.projectId, host);
  }
  return out;
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
/** Closed by Close group (M3-R84): kept for undo, out of membership and the UI. */
const isTomb = (p: Project): boolean => p.closedAt !== undefined;
const revive = (p: Project): void => { delete p.closedAt; delete p.closedIds; };
/**
 * The projects of a pass: the stored ones plus those resolveProjects created, where a created project whose key has a
 * tombstone is that stored record (`revived`, not yet revived), never the bare copy (live and preview agree on it).
 */
function withCreated(stored: Project[], r: ResolveResult): { projects: Project[]; created: Project[]; revived: Project[] } {
  const tombs = new Map(stored.filter(isTomb).map((p) => [p.id, p]));
  const revived = r.created.flatMap((c) => tombs.get(c.id) ?? []);
  const created = r.created.filter((c) => !tombs.has(c.id));
  return { projects: [...stored, ...created], created, revived };
}
export interface ProjectServiceDeps {
  store: ProjectStore;
  port: Pick<BrowserPort, 'snapshot' | 'createTab' | 'closeTab'>;
  getProgram: () => Promise<Program>;
  sources: Pick<SourceService, 'factsFor' | 'issues' | 'linkedFor' | 'jiraSite'>;
  facts: Pick<PageFacts, 'get'>;
  log: WhyLog;
  recentlyClosed: Pick<RecentlyClosed, 'add'>;
  /** Pinned, locked, form-edited (and audible / exempt) tabs are never closed by closeGroup. */
  safety: Pick<SafetyService, 'isProtected'>;
  /** The reconciler's LiveState (Reconciler.liveState): sticky membership lives in its RuntimeState. */
  state: () => Promise<LiveState>;
  /**
   * After Close group: offer M1's undo (banner, else notification) for all its entries in the newly focused tab
   * (SafetyService.toastGroup). Default: none (the popup's own toast only).
   */
  toast?: (entryIds: string[], text: string, focused: TabSnap | undefined) => void;
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
  private readonly clock: ProjectClock;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.clock = new ProjectClock(deps.session, this.now);
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
    return projectTargets(r.assignments, withCreated(stored, r).projects, defs);
  }

  /** resolveProjects over `program` with this service's facts and prefixes. Pure apart from reading facts. */
  private run(snap: Snapshot, program: Program, stored: Project[], sticky: StickyMap): ResolveResult {
    const tabs = new Map(snap.tabs.map((t) => [t.id, t]));
    return resolveProjects({
      snap, program, now: this.now(), projects: stored.filter((p) => !isTomb(p)), sticky,
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
    // A rule assigning a tombstoned key again revives the stored project rather than replacing it.
    const pass = withCreated(stored, r);
    const { created, revived } = pass;
    let projects = pass.projects;
    const open = new Set([...r.assignments.values()].map((a) => a.projectId));
    if (!full.dryRun) {
      const changed = new Set<Project>([...created, ...revived]);
      for (const p of revived) revive(p);
      if (revived.length) this.deps.schedule?.('project'); // its manual entries take their tabs on the next pass
      for (const p of projects) {
        const summary = r.summaries.get(p.id);
        if (summary !== undefined && p.summary === undefined) { p.summary = summary; changed.add(p); }
      }
      const sites = ticketSites(program, snap, r.assignments);
      for (const p of projects) {
        const site = sites.get(p.id);
        if (site !== undefined && p.site === undefined) { p.site = site; changed.add(p); }
      }
      const removed = await this.clock.closedTime(snap, projects, open, changed);
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
    // Tombstones are never offered (addTab rejects them); under dry run none was revived.
    this.deps.onProjectsChanged?.((full.dryRun ? stored.filter((p) => !isTomb(p)) : projects).flatMap((p) => {
      const def = defOf.get(p.recipeId);
      return def && open.has(p.id) ? [{ id: p.id, title: projectGroupTitle(def, p) }] : [];
    }));
    return { program, defs, projects, assignments: r.assignments };
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
    const p = projects.find((x) => x.id === id && !isTomb(x));
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

  /**
   * Closes the project's tabs except protected ones, the active ones last (closing the active tab closes the popup).
   * When none remains the project becomes a tombstone (M3-R84), so undo restores it whole. `ids`: the closed tabs'
   * recently-closed entries, which the popup's Undo reopens (recent.undo); M1's undo (banner / notification) is
   * offered for all of them at once.
   */
  closeGroup(projectId: string): Promise<{ closed: number; skipped: number; ids: string[] }> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { assignments, projects } = await this.resolve(snap);
      const p = projects.find((x) => x.id === projectId);
      if (!p) throw new Error('unknown project');
      const ids: string[] = [];
      let skipped = 0;
      const members = snap.tabs.filter((x) => assignments.get(x.id)?.projectId === projectId);
      for (const t of [...members.filter((x) => !x.active), ...members.filter((x) => x.active)]) {
        if (this.deps.safety.isProtected(t)) { skipped++; continue; }
        try {
          await this.deps.port.closeTab(t.id);
        } catch {
          skipped++;
          continue;
        }
        const groupTitle = snap.groups.find((g) => g.id === t.groupId)?.title;
        ids.push(this.deps.recentlyClosed.add({
          url: urlOf(t), title: t.title, ...(groupTitle && { groupTitle }), windowId: t.windowId, reason: 'project-closed', at: this.now(),
        }));
        this.log(t.id, `Closed with project ${p.key}`, undefined, 'project-close');
      }
      if (skipped === 0 && ids.length > 0) {
        p.closedAt = this.now();
        p.closedIds = ids;
        await this.deps.store.put(p);
      } else if (skipped === 0) await this.deps.store.remove(projectId); // nothing open: nothing to undo
      this.deps.schedule?.('project');
      if (ids.length > 0 && this.deps.toast) {
        const after = await this.deps.port.snapshot();
        const focused = after.tabs.find((t) => t.active && after.windows.some((w) => w.focused && w.id === t.windowId));
        this.deps.toast(ids, `Closed ${ids.length} ${ids.length === 1 ? 'tab' : 'tabs'} of ${p.key} (project-closed).`, focused);
      }
      return { closed: ids.length, skipped, ids };
    });
  }

  /**
   * SafetyService.beforeUndo: a recently-closed entry of a Close group is about to be reopened. Revives its tombstone
   * first, so the restored tab rejoins the same project (rules by key, manual entries by URL).
   */
  onUndo(entryId: string): Promise<void> {
    return this.serial(async () => {
      const p = (await this.deps.store.list()).find((x) => isTomb(x) && x.closedIds?.includes(entryId));
      if (!p) return;
      revive(p);
      await this.deps.store.put(p);
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
      return { program, defOf, tabsOf, sites: ticketSites(program, snap, assignments), open: projects.filter((p) => tabsOf.has(p.id) && defOf.has(p.recipeId)) };
    });
    const { program, defOf, tabsOf, sites, open } = plan;
    if (open.length === 0) return [];
    const now = this.now();
    const [linked, { issues, asked }] = await Promise.all([this.fetchLinked(program, open, tabsOf, now), this.fetchIssues(open, tabsOf, sites)]);
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
        const issue = asked.has(p.id) ? issues.get(p.key) : undefined;
        if (p.summary === undefined && issue?.data?.summary) p.summary = issue.data.summary;
        // M3-R90: the status shown may be last known (a stale entry, else the stored one), but only a fresh entry
        // (via api or page, not stale) says Done: stale or unknown data never drives the close prompt.
        const src = [issue, ...tabs.flatMap(factsOf)].find((e) => e && statusOf(e.data, e.via));
        const status = (src && statusOf(src.data, src.via)) ?? p.status;
        const done = src !== undefined && !src.stale && status?.category === 'done';
        if (status) p.status = status;
        if (JSON.stringify(p) !== before) changed.push(p);
        const openUrls = new Set(tabs.map((t) => this.norm(program, urlOf(t))));
        return [{
          id: p.id, key: p.key, title: projectGroupTitle(defOf.get(p.recipeId)!, p), ...(p.summary !== undefined && { summary: p.summary }),
          ...(status && { status }), done,
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
   * Ticket status through SourceService.issues for the projects on the Jira connection's site only (M3-R110): a tab
   * on that site, else the project's ticket site (stored, else its ticket tab's now) is it, or none is known (a
   * PR-only project). A same-key ticket on another site is another issue: its status comes from its own tab's page.
   */
  private async fetchIssues(open: Project[], tabsOf: Map<string, TabSnap[]>, sites: Map<string, string>): Promise<{ issues: Map<string, SourceEntry<JiraIssue>>; asked: Set<string> }> {
    const site = await this.deps.sources.jiraSite();
    const on = site === undefined ? [] : open.filter((p) => tabsOf.get(p.id)!.some((t) => hostOf(urlOf(t)) === site) || (p.site ?? sites.get(p.id) ?? site) === site);
    const issues = on.length ? await this.deps.sources.issues(on.map((p) => p.key)) : new Map<string, SourceEntry<JiraIssue>>();
    return { issues, asked: new Set(on.map((p) => p.id)) };
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
