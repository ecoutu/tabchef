// Projects (M3 T15): the ProjectService (store: project-store.ts, closed-time clock: project-clock.ts), which resolves
// project membership each reconcile pass (T14's pure resolveProjects + projectTargets, planned as PlanContext.overrides,
// M3-R66), persists sticky membership with its rule in RuntimeState.projectTabs, and runs the user's project actions:
// add / remove a tab, open a linked PR, close the project's tabs, (M4 T7) close-and-save, reopen and Keep, and (M4 T9)
// archive, unarchive and delete. Ticket
// status and linked PRs come from the SourceService's public API only (M3-R68); linked PRs are refreshed at most every
// LINKED_REFRESH_MS per project.
import { liveProgram } from '../core/lang/dry-run';
import { managedGroupIds } from '../core/group/plan';
import { keyOf } from '../core/projects/url-key';
import { projectGroupTitle, projectTargets, resolveProjects, type ResolveResult, type StickyMap } from '../core/projects/resolve';
import type { RecentlyClosed } from '../core/safety/recently-closed';
import type { GroupTarget } from '../core/group/evaluate';
import type { Program, TabFacts } from '../core/lang/types';
import type { Project, ProjectAssignment, ProjectCardData, ProjectDef, ProjectHomeData, SavedProjectData, SavedTab } from '../core/projects/types';
import type { JiraIssue, PrInfo, PrState, SourceEntry } from '../core/sources/types';
import type { GroupColor, GroupSnap, Snapshot, TabSnap } from '../core/types';
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
const MANUAL_RECIPE = 'manual-project';
export const LINKED_REFRESH_MS = 15 * 60_000;
/** storage.session: ProjectService.lastMembers (M4-R21), so the first pass of a new worker compares with the last one. */
export const LAST_MEMBERS_KEY = 'projects.lastMembers';

const PILLS = new Set<PrState>(['open', 'draft', 'merged', 'closed']);
const CATEGORIES = new Set(['new', 'indeterminate', 'done']);
const PR_OWNER = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+\/pull\/\d+/;
const urlOf = (t: TabSnap): string => (t.pendingUrl ? t.pendingUrl : t.url);
const hostOf = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };
/** Whether `url` is the ticket page of `key` (path `/browse/<key>`): a ticket tab, unlike any other page of its site. */
function isTicketOf(url: string, key: string): boolean {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/\/$/, '') === `/browse/${key}`;
  } catch {
    return false;
  }
}
/**
 * projectId → the host of its ticket tab (M3-R110): a tab joined by a `jira.issue` rule at `/browse/<key>`, the lowest
 * tab id first, so the site never depends on the order of the assignments.
 */
