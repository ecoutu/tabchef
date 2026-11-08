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
import { hasOwnTab, isOwnGroup, issueTitlePrefixes, projectGroupTitle, projectTargets, resolveProjects, type ResolveResult, type StickyMap } from '../core/projects/resolve';
import { parseIssueKey } from '../core/keys/github-issue';
import type { RecentlyClosed } from '../core/safety/recently-closed';
import type { GroupTarget } from '../core/group/evaluate';
import type { Program, TabFacts } from '../core/lang/types';
import type { DoneProject, NamedProject, Project, ProjectAssignment, ProjectCardData, ProjectDef, ProjectHomeData, ProjectImportResult, SavedProjectData, SavedTab } from '../core/projects/types';
import type { GithubIssueInfo, JiraIssue, PrInfo, PrState, SourceEntry } from '../core/sources/types';
import type { GroupColor, GroupSnap, Snapshot, TabSnap } from '../core/types';
import { normalizeUrl } from '../core/url/normalize';
import type { BrowserPort } from '../platform/browser-port';
import type { PageFacts } from './page-facts';
import type { WhyLog } from './reconciler';
import type { SafetyService } from './safety';
import type { SourceService } from './sources';
import { DoneProjects } from './done-projects';
import { ProjectClock } from './project-clock';
import { parseProject, type ProjectStore } from './project-store';
import { saveState, type LiveState } from './state';

export { PROJECTS_KEY, ProjectStore } from './project-store';
export { CLOSED_CLOCK_KEY, PRUNE_AFTER_MS } from './project-clock';
/** Linked-PR searches per project at most this often (spec: 15 min). */
const MANUAL_RECIPE = 'manual-project';
export const LINKED_REFRESH_MS = 15 * 60_000;
/** storage.session: ProjectService.lastMembers (M4-R21), so the first pass of a new worker compares with the last one. */
export const LAST_MEMBERS_KEY = 'projects.lastMembers';
/**
 * storage.session flag, set by runtime.onStartup (ProjectService.browserStarted) and cleared once ProjectService.dropStaleIds
 * has checked the stored manual tab ids: true => those ids are from the previous browser session. An extension update or
 * reload, a worker restart, or turning global dry run or a recipe on or off never sets it: tab ids are still valid then.
 */
export const IDS_STALE_KEY = 'projects.idsStale';

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
/**
 * Gives manual entries (`p.manual[index]`, `p` one of `all`) a new tab id, in place: the rebound write-back, bindUndone and
 * onReplaced (#150). A tab id names at most one manual entry across all stored projects, tombstoned and archived ones
 * included (M4-R58), because join and removeTab drop every entry holding it: an id some entry already holds is not
 * given. Returns the projects it changed.
 */
function setTabIds(all: Project[], moves: { p: Project; index: number; tabId: number }[]): Set<Project> {
  const changed = new Set<Project>();
  for (const { p, index, tabId } of moves) {
    if (!p.manual[index] || all.some((x) => x.manual.some((m) => m.tabId === tabId))) continue;
    p.manual = p.manual.map((m, i) => (i === index ? { ...m, tabId } : m));
    changed.add(p);
  }
  return changed;
}
/** Every manual entry of `ps` that `match` accepts, as setTabIds moves to `tabId`. */
const movesOf = (ps: Project[], match: (m: Project['manual'][number]) => boolean, tabId: number) =>
  ps.flatMap((p) => p.manual.flatMap((m, index) => (match(m) ? [{ p, index, tabId }] : [])));
/**
 * Where the Projects page lists a stored project (M4 T9), `open` being the projects with a tab this pass: an open card,
 * Saved (kept, nothing open) or Archived. Undefined: listed nowhere (not kept, nothing open), so it waits only to be
 * pruned (project-clock.ts) or revived by an undo.
 */
function listedAs(p: Project, open: Set<string>): 'Open' | 'Saved' | 'Archived' | undefined {
  if (isArchived(p)) return 'Archived';
  if (open.has(p.id)) return 'Open';
  return p.keep ? 'Saved' : undefined;
}
/**
 * `p` without its device-local state, as a backup file carries it: the live tab id of each manual entry, the closed-time
 * clock and the Close group tombstone with its recently-closed (undo) entries.
 */
function portable(p: Project): Project {
  const q = structuredClone(p);
  delete q.closedAt;
  delete q.closedIds;
  delete q.closedFor;
  for (const m of q.manual) delete m.tabId;
  return q;
}
/** How a backup import names an entry it dropped: its name, else its id, else its 1-based position in the file. */
function dropLabel(x: unknown, i: number): string {
  const o = typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
  return typeof o.name === 'string' ? o.name : typeof o.id === 'string' ? o.id : `#${i + 1}`;
}
/**
 * `held`: projectId → archived tabs (holdArchived). `heldTabIds`: the tab ids manual entries of every stored project hold,
 * tombstoned and archived ones included (resolveProjects' heldTabIds, M4-R58).
 */