function ticketSites(program: Program, snap: Snapshot, assignments: Map<number, ProjectAssignment>): Map<string, string> {
  const jira = new Set(program.rules.filter((r) => r.rule.source?.query === 'jira.issue').map((r) => r.key));
  const tabs = new Map(snap.tabs.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const [id, a] of [...assignments].sort(([x], [y]) => x - y)) {
    const t = tabs.get(id);
    const host = t && a.ruleKey !== undefined && jira.has(a.ruleKey) && isTicketOf(urlOf(t), a.key) ? hostOf(urlOf(t)) : undefined;
    if (host !== undefined && !out.has(a.projectId)) out.set(a.projectId, host);
  }
  return out;
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
/** The longest Manual project key: the R38 id pattern `^[a-z0-9][a-z0-9_-]{0,63}$`. */
const KEY_MAX = 64;
/**
 * A Manual project's key (M4 T6): the name's slug under the R38 id pattern. Accents are dropped, every other run of
 * characters becomes `-`; a name with no letter or digit left is `project`.
 */
function nameSlug(name: string): string {
  const s = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
  return s.slice(0, KEY_MAX).replace(/-+$/, '') || 'project';
}
/** `name`, else `name (2)`, `name (3)`, …, the first not in `taken` (M4-R12). */
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
}
/** `base`, else `base-2`, `base-3`, …, the first not in `taken`, shortened to fit KEY_MAX. */
function freeKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base.slice(0, KEY_MAX - `-${n}`.length).replace(/-+$/, '')}-${n}`;
    if (!taken.has(k)) return k;
  }
}
/** `tabs` in tab-bar order: windows in snapshot order, then the lowest tab index; tabs in index order. */
function tabBarOrder(snap: Snapshot, tabs: TabSnap[]): TabSnap[] {
  const winOrder = new Map(snap.windows.map((w, i) => [w.id, i]));
  const rank = (w: number): number => winOrder.get(w) ?? snap.windows.length;
  return [...tabs].sort((a, b) => rank(a.windowId) - rank(b.windowId) || a.windowId - b.windowId || a.index - b.index);
}
/** A saved tab list (M4 T7) of the tabs `ids`, in tab-bar order, each with its Chrome group's title. */
function savedTabs(snap: Snapshot, ids: Set<number>): SavedTab[] {
  return tabBarOrder(snap, snap.tabs.filter((t) => ids.has(t.id))).map((t) => {
    const group = t.groupId === -1 ? undefined : snap.groups.find((g) => g.id === t.groupId)?.title;
    return { url: urlOf(t), title: t.title, ...(group && { group }), ...(t.pinned && { pinned: true }) };
  });
}
/**
 * M4-R14: a frozen saved list (`saved.closed`) grown by the open members `open` (tab-bar order) not in it, nothing
 * removed. Each new tab goes right after the open member before it in the tab bar, else right before the first open
 * member of the list, else (no open member is in the list) at the end. M4-R21 uses it the other way round: the open
 * members grown by the saved URLs that stay, each placed by its neighbours in the saved list.
 */
function growFrozen(saved: SavedTab[], open: SavedTab[], key: (url: string) => string): SavedTab[] {
  const list = [...saved];
  let after = -1;
  let lead: SavedTab[] = [];
  for (const t of open) {
    const i = list.findIndex((x) => key(x.url) === key(t.url));
    if (i >= 0) {
      if (after < 0 && lead.length) { list.splice(i, 0, ...lead); after = i + lead.length; lead = []; } else after = i;
    } else if (after >= 0) list.splice(++after, 0, t);
    else if (!lead.some((x) => key(x.url) === key(t.url))) lead.push(t);
  }
  return [...list, ...lead];
}
/**
 * M4-R21/M4-R41: for each open member (`open[i]`), the index of the one saved entry it replaces, if any: the entry with
 * its exact URL (keyOf), else the first unclaimed one with its dedupe key (`key`) whose own URL was a member at the
 * previous pass (`wasMember`, M4-R43): such an entry leaves anyway, so a claim by key only places the new URL and keeps
 * its saved group, never decides which URLs stay. Every exact match is made first.
 */
function claimSaved(saved: SavedTab[], open: SavedTab[], key: (url: string) => string, wasMember: (url: string) => boolean): (number | undefined)[] {
  const taken = new Set<number>();
  const out: (number | undefined)[] = open.map(() => undefined);
  for (const match of [keyOf, key]) {
    for (const [i, t] of open.entries()) {
      if (out[i] !== undefined) continue;
      const k = match(t.url);
      const j = saved.findIndex((s, n) => !taken.has(n) && match(s.url) === k && (match === keyOf || wasMember(s.url)));
      if (j < 0) continue;
      taken.add(j);
      out[i] = j;
    }
  }
  return out;
}
/**
 * M4-R21: an unfrozen saved list (kept or not, M4-R51) `saved` refreshed by the open members `open` (tab-bar order),
 * given `before`, this project's members at the previous pass (keyOf → group title). Each open member replaces the
 * entry claimSaved gives it (keeping that entry's group unless the tab's group changed since the previous pass), a
 * saved URL whose tab was a member at the previous pass and is gone leaves, and every other saved URL stays at its
 * place. Used by the pass and by Close and save (M4-R44), so both record the same list.
 */
function refreshSaved(saved: SavedTab[], open: SavedTab[], before: Map<string, string> | undefined, key: (url: string) => string): SavedTab[] {
  const claim = claimSaved(saved, open, key, (u) => before?.has(keyOf(u)) ?? false);
  const current = open.map((t, i) => {
    const s = claim[i] === undefined ? undefined : saved[claim[i]];
    const was = before?.get(keyOf(t.url)) ?? (s && before?.get(keyOf(s.url)));
    if (!s || (was !== undefined && was !== (t.group ?? ''))) return t;
    const kept: SavedTab = { ...t };
    if (s.group === undefined) delete kept.group;
    else kept.group = s.group;
    return kept;
  });
  // The saved list with each claimed entry as its open tab (an anchor for growFrozen) and the entries that leave (their
  // own URL was a member at the previous pass, and nothing claimed them) dropped.
  const by = new Map(claim.flatMap((j, i) => (j === undefined ? [] : [[j, current[i]!] as const])));
  const stays = saved.flatMap((t, j) => by.get(j) ?? (before?.has(keyOf(t.url)) ? [] : [t]));
  return growFrozen(current, stays, keyOf);
}
/** Closed by Close group (M3-R84): kept for undo, out of membership and the UI. */
const isTomb = (p: Project): boolean => p.closedAt !== undefined;
const revive = (p: Project): void => { delete p.closedAt; delete p.closedIds; };
/** Archived by the user (M4 T9): takes no tab, and a rule assigning its key does not bring it back. */
const isArchived = (p: Project): boolean => p.archivedAt !== undefined;
type Run = ResolveResult & { held: Map<string, number[]> };
/**
 * `r` without the archived projects `archived` (M4 T9): resolveProjects created a copy of one whose key a rule assigned
 * (it was not given the archived ones); that copy, its tabs and their sticky entries are dropped, the tabs counted in
 * `held` (projectId → tab ids, "Archived: reopen?").
 */
function holdArchived(r: ResolveResult, archived: Set<string>): Run {
  const held = new Map<string, number[]>();
  const assignments = new Map<number, ProjectAssignment>();
  for (const [tabId, a] of r.assignments) {
    if (archived.has(a.projectId)) held.set(a.projectId, [...(held.get(a.projectId) ?? []), tabId]);
    else assignments.set(tabId, a);
  }
  return {
    assignments, held,
    created: r.created.filter((p) => !archived.has(p.id)),
    summaries: new Map([...r.summaries].filter(([id]) => !archived.has(id))),
    sticky: new Map([...r.sticky].filter(([, x]) => !archived.has(x.projectId))),
  };
}
/**
 * What makes a saved tab list differ for the user (M4 T7): URLs, order, groups and pinning, never titles (a title that
 * keeps changing would rewrite the store and bump updatedAt every pass).
 */
const savedShape = (tabs: SavedTab[]): string => JSON.stringify(tabs.map((t) => [t.url, t.group, t.pinned]));
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
  port: Pick<BrowserPort, 'snapshot' | 'createTab' | 'closeTab' | 'ungroup'>;
  getProgram: () => Promise<Program>;
  sources: Pick<SourceService, 'factsFor' | 'issues' | 'linkedFor' | 'jiraSite'>;
  facts: Pick<PageFacts, 'get'>;
  log: WhyLog;
  recentlyClosed: Pick<RecentlyClosed, 'add'>;
  /** Pinned, locked, form-edited (and audible / exempt) tabs are never closed by closeGroup or closeAndSave. */
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
  /** A recipe's display name, for the Project home (`home`). Default (or undefined): the recipe id. */
  recipeName?: (recipeId: string) => Promise<string | undefined>;
  now?: () => number;
}

interface Resolved { program: Program; defs: ProjectDef[]; projects: Project[]; assignments: Map<number, ProjectAssignment>; held: Map<string, number[]> }
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class ProjectService {
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly clock: ProjectClock;
  /**
   * M4-R21: projectId → the URLs (keyOf, M4-R41) of its member tabs at the previous live pass, each with its Chrome group's
   * title ('' ungrouped). Mirrored to storage.session (LAST_MEMBERS_KEY), so it survives worker restarts.
   */
  private lastMembers = new Map<string, Map<string, string>>();
  /** Whether lastMembers was read from storage.session by this worker. */
  private membersRead = false;

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

  /**
   * resolveProjects over `program` with this service's facts and prefixes, archived projects held out (holdArchived).
   * Pure apart from reading facts.
   */
  private run(snap: Snapshot, program: Program, stored: Project[], sticky: StickyMap): Run {
    const tabs = new Map(snap.tabs.map((t) => [t.id, t]));
    const archived = new Set(stored.filter(isArchived).map((p) => p.id));
    return holdArchived(resolveProjects({
      snap, program, now: this.now(), projects: stored.filter((p) => !isTomb(p) && !isArchived(p)), sticky,
      facts: (id): Partial<TabFacts> => {
        const t = tabs.get(id);
        const page = this.deps.facts.get(id);
        const source = t && this.deps.sources.factsFor(id, urlOf(t));
        return { ...(page && { page }), ...(source && { source }) };
      },
      allowPrefixes: (program.projects ?? []).flatMap((d) => strings(program.params?.[d.recipeId]?.projectPrefixes)),
      // A key the Jira API answered for confirms its prefix (Review Focus #5).
      knownPrefixes: new Set(stored.filter((p) => p.status?.via === 'api').map((p) => p.key.slice(0, Math.max(0, p.key.lastIndexOf('-'))))),
    }), archived);
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
      return { program, defs, projects: [], assignments: new Map(), held: new Map() };
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
      for (const p of revived) { revive(p); p.updatedAt = this.now(); }
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
      // Every saved tab list follows its project's open tabs (M4 T7), so it keeps the list of the last pass that saw
      // tabs once the user closes them all. A saved URL leaves the list only when its tab was a member at the
      // previous pass and is gone now (M4-R21): one not seen open since the browser started (its tab was still open
      // when Chrome quit, and the session was not restored) stays at its place, and a new member is added at its
      // tab-bar place. A list frozen by close-and-save (`closed`, M4-R14) only grows until the open tabs cover it again
      // (reopen, a full undo, the user reopening them by hand). A title-only change is not written (nor bumps
      // updatedAt). A saved URL takes its open tab's group only when that tab's group changed since the previous pass;
      // otherwise it keeps the saved group. Saved URLs are told apart by keyOf (M4-R41), never by the dedupe key: each
      // open member replaces at most one saved entry, the one with its exact URL, else (a navigation, a redirect) the
      // first unclaimed one with its dedupe key whose own URL was a member at the previous pass (M4-R43). All exact
      // matches are made first, so a dedupe-key match never takes an entry another tab has exactly. A saved URL that
      // shares a dedupe key with an open tab but was never a member here (another thread of the page) stays.
      const key = (u: string): string => this.norm(program, u);
      const membersOf = new Map<string, Set<number>>();
      for (const [tabId, a] of r.assignments) membersOf.set(a.projectId, (membersOf.get(a.projectId) ?? new Set()).add(tabId));
      const members = new Map([...membersOf].map(([id, tabIds]) => [id, savedTabs(snap, tabIds)]));
      const last = await this.previousMembers();
      for (const p of projects) {
        const tabs = members.get(p.id);
        if ((!p.keep && !p.saved) || isTomb(p) || !tabs) continue;
        const openKeys = new Set(tabs.map((t) => key(t.url)));
        if (p.saved?.closed) {
          if (p.saved.tabs.some((t) => !openKeys.has(key(t.url)))) {
            // M4-R14: frozen while the open tabs do not cover the list: it only grows.
            const grown = growFrozen(p.saved.tabs, tabs, key);
            if (grown.length > p.saved.tabs.length) {
              p.saved = { tabs: grown, at: this.now(), closed: true };
              p.updatedAt = this.now();
              changed.add(p);
            }
            continue;
          }
          delete p.saved.closed;
          changed.add(p);
        }
        const next = refreshSaved(p.saved?.tabs ?? [], tabs, last.get(p.id), key);
        if (p.saved && savedShape(next) === savedShape(p.saved.tabs)) continue;
        p.saved = { tabs: next, at: this.now() };
        p.updatedAt = this.now();
        changed.add(p);
      }
      await this.storeMembers(new Map([...members].map(([id, tabs]) => [id, new Map(tabs.map((t) => [keyOf(t.url), t.group ?? '']))])));
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
    return { program, defs, projects, assignments: r.assignments, held: r.held };
  }

  /** lastMembers, read once per worker from storage.session (I3: an MV3 worker sleeps after any idle stretch). */
  private async previousMembers(): Promise<Map<string, Map<string, string>>> {
    if (this.membersRead || !this.deps.session) return this.lastMembers;
    this.membersRead = true;
    try {
      const v = await this.deps.session.get(LAST_MEMBERS_KEY);
      if (isObj(v)) {
        this.lastMembers = new Map(Object.entries(v).filter((e): e is [string, Record<string, unknown>] => isObj(e[1]))
          .map(([id, m]) => [id, new Map(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string'))]));
      }
    } catch (e) {
      console.warn('[tabchef] project members read failed', e);
    }
    return this.lastMembers;
  }

  private async storeMembers(next: Map<string, Map<string, string>>): Promise<void> {
    const json = (m: Map<string, Map<string, string>>) => Object.fromEntries([...m].map(([id, x]) => [id, Object.fromEntries(x)]));
    const changed = JSON.stringify(json(next)) !== JSON.stringify(json(this.lastMembers));
    this.lastMembers = next;
    if (changed) await this.deps.session?.set(LAST_MEMBERS_KEY, json(next)).catch((e: unknown) => console.warn('[tabchef] project members write failed', e));
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
    for (const q of changed) { q.manual = q.manual.filter((m) => m.tabId !== tabId); q.updatedAt = this.now(); }
    const key = this.norm(program, url);
    p.excluded = p.excluded.filter((u) => u !== key);
    p.manual = [...p.manual.filter((m) => m.tabId !== tabId), { url, windowId, tabId }];
    p.updatedAt = this.now();
    await this.deps.store.put(p, ...changed);
    this.log(tabId, `Joined ${p.key} manually`);
    this.deps.schedule?.('project');
  }

  private async project(id: string): Promise<{ program: Program; projects: Project[]; p: Project }> {
    const [program, projects] = await Promise.all([this.deps.getProgram(), this.deps.store.list()]);
    const p = projects.find((x) => x.id === id && !isTomb(x));
    if (!p) throw new Error('unknown project');
    if (isArchived(p)) throw new Error('this project is archived');
    return { program, projects, p };
  }

  /**
   * The def of a recipe whose projects start on request (M4 T6). Throws when the recipe is off (or unknown), naming it
   * as the Recipes page does, or when its projects start by themselves.
   */
  private async onRequest(program: Program, recipeId: string): Promise<ProjectDef> {
    const def = program.projects?.find((d) => d.recipeId === recipeId);
    if (!def) throw new Error(`turn on the recipe ${(await this.deps.recipeName?.(recipeId)) ?? recipeId} first`);
    if (def.start !== 'on-request') throw new Error('this project starts by itself');
    return def;
  }

  /**
   * A new named project of an on-request recipe (M4 T6: Manual projects, `manual-project`), kept (`keep`), with
   * `tabIds` as its manual members (each leaves its previous project). The name is made unique (M4-R12): one equal to
   * another stored project's name (closed ones too) or an open project's title becomes `Name (2)`, `Name (3)`, …, so
   * its group title never merges it with another project's group. The key is the unique name's slug (`-2`, `-3`, …
   * when taken, by a closed project too). User-initiated, so it applies under global dry run too (R50), like addTab; the
   * dry-run reconciler then groups nothing. Returns the project id.
   */
  create(recipeId: string, name: string, tabIds: number[] = []): Promise<string> {
    return this.serial(() => this.createLocked(recipeId, name, tabIds));
  }

  /** `create`'s body, inside the queue. `existing`: a Chrome group the project adopts (M4 T8), see `saveGroup`. */
  private async createLocked(recipeId: string, name: string, tabIds: number[], existing?: GroupSnap): Promise<string> {
    {
      const title = name.trim();
      if (!title) throw new Error('a project needs a name');
      const program = await this.deps.getProgram();
      await this.onRequest(program, recipeId);
      const snap = await this.deps.port.snapshot();
      const tabs = tabIds.map((id) => {
        const t = snap.tabs.find((x) => x.id === id);
        if (!t) throw new Error('tab not found');
        return t;
      });
      // The open projects' titles, as their groups show them (this pass's membership).
      const open = await this.resolve(snap);
      const defOf = new Map(open.defs.map((d) => [d.recipeId, d]));
      const openIds = new Set([...open.assignments.values()].map((a) => a.projectId));
      const titles = open.projects.flatMap((q) => {
        const def = defOf.get(q.recipeId);
        return def && openIds.has(q.id) ? [projectGroupTitle(def, q)] : [];
      });
      const projects = await this.deps.store.list();
      const unique = freeName(title, new Set([...projects.flatMap((q) => q.name ?? []), ...titles]));
      // An adopted group keeps its title: a renamed project ("Taxes (2)") would retitle it (M4-R12), so refuse instead.
      if (existing && unique !== title) throw new Error(`A project named “${title}” already exists. Rename the group first, then save it.`);
      const key = freeKey(nameSlug(unique), new Set(projects.filter((q) => q.recipeId === recipeId).map((q) => q.key)));
      const p: Project = { id: `${recipeId}:${key}`, recipeId, key, name: unique, keep: true, ...(existing && { color: existing.color }), createdAt: this.now(), updatedAt: this.now(), manual: [], excluded: [], linked: [] };
      projects.push(p);
      if (tabs.length === 0) await this.deps.store.put(p);
      for (const t of tabs) await this.join(program, projects, p, t.id, t.windowId, urlOf(t));
      return p.id;
    }
  }

  /**
   * Saves a Chrome group as a kept Manual project (M4 T8): named after the group (an untitled group is refused, M4-R15), keeping the group's color (`Project.color`), with its tabs as manual members. Not regrouped, retitled or
   * recolored: when another project already has the name (M4-R12 would make it "Name (2)" and so retitle the group) it
   * is refused with a clear message. Refused too when a tab of the group already belongs to a project, when Tabchef
   * manages the group (a rule's, see managedGroups), or the Manual recipe is off. Applies under global dry run like create (M4-R11). Returns the project id.
   */
  saveGroup(groupId: number): Promise<string> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const g = snap.groups.find((x) => x.id === groupId);
      const tabs = snap.tabs.filter((t) => t.groupId === groupId);
      if (!g || tabs.length === 0) throw new Error('group not found');
      if (!g.title) throw new Error('Name the group first, then save it.'); // M4-R15: saving would retitle it
      if (g.title !== g.title.trim()) throw new Error('Remove the spaces around the group name first, then save it.');
      const open = await this.resolve(snap);
      if (tabs.some((t) => open.assignments.has(t.id))) throw new Error('This group is already part of a project.');
      // A group named like an open project is the name clash createLocked reports (M4-R12), not a rule's group.
      const defOf = new Map(open.defs.map((d) => [d.recipeId, d]));
      const openIds = new Set([...open.assignments.values()].map((a) => a.projectId));
      const named = new Set(open.projects.flatMap((q) => { const d = defOf.get(q.recipeId); return d && openIds.has(q.id) ? [projectGroupTitle(d, q)] : []; }));
      if (!named.has(g.title) && (await this.managedGroups(snap, open)).has(groupId)) throw new Error('This group is managed by a rule. Save one of your own groups.');
      return this.createLocked(MANUAL_RECIPE, g.title, tabs.map((t) => t.id), g);
    });
  }

  /**
   * The groups Tabchef manages (a rule's or a project's target, or a title it created or adopted), as the planner sees
   * them this pass: saving one would hand a rule's group to a project.
   */
  private async managedGroups(snap: Snapshot, open: Resolved): Promise<Set<number>> {
    const st = await this.deps.state();
    return managedGroupIds(snap, open.program, {
      leaveAlone: st.leaveAlone, managedTitles: st.managedTitles, overrides: projectTargets(open.assignments, open.projects, open.defs),
    });
  }

  /**
   * The open groups no project or rule holds (M4 T8), in snapshot order, for the dashboard's "Save a group" list. Empty when
   * Manual projects are off (nothing could be saved). An untitled group has title '' (it cannot be saved, M4-R15).
   */
  unmanagedGroups(): Promise<{ id: number; title: string; color: GroupColor; tabCount: number }[]> {
    return this.serial(async () => {
      if (!(await this.deps.getProgram()).projects?.some((d) => d.recipeId === MANUAL_RECIPE)) return [];
      const snap = await this.deps.port.snapshot();
      const open = await this.resolve(snap);
      const managed = await this.managedGroups(snap, open);
      return snap.groups.flatMap((g) => {
        const tabs = snap.tabs.filter((t) => t.groupId === g.id);
        if (tabs.length === 0 || managed.has(g.id) || tabs.some((t) => open.assignments.has(t.id))) return [];
        return [{ id: g.id, title: g.title, color: g.color, tabCount: tabs.length }];
      });
    });
  }

  /**
   * Starts the project `key` of a recipe with `start: 'on-request'` (M4 T6; the repo recipe, T17): stores it, so its
   * rules (`assignProject` without `create`) bring its tabs in; a closed one is revived. Already started: nothing
   * changes. User-initiated, so it applies under global dry run too (R50). Returns the project id.
   */
  start(recipeId: string, key: string): Promise<string> {
    return this.serial(async () => {
      const k = key.trim();
      if (!k) throw new Error('a project needs a key');
      const [program, projects] = await Promise.all([this.deps.getProgram(), this.deps.store.list()]);
      await this.onRequest(program, recipeId);
      const id = `${recipeId}:${k}`;
      const p = projects.find((x) => x.id === id);
      if (p && !isTomb(p)) return id;
      if (p) { revive(p); p.updatedAt = this.now(); }
      await this.deps.store.put(p ?? { id, recipeId, key: k, createdAt: this.now(), updatedAt: this.now(), manual: [], excluded: [], linked: [] });
      this.deps.schedule?.('project');
      return id;
    });
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
      // The user took this page out of the project: out of its saved list too, frozen or not (M4-R14).
      if (p.saved) p.saved = { ...p.saved, tabs: p.saved.tabs.filter((s) => this.norm(program, s.url) !== key) };
      p.updatedAt = this.now();
      (await this.deps.state()).projectTabs.delete(tabId);
      await this.deps.store.put(p);
      // A Manual-only project's group is not strict (a tab put into it stays), so the reconciler would leave this tab
      // there: ungroup it here (not under global dry run, R48).
      const def = program.projects?.find((d) => d.recipeId === p.recipeId);
      const manualOnly = def?.join.length === 1 && def.join[0] === 'manual';
      if (manualOnly && t.groupId !== -1 && !(await this.deps.getProgram()).dryRun) await this.deps.port.ungroup([tabId]).catch(() => undefined);
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
      if (isArchived(p)) throw new Error('this project is archived');
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
   * offered for all of them at once. A kept project (`keep`, M4 T7) with nothing open stays stored.
   */
  closeGroup(projectId: string): Promise<{ closed: number; skipped: number; ids: string[] }> {
    return this.serial(() => this.close(projectId, false));
  }

  /**
   * Close and save (M4 T7): records the project's open tabs as its saved tab list (tab-bar order, group titles; an
   * existing list keeps the saved URLs the pass keeps, M4-R44), keeps it (`keep`: never pruned) and closes them as
   * closeGroup does: protected tabs stay open and stay in the list, and undo revives a fully closed project (M3-R84).
   * With no tab open the previous list stays. A user action, so it applies under global dry run too (R50), as
   * closeGroup does.
   */
  closeAndSave(projectId: string): Promise<{ closed: number; skipped: number; ids: string[] }> {
    return this.serial(() => this.close(projectId, true));
  }

  private async close(projectId: string, save: boolean): Promise<{ closed: number; skipped: number; ids: string[] }> {
    const snap = await this.deps.port.snapshot();
    const { program, assignments, projects, defs } = await this.resolve(snap);
    const p = projects.find((x) => x.id === projectId);
    if (!p) throw new Error('unknown project');
    if (isArchived(p)) throw new Error('this project is archived');
    const def = defs.find((d) => d.recipeId === p.recipeId);
    const title = def ? projectGroupTitle(def, p) : (p.name ?? p.key); // as its card names it (a Manual one: its name)
    const ids: string[] = [];
    let skipped = 0;
    const members = snap.tabs.filter((x) => assignments.get(x.id)?.projectId === projectId);
    if (save) {
      p.keep = true;
      // Marked closed: the protected tabs left open never shrink the list until reopen. The list recorded is the one
      // the pass keeps (M4-R44), never only the tabs open here: a list already frozen by an earlier Close and save (a
      // protected tab stayed open) only grows (M4-R14), or a second one would drop the tabs the first one closed; any
      // other list, kept or not (the pass maintains both, M4-R51), gets the M4-R21 refresh (under global dry run too,
      // where no pass ran), so a saved URL not open here since the browser started (a variant reopen skips) stays and
      // only a close this device saw removes one; a project with no list records its open tabs.
      if (members.length > 0) {
        const open = savedTabs(snap, new Set(members.map((t) => t.id)));
        const key = (u: string): string => this.norm(program, u);
        const tabs = p.saved?.closed ? growFrozen(p.saved.tabs, open, key)
          : p.saved ? refreshSaved(p.saved.tabs, open, (await this.previousMembers()).get(p.id), key)
          : open;
        p.saved = { tabs, at: this.now(), closed: true };
      } else if (p.saved) p.saved.closed = true;
      p.updatedAt = this.now();
      await this.deps.store.put(p); // before closing: a worker restart mid-close keeps the list
    }
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
      p.updatedAt = this.now();
      await this.deps.store.put(p);
    } else if (save) await this.deps.store.put(p);
    else if (skipped === 0 && !p.keep) await this.deps.store.remove(projectId); // nothing open: nothing to undo
    this.deps.schedule?.('project');
    if (ids.length > 0 && this.deps.toast) {
      const after = await this.deps.port.snapshot();
      const focused = after.tabs.find((t) => t.active && after.windows.some((w) => w.focused && w.id === t.windowId));
      this.deps.toast(ids, `Closed ${ids.length} ${ids.length === 1 ? 'tab' : 'tabs'} with project ${title}.`, focused);
    }
    return { closed: ids.length, skipped, ids };
  }

  /**
   * Reopens the project's saved tab list (M4 T7) in background tabs, in saved order (the reconciler then groups them),
   * in the window holding its open tabs, else the last window that held it (its newest manual entry's), else the
   * focused one (placement: T16). A saved URL already open (dedupe's normalization) is not opened again: that tab joins
   * instead. Each tab joins as a manual member when the recipe takes them (else by its rules). A closed (tombstoned)
   * project is revived, an archived one unarchived (M4 T9: "Archived: reopen?"). A user action, so it applies under global dry run too (R50). Returns how many tabs it opened.
   * A saved tab that can't open in that window (closed meanwhile) is tried once more in Chrome's own choice of window. A
   * saved tab Chrome still refuses (a `javascript:` URL) never stops the others: `failed` counts them (absent when none
   * failed).
   */
  reopen(projectId: string): Promise<{ opened: number; failed?: number }> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { program, projects, assignments } = await this.resolve(snap);
      const p = projects.find((x) => x.id === projectId);
      if (!p) throw new Error('unknown project');
      const def = program.projects?.find((d) => d.recipeId === p.recipeId);
      if (!def) throw new Error(`turn on the recipe ${(await this.deps.recipeName?.(p.recipeId)) ?? p.recipeId} first`);
      const normal = new Set(snap.windows.filter((w) => w.type === 'normal').map((w) => w.id));
      const windowId = snap.tabs.find((t) => assignments.get(t.id)?.projectId === projectId && normal.has(t.windowId))?.windowId
        ?? [...p.manual].reverse().find((m) => normal.has(m.windowId))?.windowId
        ?? snap.windows.find((w) => w.focused && normal.has(w.id))?.id;
      const saved = p.saved?.tabs ?? [];
      revive(p);
      delete p.archivedAt;
      // Frozen until the open tabs cover the list again (the pass then thaws it): a tab that fails to open or
      // redirects before the next pass (leaving its URL-matched manual entry) never shrinks it.
      if (p.saved && p.saved.tabs.length > 0) p.saved.closed = true;
      p.updatedAt = this.now();
      await this.deps.store.put(p);
      const manual = def.join.includes('manual');
      const openAt = new Map<string, TabSnap>();
      for (const t of snap.tabs) {
        const k = this.norm(program, urlOf(t));
        if (normal.has(t.windowId) && !t.incognito && !openAt.has(k)) openAt.set(k, t);
      }
      const seen = new Set<string>();
      let opened = 0;
      let failed = 0;
      for (const s of saved) {
        const k = this.norm(program, s.url);
        if (seen.has(k)) continue;
        seen.add(k);
        const t = openAt.get(k);
        if (t) {
          if (manual && assignments.get(t.id)?.projectId !== projectId) await this.join(program, projects, p, t.id, t.windowId, urlOf(t));
          continue;
        }
        let tabId: number | undefined;
        let into = windowId;
        try {
          tabId = await this.deps.port.createTab({ url: s.url, active: false, ...(into !== undefined && { windowId: into }) });
        } catch {
          // The window may have closed meanwhile: one retry in Chrome's own choice of window.
          if (into !== undefined) {
            into = undefined;
            tabId = await this.deps.port.createTab({ url: s.url, active: false }).catch(() => undefined);
          }
        }
        if (tabId === undefined) {
          failed++;
          continue;
        }
        opened++;
        if (!manual) continue;
        const at = into ?? (await this.deps.port.snapshot()).tabs.find((x) => x.id === tabId)?.windowId ?? -1;
        await this.join(program, projects, p, tabId, at, s.url);
      }
      this.deps.schedule?.('project');
      return { opened, ...(failed > 0 && { failed }) };
    });
  }

  /** Keep (M4 T7): a kept project is never pruned and is synced (D2). A closed project can be kept too. */
  setKeep(projectId: string, keep: boolean): Promise<void> {
    return this.serial(async () => {
      const p = (await this.deps.store.list()).find((x) => x.id === projectId);
      if (!p) throw new Error('unknown project');
      if (keep) p.keep = true;
      else delete p.keep;
      p.updatedAt = this.now();
      await this.deps.store.put(p);
    });
  }

  /**
   * Archive (M4 T9) a project with nothing open (a saved one, or one closed by Close group): it then takes no tab, is
   * not in the popup and is never pruned. A closed one loses its undo (archiving is a later, deliberate choice). Refused
   * while tabs of it are open: Close and archive closes them. A user action, so it applies under global dry run (M4-R11).
   */
  archive(projectId: string): Promise<void> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { assignments } = await this.resolve(snap);
      const p = (await this.deps.store.list()).find((x) => x.id === projectId);
      if (!p) throw new Error('unknown project');
      if ([...assignments.values()].some((a) => a.projectId === projectId)) throw new Error("Close the project's tabs first.");
      if (isArchived(p)) return;
      revive(p);
      p.archivedAt = this.now();
      p.updatedAt = this.now();
      await this.deps.store.put(p);
      this.deps.schedule?.('project');
    });
  }

  /**
   * Close and archive (M4 T9, offered when its Jira ticket is Done by fresh data, M3-R90): Close and save, then archive.
   * Protected tabs stay open (and in the saved list) but leave the project. The undo of its closes brings it back,
   * unarchived (onUndo). Applies under global dry run, as closeAndSave does.
   */
  closeAndArchive(projectId: string): Promise<{ closed: number; skipped: number; ids: string[] }> {
    return this.serial(async () => {
      const r = await this.close(projectId, true);
      const p = (await this.deps.store.list()).find((x) => x.id === projectId);
      if (!p) return r;
      delete p.closedAt; // archived, not a tombstone: kept and listed; closedIds stay for undo
      if (r.ids.length > 0) p.closedIds = r.ids;
      p.archivedAt = this.now();
      p.updatedAt = this.now();
      await this.deps.store.put(p);
      this.deps.schedule?.('project');
      return r;
    });
  }

  /** Unarchive (M4 T9): back among the saved projects; tabs a rule assigns its key to join it on the next pass. */
  unarchive(projectId: string): Promise<void> {
    return this.serial(async () => {
      const p = (await this.deps.store.list()).find((x) => x.id === projectId);
      if (!p) throw new Error('unknown project');
      if (!isArchived(p)) return;
      delete p.archivedAt;
      delete p.closedIds;
      p.updatedAt = this.now();
      await this.deps.store.put(p);
      this.deps.schedule?.('project');
    });
  }

  /** Delete (M4 T9): forgets the project for good (the UI asks first, M4-R9). Refused while tabs of it are open. */
  remove(projectId: string): Promise<void> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { assignments } = await this.resolve(snap);
      if (!(await this.deps.store.list()).some((x) => x.id === projectId)) throw new Error('unknown project');
      if ([...assignments.values()].some((a) => a.projectId === projectId)) throw new Error("Close the project's tabs first.");
      await this.deps.store.remove(projectId);
      this.deps.schedule?.('project');
    });
  }

  /**
   * The Projects page's Saved and Archived sections (M4 T9), newest change first. Saved: kept projects with nothing
   * open (closed by Close and save, or created without tabs), not archived. Archived: every archived project, with the
   * open tabs a rule assigns its key to (`held`).
   */
  savedLists(): Promise<{ saved: SavedProjectData[]; archived: SavedProjectData[] }> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { defs, assignments, held } = await this.resolve(snap);
      const open = new Set([...assignments.values()].map((a) => a.projectId));
      const defOf = new Map(defs.map((d) => [d.recipeId, d]));
      const data = (p: Project): SavedProjectData => {
        const def = defOf.get(p.recipeId);
        return {
          id: p.id, key: p.key, title: def ? projectGroupTitle(def, p) : (p.name ?? p.key), ...(p.summary !== undefined && { summary: p.summary }),
          ...(p.status && { status: p.status }), savedCount: p.saved?.tabs.length ?? 0, ...(isArchived(p) && { archivedAt: p.archivedAt }),
          held: held.get(p.id)?.length ?? 0, updatedAt: p.updatedAt,
        };
      };
      const stored = (await this.deps.store.list()).sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        saved: stored.filter((p) => p.keep && !isArchived(p) && !open.has(p.id)).map(data),
        archived: stored.filter(isArchived).map(data),
      };
    });
  }

  /**
   * SafetyService.beforeUndo: a recently-closed entry of a Close group is about to be reopened. Revives its tombstone
   * first, so the restored tab rejoins the same project (rules by key, manual entries by URL). The undo of a Close and
   * archive (M4 T9) unarchives it too.
   */
  onUndo(entryId: string): Promise<void> {
    return this.serial(async () => {
      const p = (await this.deps.store.list()).find((x) => (isTomb(x) || isArchived(x)) && x.closedIds?.includes(entryId));
      if (!p) return;
      revive(p);
      delete p.archivedAt;
      p.updatedAt = this.now();
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
    return (await this.collect()).cards;
  }

  /**
   * One open project's home page (`projects.home`, M4 T4): its card, through cards()' path for that project alone, plus
   * its groups in tab-bar order, its settings and its recipe's name. A kept or saved project with no open tab (M4 T7)
   * has its stored card data, no tabs and no groups. Undefined when it is unknown, or closed or without tabs and neither
   * kept nor saved.
   */
  async home(id: string): Promise<ProjectHomeData | undefined> {
    const { cards, snap, open, defOf, held } = await this.collect(id);
    const card = cards[0];
    if (!card) return this.restingHome(id, defOf, held.get(id)?.length ?? 0);
    const def = defOf.get(open[0]?.recipeId ?? '');
    if (!def) return undefined;
    const members = new Set(card.tabs.map((t) => t.tabId));
    // Tabs in tab-bar order, so each group (window + Chrome group; -1: not in one) is first seen at its lowest index.
    const byGroup = new Map<string, TabSnap[]>();
    for (const t of tabBarOrder(snap, snap.tabs.filter((x) => members.has(x.id)))) {
      const k = `${t.windowId}:${t.groupId}`;
      byGroup.set(k, [...(byGroup.get(k) ?? []), t]);
    }
    const groups = [...byGroup.values()].map((ts): ProjectHomeData['groups'][number] => {
      const g = ts[0]!.groupId === -1 ? undefined : snap.groups.find((x) => x.id === ts[0]!.groupId);
      return { title: g?.title ?? '', color: g?.color ?? 'grey', windowId: ts[0]!.windowId, tabIds: ts.map((t) => t.id) };
    });
    return { ...card, groups, ...(await this.homeOf(def)), ...kept(open[0]!) };
  }

  /**
   * The Project home of a kept, saved or archived (M4 T9, with its `held` tabs) project with no open tab (M4 T7):
   * stored data, no tabs, no groups. With its recipe off (or gone) it still has one, from what is stored: titled by its
   * name else its key, no settings, `recipeOff` (it can be deleted or unarchived, not reopened).
   */
  private async restingHome(id: string, defOf: Map<string, ProjectDef>, held: number): Promise<ProjectHomeData | undefined> {
    const p = (await this.deps.store.list()).find((x) => x.id === id);
    if (!p || !(p.keep || p.saved || isArchived(p))) return undefined;
    const def = defOf.get(p.recipeId);
    const recipe = def
      ? await this.homeOf(def)
      : { recipeName: (await this.deps.recipeName?.(p.recipeId)) ?? p.recipeId, recipeOff: true as const };
    return {
      id: p.id, key: p.key, title: def ? projectGroupTitle(def, p) : (p.name ?? p.key), ...(p.summary !== undefined && { summary: p.summary }),
      ...(p.status && { status: p.status }), done: false, tabs: [], linked: p.linked, groups: [], ...recipe, ...kept(p),
      ...(isArchived(p) && { archivedAt: p.archivedAt, held }),
    };
  }

  private async homeOf(def: ProjectDef): Promise<Pick<ProjectHomeData, 'settings' | 'recipeName'>> {
    const { container, placement, join, onOpenElsewhere, onSwitchAway } = def;
    const recipeName = (await this.deps.recipeName?.(def.recipeId)) ?? def.recipeId;
    return { settings: { container, placement, join, onOpenElsewhere, onSwitchAway }, recipeName };
  }

  /**
   * The cards of the open projects (`only`: of that project alone, so only its ticket and linked PRs are fetched), with
   * the snapshot and the plan they were built from.
   */
  private async collect(only?: string): Promise<{ cards: ProjectCardData[]; snap: Snapshot; open: Project[]; defOf: Map<string, ProjectDef>; held: Map<string, number[]> }> {
    const plan = await this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { program, defs, projects, assignments, held } = await this.resolve(snap);
      const tabsOf = new Map<string, TabSnap[]>();
      for (const t of snap.tabs) {
        const id = assignments.get(t.id)?.projectId;
        if (id !== undefined) tabsOf.set(id, [...(tabsOf.get(id) ?? []), t]);
      }
      const defOf = new Map(defs.map((d) => [d.recipeId, d]));
      const open = projects.filter((p) => (only === undefined || p.id === only) && tabsOf.has(p.id) && defOf.has(p.recipeId));
      return { snap, program, defOf, tabsOf, sites: ticketSites(program, snap, assignments), open, held };
    });
    const { snap, program, defOf, tabsOf, sites, open, held } = plan;
    if (open.length === 0) return { cards: [], snap, open, defOf, held };
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
      return { cards, snap, open, defOf, held };
    });
  }

  /**
   * Ticket status through SourceService.issues for the projects on the Jira connection's site only (M3-R110): a ticket
   * tab (`/browse/<key>`) on that site, else the project's ticket site (stored, else its ticket tab's now) is it, or
   * none is known (a PR-only project). Any other page of that site (a dashboard) says nothing about the ticket. A
   * same-key ticket on another site is another issue: its status comes from its own tab's page.
   */
  private async fetchIssues(open: Project[], tabsOf: Map<string, TabSnap[]>, sites: Map<string, string>): Promise<{ issues: Map<string, SourceEntry<JiraIssue>>; asked: Set<string> }> {
    const site = await this.deps.sources.jiraSite();
    const on = site === undefined ? [] : open.filter((p) => tabsOf.get(p.id)!.some((t) => hostOf(urlOf(t)) === site && isTicketOf(urlOf(t), p.key)) || (p.site ?? sites.get(p.id) ?? site) === site);
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

/** A project's Keep and saved tab list, as the Project home shows them (M4 T7). */
function kept(p: Project): Pick<ProjectHomeData, 'keep' | 'saved'> {
  return { ...(p.keep && { keep: true }), ...(p.saved && { saved: p.saved }) };
}

/** A Jira status from source data (`status` + `statusCategory`), or undefined when either is missing. */
function statusOf(data: unknown, via: SourceEntry['via'] | undefined): Project['status'] {
  if (!isObj(data) || typeof data.status !== 'string' || !CATEGORIES.has(data.statusCategory as string) || (via !== 'api' && via !== 'page')) return undefined;
  return { name: data.status, category: data.statusCategory as 'new' | 'indeterminate' | 'done', via };
}