type Run = ResolveResult & { held: Map<string, number[]>; heldTabIds: ReadonlySet<number> };
/**
 * `r` without the archived projects `archived` (M4 T9): resolveProjects created a copy of one whose key a rule assigned
 * (it was not given the archived ones); that copy, its tabs and their sticky entries are dropped, the tabs counted in
 * `held` (projectId → tab ids, "Archived: reopen?").
 */
function holdArchived(r: ResolveResult, archived: Set<string>): Omit<Run, 'heldTabIds'> {
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
    rebound: r.rebound,
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
  sources: Pick<SourceService, 'factsFor' | 'issues' | 'linkedFor' | 'jiraSite' | 'githubIssues'>;
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
  /**
   * After each pass: the open projects and their group titles (the Projects tab's count). The "Add to project"
   * submenu lists more (`menuItems`).
   */
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

interface Resolved {
  program: Program; defs: ProjectDef[]; projects: Project[]; assignments: Map<number, ProjectAssignment>; held: Map<string, number[]>;
  /** Run's heldTabIds: the tab ids stored manual entries hold (tombstoned and archived ones included). */
  heldTabIds: ReadonlySet<number>;
}
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
  /** The projects with a tab at the last pass (what onProjectsChanged reports): the submenu lists them (`menuItems`). */
  private lastOpen = new Set<string>();
  /** #195: the done projects of the last listing and the kept Done prompts (storage.session). */
  private readonly done: DoneProjects;
  /** IDS_STALE_KEY as this worker knows it; undefined until read. */
  private idsStale?: boolean;
  /** dropStaleIds swept, but writing IDS_STALE_KEY = false to storage.session failed: the next pass writes it again. */
  private idsClearUnwritten = false;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.clock = new ProjectClock(deps.session, this.now);
    this.done = new DoneProjects(deps.session);
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
    const heldTabIds = new Set(stored.flatMap((p) => p.manual.flatMap((m) => (m.tabId === undefined ? [] : [m.tabId]))));
    const r = holdArchived(resolveProjects({
      snap, program, now: this.now(), projects: stored.filter((p) => !isTomb(p) && !isArchived(p)), sticky, heldTabIds,
      facts: (id): Partial<TabFacts> => {
        const t = tabs.get(id);
        const page = this.deps.facts.get(id);
        const source = t && this.deps.sources.factsFor(id, urlOf(t));
        return { ...(page && { page }), ...(source && { source }) };
      },
      allowPrefixes: (program.projects ?? []).flatMap((d) => strings(program.params?.[d.recipeId]?.projectPrefixes)),
      // A key the Jira API answered for confirms its prefix (Review Focus #5); a GitHub issue key confirms none.
      knownPrefixes: new Set(stored.filter((p) => p.status?.via === 'api' && !parseIssueKey(p.key)).map((p) => p.key.slice(0, Math.max(0, p.key.lastIndexOf('-'))))),
    }), archived);
    return { ...r, heldTabIds };
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
    // Before the no-projects return and under global dry run too: the ids are stale whatever the settings say.
    await this.dropStaleIds(snap, program);
    if (defs.length === 0) {
      this.lastOpen = new Set();
      await this.done.retain(this.lastOpen);
      this.deps.onProjectsChanged?.([]);
      return { program, defs, projects: [], assignments: new Map(), held: new Map(), heldTabIds: new Set() };
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
      if (revived.length) this.deps.schedule?.('project'); // its manual entries take their tabs in its group on the next pass
      // A manual entry whose own tab is gone took a tab in its project's group (a browser restart, #150): that tab is
      // its own now, so it stays a member once dragged out. Local state, like onReplaced, so updatedAt is not bumped
      // (M4-R31).
      const byIdNow = new Map(projects.map((p) => [p.id, p]));
      const moves = r.rebound.flatMap(({ projectId: id, index, tabId }) => { const p = byIdNow.get(id); return p ? [{ p, index, tabId }] : []; });
      for (const p of setTabIds(projects, moves)) changed.add(p);
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
      // previous pass and is gone now (M4-R21): one not seen open since the browser started (from a synced
      // copy, M4 T14) stays at its place, and a new member is added at its tab-bar place. A list frozen by
      // close-and-save (`closed`, M4-R14) only grows until the open tabs cover it again (reopen, a full undo, the user
      // reopening them by hand). A title-only change is not written. None of this bumps updatedAt (M4-R31): it is no
      // user change, and sync takes name, color and archivedAt from the newer copy by updatedAt. Likewise a saved URL
      // takes its open tab's group only when that tab's group changed since the previous pass; otherwise it keeps the
      // saved group (one synced from a device where the tab sits in another group), or two devices would rewrite it forever.
      // Saved URLs are told apart by keyOf (M4-R41), never by the dedupe key: each open member replaces at most one saved
      // entry, the one with its exact URL, else (a navigation, a redirect) the first unclaimed one with its dedupe key
      // whose own URL was a member at the previous pass (M4-R43). All exact matches are made first, so a dedupe-key match
      // never takes an entry another tab has exactly. A saved URL that shares a dedupe key with an open tab but was never
      // a member here (another thread of the page, synced) stays.
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
    this.lastOpen = open;
    await this.done.retain(open); // a project with no open tab leaves the Finished tab (#195)
    // Under global dry run only stored projects are listed: addTab takes no unstored one.
    // Tombstones are never offered (addTab rejects them); under dry run none was revived.
    const prefixes = openPrefixes(projects, open);
    this.deps.onProjectsChanged?.((full.dryRun ? stored.filter((p) => !isTomb(p)) : projects).flatMap((p) => {
      const def = defOf.get(p.recipeId);
      return def && open.has(p.id) ? [{ id: p.id, title: projectGroupTitle(def, p, prefixes) }] : [];
    }));
    return { program, defs, projects, assignments: r.assignments, held: r.held, heldTabIds: r.heldTabIds };
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
    // An entry is a saved page (M4-R61): the tab's entry at another page (it navigated) keeps its URL without the id, so
    // join never deletes one of the project's own pages; its entry at this page is replaced.
    p.manual = [
      ...p.manual.flatMap((m) => (m.tabId !== tabId ? [m] : this.norm(program, m.url) === key ? [] : [{ url: m.url, windowId: m.windowId }])),
      { url, windowId, tabId },
    ];
    p.updatedAt = this.now();
    await this.deps.store.put(p, ...changed);
    this.log(tabId, `Joined ${p.key} manually`);
    this.deps.schedule?.('project');
  }

  private async project(id: string): Promise<{ program: Program; projects: Project[]; p: Project }> {
    const [program, projects] = await Promise.all([this.deps.getProgram(), this.deps.store.list()]);
    // A kept project closed by Close and save is a tombstone (for undo) that stays listed: it takes tabs again.
    const p = projects.find((x) => x.id === id && (!isTomb(x) || x.keep === true));
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
   * `tabIds` as its manual members (each leaves its previous project). A name its group would share is refused, so the
   * group never merges with another: the title of a project the Projects page lists (open, saved or archived; the
   * error names which) or of an open rule's group. This replaces M4-R12's `Name (2)`, which a project listed nowhere
   * also triggered: a project of that name listed nowhere (not kept, nothing open, not archived) is removed instead,
   * a tombstone too (its undo then reopens the tabs without the project). The key is the name's slug (`-2`, `-3`, …
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
      // Projects by title as their groups show them (this pass's membership), and where the Projects page lists them.
      const open = await this.resolve(snap);
      const defOf = new Map(open.defs.map((d) => [d.recipeId, d]));
      const openIds = new Set([...open.assignments.values()].map((a) => a.projectId));
      const prefixes = openPrefixes(open.projects, openIds);
      const titleOf = (q: Project): string => { const def = defOf.get(q.recipeId); return def ? projectGroupTitle(def, q, prefixes) : (q.name ?? q.key); };
      const fix = existing ? 'Rename the group first, then save it.' : 'Open it, or pick another name.';
      const clash = open.projects.find((q) => listedAs(q, openIds) && titleOf(q) === title);
      if (clash) throw new Error(`A project named “${title}” already exists (${listedAs(clash, openIds)}). ${fix}`);
      const managed = await this.managedGroups(snap, open);
      if (snap.groups.some((g) => g.id !== existing?.id && g.title === title && managed.has(g.id))) {
        throw new Error(`A group named “${title}” is already open. ${existing ? fix : 'Pick another name.'}`);
      }
      const all = await this.deps.store.list();
      const hidden = new Set(all.filter((q) => !listedAs(q, openIds) && titleOf(q) === title).map((q) => q.id));
      if (hidden.size) await this.deps.store.remove(...hidden);
      const projects = all.filter((q) => !hidden.has(q.id));
      const key = freeKey(nameSlug(title), new Set(projects.filter((q) => q.recipeId === recipeId).map((q) => q.key)));
      const p: Project = { id: `${recipeId}:${key}`, recipeId, key, name: title, keep: true, ...(existing && { color: existing.color }), createdAt: this.now(), updatedAt: this.now(), manual: [], excluded: [], linked: [] };
      projects.push(p);
      if (tabs.length === 0) await this.deps.store.put(p);
      for (const t of tabs) await this.join(program, projects, p, t.id, t.windowId, urlOf(t));
      return p.id;
    }
  }

  /**
   * Saves a Chrome group as a kept Manual project (M4 T8): named after the group (an untitled group is refused, M4-R15), keeping the group's color (`Project.color`), with its tabs as manual members. Not regrouped, retitled or
   * recolored: a name create refuses (a listed project's or an open rule group's) is refused with a clear message. Refused too when a tab of the group already belongs to a project, when Tabchef
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
      // A group named like an open project is the name clash createLocked reports, not a rule's group.
      const defOf = new Map(open.defs.map((d) => [d.recipeId, d]));
      const openIds = new Set([...open.assignments.values()].map((a) => a.projectId));
      const prefixes = openPrefixes(open.projects, openIds);
      const named = new Set(open.projects.flatMap((q) => { const d = defOf.get(q.recipeId); return d && openIds.has(q.id) ? [projectGroupTitle(d, q, prefixes)] : []; }));
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

  /**
   * The "Add to project" submenu: the projects the Projects page lists (open at the last pass, or kept; never archived
   * nor closed by Close group unless kept) whose recipe is on and takes tabs manually, in store order, each titled as
   * its group. So a kept project with no open tab is listed (closed by Close and save, created without tabs, synced from
   * another device), but not an unkept one (a ticket project whose tab was closed, stored until the prune).
   */
  menuItems(): Promise<{ id: string; title: string }[]> {
    return this.serial(async () => {
      const [program, stored] = await Promise.all([this.deps.getProgram(), this.deps.store.list()]);
      const defOf = new Map((program.projects ?? []).map((d) => [d.recipeId, d]));
      const prefixes = openPrefixes(stored, this.lastOpen);
      return stored.flatMap((p) => {
        const def = defOf.get(p.recipeId);
        const listed = (this.lastOpen.has(p.id) || p.keep === true) && (!isTomb(p) || p.keep === true) && !isArchived(p);
        return def?.join.includes('manual') && listed ? [{ id: p.id, title: projectGroupTitle(def, p, prefixes) }] : [];
      });
    });
  }

  /** Manual membership: wins over rules and clears the tab's exclusion. A kept project closed by Close and save is revived. */
  addTab(tabId: number, projectId: string): Promise<void> {
    return this.serial(async () => {
      const t = (await this.deps.port.snapshot()).tabs.find((x) => x.id === tabId);
      if (!t) throw new Error('tab not found');
      const { program, projects, p } = await this.project(projectId);
      if (isTomb(p)) revive(p); // join stores it
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
    const prefixes = openPrefixes(projects, new Set([...assignments.values()].map((a) => a.projectId)));
    const title = def ? projectGroupTitle(def, p, prefixes) : (p.name ?? p.key); // as its card names it (a Manual one: its name)
    const ids: string[] = [];
    let skipped = 0;
    const members = snap.tabs.filter((x) => assignments.get(x.id)?.projectId === projectId);
    if (save) {
      p.keep = true;
      // Marked closed: the protected tabs left open never shrink the list until reopen. The list recorded is the one
      // the pass keeps (M4-R44), never only the tabs open here: a list already frozen by an earlier Close and save (a
      // protected tab stayed open) only grows (M4-R14), or a second one would drop the tabs the first one closed; any
      // other list, kept or not (the pass maintains both, M4-R51), gets the M4-R21 refresh (under global dry run too,
      // where no pass ran), so a saved URL never open here (synced from another device, a variant reopen skips) stays
      // and only a close this device saw removes one; a project with no list records its open tabs.
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
        url: urlOf(t), title: t.title, ...(groupTitle && { groupTitle }), windowId: t.windowId, tabId: t.id, reason: 'project-closed', at: this.now(),
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
    await this.done.drop(projectId); // off the Finished tab at once; a listing lists it again while tabs of it stay open
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
   * focused one (placement: T16). A saved URL already open (dedupe's normalization) is not opened again. A tab no
   * project holds, ungrouped or in this project's own group, joins instead; a tab another project or a rule's group holds
   * stays where it is (#150, M4-R53),
   * and `elsewhere` counts those (absent when none), so the frozen list keeps them. Each tab Reopen opens joins by id as
   * a manual member when the recipe takes them (else by its rules). A closed (tombstoned) project is revived, an
   * archived one unarchived (M4 T9: "Archived: reopen?"). A user action, so it applies under global dry run too (R50).
   * Returns how many tabs it opened.
   * A saved tab that can't open in that window (closed meanwhile) is tried once more in Chrome's own choice of window. A
   * saved tab Chrome still refuses (a `javascript:` URL) never stops the others: `failed` counts them (absent when none
   * failed).
   */
  reopen(projectId: string): Promise<{ opened: number; failed?: number; elsewhere?: number }> {
    return this.serial(async () => {
      const snap = await this.deps.port.snapshot();
      const { program, projects, assignments, heldTabIds } = await this.resolve(snap);
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
      // The open tab Reopen uses per saved URL: one of this project's, else one it may take (no project holds it, and
      // it is ungrouped or in this project's group), else one held elsewhere (#150: left there and counted). A tab
      // another project's manual entry holds by id is that project's own tab on another page for now (that project
      // open, closed or archived): join would delete the entry (M4-R53, M4-R58, M4-R60). This project's own tab showing
      // a saved page joins as that page; its entry at its old page keeps the URL (join, M4-R61).
      // Its title head as the next pass names its group (open once reopened): a GitHub issue project's `#N` group may
      // be another repo's.
      const ownGroup = isOwnGroup(def, p, openPrefixes(projects, new Set([...[...assignments.values()].map((a) => a.projectId), p.id])));
      const groupTitle = new Map(snap.groups.map((g) => [g.id, g.title]));
      const ownIds = new Set(p.manual.flatMap((m) => (m.tabId === undefined ? [] : [m.tabId])));
      const rank = (t: TabSnap): number => {
        const holder = assignments.get(t.id)?.projectId;
        if (holder === projectId) return 0;
        if (holder !== undefined || (heldTabIds.has(t.id) && !ownIds.has(t.id))) return 2;
        return t.groupId === -1 || ownGroup(groupTitle.get(t.groupId)) ? 1 : 2;
      };
      const openAt = new Map<string, { t: TabSnap; rank: number }>();
      for (const t of snap.tabs) {
        if (!normal.has(t.windowId) || t.incognito) continue;
        const k = this.norm(program, urlOf(t));
        const r = rank(t);
        if ((openAt.get(k)?.rank ?? 3) > r) openAt.set(k, { t, rank: r });
      }
      const seen = new Set<string>();
      let opened = 0;
      let failed = 0;
      let elsewhere = 0;
      for (const s of saved) {
        const k = this.norm(program, s.url);
        if (seen.has(k)) continue;
        seen.add(k);
        const o = openAt.get(k);
        if (o) {
          if (o.rank === 2) elsewhere++;
          else if (o.rank === 1 && manual) await this.join(program, projects, p, o.t.id, o.t.windowId, urlOf(o.t));
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
      return { opened, ...(failed > 0 && { failed }), ...(elsewhere > 0 && { elsewhere }) };
    });
  }

  /**
   * Project sync (M4 T14): `plan` gets the stored projects, the ids of projects with open member tabs (this pass's
   * membership), those whose stored saved list could not be read (ProjectStore.unreadableSaved) and each project's own
   * group title (as its card names it, see toSynced), inside the queue, and its `put` / `remove` are stored there, so a
   * sync never races a user action or a pass. Applies under global dry run too (the stored data only). Returns what
   * `plan` returned.
   */
  syncApply<T extends { put: Project[]; remove: string[] }>(
    plan: (stored: Project[], open: Set<string>, unsynced: Set<string>, ownTitle: (p: Project) => string) => T,
  ): Promise<T> {
    return this.serial(async () => {
      const { assignments, defs, projects } = await this.resolve(await this.deps.port.snapshot());
      const defOf = new Map(defs.map((d) => [d.recipeId, d]));
      const open = new Set([...assignments.values()].map((a) => a.projectId));
      const prefixes = openPrefixes(projects, open);
      // A project's own group title, as its card names it (a Manual one: its name): its saved tabs carry it (toSynced).
      const ownTitle = (p: Project): string => { const def = defOf.get(p.recipeId); return def ? projectGroupTitle(def, p, prefixes) : (p.name ?? p.key); };
      const r = plan(await this.deps.store.list(), open, await this.deps.store.unreadableSaved(), ownTitle);
      if (r.put.length) await this.deps.store.put(...r.put);
      if (r.remove.length) await this.deps.store.remove(...r.remove);
      if (r.put.length || r.remove.length) this.deps.schedule?.('project');
      return r;
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
   * Keep on a Done prompt (#195), the card's or the popup Finished tab's: keeps the project (setKeep) and dismisses its
   * prompt in both places for this browser session, until fresh data says it is not done (reopened).
   */
  async keepDone(projectId: string): Promise<void> {
    await this.setKeep(projectId, true);
    await this.done.keep(projectId);
  }

  /** #195: the projects Done by fresh data at the last listing, still open and not kept: the Finished tab's rows. */
  doneProjects(): Promise<DoneProject[]> {
    return this.done.list();
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
          id: p.id, key: p.key, title: def ? projectGroupTitle(def, p) : (p.name ?? p.key), ...(p.summary !== undefined && { summary: p.summary }), ...prTitleOf(p),
          ...(p.status && { status: p.status }), savedCount: p.saved?.tabs.length ?? 0, ...(isArchived(p) && { archivedAt: p.archivedAt }),
          held: held.get(p.id)?.length ?? 0, updatedAt: p.updatedAt,
        };
      };
      const stored = (await this.deps.store.list()).sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        saved: stored.filter((p) => listedAs(p, open) === 'Saved').map(data),
        archived: stored.filter((p) => listedAs(p, open) === 'Archived').map(data),
      };
    });
  }

  /**
   * Backups: the kept, archived and saved projects as the exported file carries them (portable), saved tab lists
   * included (an import keeps every project). A temporary one (rule-made, never kept, no list) is left out, and so is
   * one closed by Close group and never kept: a tombstone waiting for its undo or for pruning.
   */
  exportProjects(): Promise<Project[]> {
    return this.serial(async () => (await this.deps.store.list())
      .filter((p) => p.keep || isArchived(p) || (p.saved !== undefined && !isTomb(p))).map(portable));
  }

  /**
   * Backups: merges a backup's projects into the store (never deletes one). A malformed entry (parseProject) or a second
   * copy of an id is dropped; an id not stored is added, as is one stored only as a Close group tombstone never kept
   * (pruning would remove it); a stored id is overwritten only when it is in `overwrite` (the user confirmed it), else
   * skipped. Every imported project is kept, so one with no open tab shows under Saved (or
   * Archived), and stored portable, with updatedAt now (a user action: project sync takes it over an older copy).
   * `dryRun`: the same result, nothing stored. Stored through ProjectStore.put, so project sync picks it up.
   */
  importProjects(raw: unknown[], o: { overwrite: string[]; dryRun?: boolean }): Promise<ProjectImportResult> {
    return this.serial(async () => {
      const [program, stored] = await Promise.all([this.deps.getProgram(), this.deps.store.list()]);
      const defOf = new Map((program.projects ?? []).map((d) => [d.recipeId, d]));
      const named = (p: Project): NamedProject => {
        const def = defOf.get(p.recipeId);
        return { id: p.id, title: def ? projectGroupTitle(def, p) : (p.name ?? p.key) };
      };
      const byId = new Map(stored.map((p) => [p.id, p]));
      const overwrite = new Set(o.overwrite);
      const seen = new Set<string>();
      const put: Project[] = [];
      const r: ProjectImportResult = { added: [], overwritten: [], skipped: [], dropped: [] };
      raw.forEach((x, i) => {
        const p = parseProject(x);
        if (!p || seen.has(p.id)) { r.dropped.push(dropLabel(x, i)); return; }
        seen.add(p.id);
        const found = byId.get(p.id);
        const local = found && isTomb(found) && !found.keep ? undefined : found;
        if (local && !overwrite.has(p.id)) { r.skipped.push(named(local)); return; }
        (local ? r.overwritten : r.added).push(named(local ?? p));
        put.push({ ...portable(p), keep: true, updatedAt: this.now() });
      });
      if (!o.dryRun && put.length) {
        await this.deps.store.put(...put);
        this.deps.schedule?.('project');
      }
      return r;
    });
  }

  /**
   * SafetyService.beforeUndo: a recently-closed entry of a Close group is about to be reopened. Revives its tombstone
   * first, so the restored tab rejoins the same project (rules by key, a manual entry through bindUndone). The undo of
   * a Close and archive (M4 T9) unarchives it too.
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

  /**
   * SafetyService.onUndone: an undo reopened the closed tab `closedTabId` as `tabId` at `url`. Undo gives back the
   * membership the closed tab had (#150, M4-R53): the manual entry that held the closed tab (its id, at that URL) takes
   * the new tab, whichever close it was (Close group, auto-close, a popup close, dedupe, Ask). A tab that was in a
   * project only by sitting in its group, or in none, comes back ungrouped. Local state, like onReplaced: updatedAt is
   * not bumped. A user action, so it applies under global dry run too (R50).
   */
  bindUndone(closedTabId: number, tabId: number, url: string): Promise<void> {
    return this.serial(async () => {
      const [program, stored, snap] = await Promise.all([this.deps.getProgram(), this.deps.store.list(), this.deps.port.snapshot()]);
      const live = new Set(snap.tabs.map((t) => t.id));
      const key = this.norm(program, url);
      const held = (m: Project['manual'][number]): boolean =>
        m.tabId === closedTabId && !hasOwnTab(m.tabId, live) && this.norm(program, m.url) === key;
      const p = stored.find((x) => x.manual.some(held));
      if (!p) return;
      // Not when another entry already holds the tab (a pass rebound it in the project's group, M4-R58).
      if (setTabIds(stored, movesOf([p], held, tabId)).size === 0) return;
      await this.deps.store.put(p);
      this.deps.schedule?.('project');
    });
  }

  /**
   * After a browser start (runtime.onStartup, browserStarted), the next pass's check (once): Chrome numbers tabs from a
   * low counter again, so a stored manual tabId may now name an unrelated tab. An id is kept only if its tab is at the
   * entry's URL now; the others are dropped, so no later tab that reuses one is taken as the entry's own (or makes `join`
   * delete the entry). Those entries take their restored tabs in their project's group (`rebound`). It runs under
   * global dry run and with no projects recipe on too: the ids are stale whatever the settings. Nothing else sweeps (an
   * extension update or reload, a worker restart, a settings change): ids are still valid then, and an own tab on
   * another page for now keeps its id, so it is a member again when it comes back (M4-R59). Local state, like
   * onReplaced: updatedAt is not bumped (M4-R31). A failure is retried at the next pass.
   *
   * The storage.session flag is cleared only once the sweep's store write succeeded. If clearing it fails, this worker
   * does not sweep again (a sweep later in the session would drop the ids of own tabs on another page for now, M4-R59);
   * it writes the flag again at each next pass until that succeeds. Only a new worker that starts before then sweeps
   * again, with that cost.
   */
  private async dropStaleIds(snap: Snapshot, program: Program): Promise<void> {
    if (this.idsStale === false) {
      if (this.idsClearUnwritten) await this.clearIdsStale();
      return;
    }
    try {
      if (this.idsStale === undefined) {
        const v = this.deps.session ? (await this.deps.session.get(IDS_STALE_KEY)) === true : false;
        this.idsStale ??= v; // browserStarted may have set it while the read was pending: keep its true
      }
      if (!this.idsStale) return;
      // Read here, not the pass's list: a failed put leaves the pass's projects untouched.
      const stored = await this.deps.store.list();
      const at = new Map(snap.tabs.map((t) => [t.id, this.norm(program, urlOf(t))]));
      const stale = (m: Project['manual'][number]): boolean => m.tabId !== undefined && at.get(m.tabId) !== this.norm(program, m.url);
      const changed = stored.filter((p) => p.manual.some(stale));
      for (const p of changed) p.manual = p.manual.map((m) => (stale(m) ? { url: m.url, windowId: m.windowId } : m));
      if (changed.length) await this.deps.store.put(...changed);
      this.idsStale = false;
    } catch (e) {
      console.warn('[tabchef] stale tab id check failed (retried at the next pass)', e);
      return;
    }
    this.idsClearUnwritten = true;
    await this.clearIdsStale();
  }

  /** dropStaleIds is done: storage.session's IDS_STALE_KEY = false, so a new worker in this browser session does not sweep. */
  private async clearIdsStale(): Promise<void> {
    try {
      await this.deps.session?.set(IDS_STALE_KEY, false);
      this.idsClearUnwritten = false;
    } catch (e) {
      console.warn('[tabchef] clearing the stale tab id flag failed (retried at the next pass)', e);
    }
  }

  /**
   * runtime.onStartup: a new browser session, so the stored manual tab ids are checked (dropStaleIds) now, and by the
   * next pass if this worker stops first (the flag is in storage.session). Now rather than at the next live pass: under
   * global dry run this session's ids would otherwise be checked once dry run is off.
   */
  async browserStarted(): Promise<void> {
    this.idsStale = true;
    this.idsClearUnwritten = false;
    await this.deps.session?.set(IDS_STALE_KEY, true);
    return this.serial(async () => this.dropStaleIds(await this.deps.port.snapshot(), liveProgram(await this.deps.getProgram())));
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
      const stored = await this.deps.store.list();
      // `added` is new this browser session, so an entry holding it holds a stale id (not swept yet, M4-R59): it lets
      // go, keeping its URL, and the replace wins. Local state, so updatedAt is not bumped (M4-R31).
      const stale = stored.some((p) => p.manual.some((m) => m.tabId === removed))
        ? stored.filter((p) => p.manual.some((m) => m.tabId === added)) : [];
      for (const p of stale) p.manual = p.manual.map((m) => (m.tabId === added ? { url: m.url, windowId: m.windowId } : m));
      const changed = new Set([...stale, ...setTabIds(stored, movesOf(stored, (m) => m.tabId === removed, added))]);
      if (changed.size) await this.deps.store.put(...changed);
    });
  }

  /**
   * Open projects for the popup / side panel (`projects.list`). Membership is read under the queue, ticket status and
   * linked PRs are fetched outside it (a reconcile never waits on the network), then written under it again.
   */
  async cards(): Promise<ProjectCardData[]> {
    const since = this.done.generation(); // a project dropped while this listing runs is not listed again (R5-M1)
    const { cards } = await this.collect();
    // #195: the done ones feed the Finished tab; a Done prompt answered Keep is not shown again.
    const kept = await this.done.noteListing(cards, since);
    return cards.map((c) => (c.done && kept.has(c.id) ? { ...c, doneKept: true as const } : c));
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
      id: p.id, key: p.key, title: def ? projectGroupTitle(def, p) : (p.name ?? p.key), ...(p.summary !== undefined && { summary: p.summary }), ...prTitleOf(p),
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
      // Titled as the planner titles their groups: against every open project, not only the one asked for.
      const prefixes = openPrefixes(projects, new Set(tabsOf.keys()));
      return { snap, program, defOf, tabsOf, sites: ticketSites(program, snap, assignments), open, held, prefixes };
    });
    const { snap, program, defOf, tabsOf, sites, open, held, prefixes } = plan;
    if (open.length === 0) return { cards: [], snap, open, defOf, held };
    const now = this.now();
    // One GitHub issue lookup per pass: the cards' status and the linked PRs both read it.
    const gh = this.fetchGhIssues(open);
    const [linked, { issues, asked }, ghIssues] = await Promise.all([
      this.fetchLinked(program, open, tabsOf, now, gh), this.fetchIssues(open, tabsOf, sites), gh,
    ]);
    return this.serial(async () => {
      const current = new Map((await this.deps.store.list()).map((p) => [p.id, p]));
      const factsOf = (t: TabSnap): SourceEntry<Record<string, unknown>>[] => Object.values(this.deps.sources.factsFor(t.id, urlOf(t)) ?? {});
      const changed: Project[] = [];
      let renamed = false;
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
        const issue = asked.has(p.id) ? issues.get(p.key) : ghIssues.get(p.key);
        // A fresh lookup (via api or page, not stale) keeps the summary current when the ticket is renamed; a stale or
        // unread one only fills a missing summary. Not a user change, so no updatedAt bump (M4-R31). A `{summary}`
        // group title follows on the next pass, through the reconciler's rename (M3-R41).
        const summary = issue?.data?.summary?.trim() ? issue.data.summary : undefined;
        const fresh = issue !== undefined && !issue.stale && (issue.via === 'api' || issue.via === 'page');
        if (summary !== undefined && summary !== p.summary && (fresh || p.summary === undefined)) { p.summary = summary; renamed = true; }
        // M3-R90: the status shown may be last known (a stale entry, else the stored one), but only a fresh entry
        // (via api or page, not stale) says Done: stale or unknown data never drives the close prompt.
        const src = [issue, ...tabs.flatMap(factsOf)].find((e) => e && statusOf(e.data, e.via));
        const status = (src && statusOf(src.data, src.via)) ?? p.status;
        const done = src !== undefined && !src.stale && status?.category === 'done';
        if (status) p.status = status;
        if (JSON.stringify(p) !== before) changed.push(p);
        const openUrls = new Set(tabs.map((t) => this.norm(program, urlOf(t))));
        return [{
          id: p.id, key: p.key, title: projectGroupTitle(defOf.get(p.recipeId)!, p, prefixes), ...(p.summary !== undefined && { summary: p.summary }), ...prTitleOf(p),
          ...(status && { status }), done, ...(p.keep && { keep: true }),
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
      if (renamed) this.deps.schedule?.('project'); // a group titled with the summary takes the new one
      return { cards, snap, open, defOf, held };
    });
  }

  /**
   * Ticket status through SourceService.issues for the Jira projects (not GitHub issue keys) on the Jira connection's site only (M3-R110): a ticket
   * tab (`/browse/<key>`) on that site, else the project's ticket site (stored, else its ticket tab's now) is it, or
   * none is known (a PR-only project). Any other page of that site (a dashboard) says nothing about the ticket. A
   * same-key ticket on another site is another issue: its status comes from its own tab's page.
   */
  private async fetchIssues(open: Project[], tabsOf: Map<string, TabSnap[]>, sites: Map<string, string>): Promise<{ issues: Map<string, SourceEntry<JiraIssue>>; asked: Set<string> }> {
    const site = await this.deps.sources.jiraSite();
    const on = site === undefined ? [] : open.filter((p) => !parseIssueKey(p.key)).filter((p) => tabsOf.get(p.id)!.some((t) => hostOf(urlOf(t)) === site && isTicketOf(urlOf(t), p.key)) || (p.site ?? sites.get(p.id) ?? site) === site);
    const issues = on.length ? await this.deps.sources.issues(on.map((p) => p.key)) : new Map<string, SourceEntry<JiraIssue>>();
    return { issues, asked: new Set(on.map((p) => p.id)) };
  }

  /** The GitHub issue (summary, status, linked PRs) of each open project whose key is one (`owner/repo#N`). */
  private async fetchGhIssues(open: Project[]): Promise<Map<string, SourceEntry<GithubIssueInfo>>> {
    const keys = open.filter((p) => parseIssueKey(p.key)).map((p) => p.key);
    return keys.length ? this.deps.sources.githubIssues(keys) : new Map();
  }

  /**
   * Linked PRs of projects not searched for LINKED_REFRESH_MS, through SourceService.linkedFor: in the orgs of the
   * project's open PR tabs plus its recipe's `githubOrgs`; a GitHub issue project's (`owner/repo#N`) from its issue's
   * `linkedPrs` in `ghIssues` (the pass's fetchGhIssues). Every searched project is returned (`prs` undefined: no results
   * known, the previous list stays), so the 15-minute cap holds for keys without results too.
   */
  private async fetchLinked(program: Program, open: Project[], tabsOf: Map<string, TabSnap[]>, now: number,
    ghIssueEntries: Promise<Map<string, SourceEntry<GithubIssueInfo>>>): Promise<Map<string, { prs?: PrInfo[] }>> {
    const byOrgs = new Map<string, Project[]>();
    const ghIssues: Project[] = [];
    for (const p of open) {
      if (p.linkedFetchedAt !== undefined && now - p.linkedFetchedAt < LINKED_REFRESH_MS) continue;
      if (parseIssueKey(p.key)) { ghIssues.push(p); continue; }
      const orgs = [...tabsOf.get(p.id)!.flatMap((t) => PR_OWNER.exec(urlOf(t))?.[1] ?? []), ...strings(program.params?.[p.recipeId]?.githubOrgs)];
      const k = [...new Set(orgs.map((o) => o.toLowerCase()))].sort().join(',');
      byOrgs.set(k, [...(byOrgs.get(k) ?? []), p]);
    }
    const out = new Map<string, { prs?: PrInfo[] }>();
    for (const [k, ps] of byOrgs) {
      const found = await this.deps.sources.linkedFor(ps.map((p) => p.key), k ? k.split(',') : []);
      for (const p of ps) out.set(p.id, { ...(found.has(p.key) && { prs: found.get(p.key)! }) });
    }
    // A GitHub issue's linked PRs are the ones GitHub links to it (closing references), not a key search.
    if (ghIssues.length) {
      const found = await ghIssueEntries;
      for (const p of ghIssues) {
        const prs = found.get(p.key)?.data?.linkedPrs;
        out.set(p.id, { ...(prs && { prs }) });
      }
    }
    return out;
  }
}

/** issueTitlePrefixes of the projects in `open` (those with tabs): their group titles as projectTargets renders them. */
function openPrefixes(projects: Project[], open: ReadonlySet<string>): Map<string, string> {
  return issueTitlePrefixes(projects.filter((p) => open.has(p.id)));
}

/** ProjectCardData.prTitle: the first linked PR's own title, for a project with no ticket summary and no name. */
function prTitleOf(p: Project): Pick<ProjectCardData, 'prTitle'> {
  if (p.summary !== undefined || p.name !== undefined) return {};
  const t = p.linked.find((l) => l.title.trim() !== '' && l.title !== l.url)?.title;
  return t === undefined ? {} : { prTitle: t };
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
