// Project membership (M3 T14). Pure: which project each open tab belongs to, by manual membership, sticky membership
// and the `assignProject` candidates of the Program, plus the group targets the planner uses for them (M3-R43).
//
// Order per tab: manual > sticky (same normalized URL) > rules. Rules: pass 1 settles tabs whose highest-priority
// candidate creates (Jira ticket tabs); pass 2 walks every other tab's candidates in priority order, and the first one
// that resolves wins. A `create: false` candidate (a PR) resolves only into a project that exists (stored or created in
// pass 1/2) or whose key prefix is confirmed (`allowPrefixes` ∪ `knownPrefixes`, Review Focus #5).
import { COLORS } from '../config/schema';
import { evaluateTab, type ProjectCandidate } from '../lang/evaluate';
import { renderTemplate } from '../match/template';
import { normalizeUrl } from '../url/normalize';
import type { GroupTarget } from '../group/evaluate';
import type { Program, TabFacts } from '../lang/types';
import type { GroupColor, Snapshot, TabSnap } from '../types';
import type { Project, ProjectAssignment, ProjectDef } from './types';

/**
 * tabId → the project a tab joined by rules, the normalized URL it had then, and the assigning rule (key and index;
 * T15 persists it in RuntimeState.projectTabs, M3-R42/R66). Entries without the rule are from before it was stored.
 */
export type StickyMap = Map<number, { projectId: string; url: string; ruleKey?: string; index?: number }>;

export interface ResolveInput {
  snap: Snapshot;
  program: Program;
  facts: (tabId: number) => Partial<TabFacts>;
  projects: Project[];
  knownPrefixes: Set<string>;
  allowPrefixes: string[];
  now: number;
  sticky: StickyMap;
}
export interface ResolveResult {
  assignments: Map<number, ProjectAssignment>;
  /** Projects this pass created (not in `projects`). */
  created: Project[];
  /** projectId → summary from its creating tab: the rule's source `summary` field, else its `summary` extract. */
  summaries: Map<string, string>;
  /** The next sticky map: every rule assignment, keyed by tab. */
  sticky: StickyMap;
}

const projectId = (recipeId: string, key: string): string => `${recipeId}:${key}`;
/** A key's project prefix: everything before its last `-`, uppercased (`abc-def-12` → `ABC-DEF`). */
const prefixOf = (key: string): string => {
  const i = key.lastIndexOf('-');
  return (i < 0 ? key : key.slice(0, i)).toUpperCase();
};
const urlOf = (t: TabSnap): string => (t.pendingUrl ? t.pendingUrl : t.url);

export function resolveProjects(input: ResolveInput): ResolveResult {
  const { snap, program, now } = input;
  const norm = (url: string): string | undefined => normalizeUrl(url, program.dedupe)?.key;
  const recipeOf = new Map(program.rules.map((r) => [r.key, r.recipeId]));
  const byId = new Map(input.projects.map((p) => [p.id, p]));
  const created: Project[] = [];
  const assignments = new Map<number, ProjectAssignment>();
  const summaries = new Map<string, string>();
  const sticky: StickyMap = new Map();
  const confirmed = new Set([...input.allowPrefixes, ...input.knownPrefixes].map((p) => p.toUpperCase()));

  const normal = new Set(snap.windows.filter((w) => w.type === 'normal').map((w) => w.id));
  const tabs: { t: TabSnap; url: string }[] = [];
  for (const t of snap.tabs) {
    if (!normal.has(t.windowId) || t.pinned) continue;
    const url = norm(urlOf(t));
    if (url !== undefined) tabs.push({ t, url });
  }

  // Manual: an entry holds its own tab while that tab is at the entry's URL; once that tab is gone (restart) or has
  // navigated away, any tab at that URL. The first project listing a tab wins.
  for (const p of input.projects) {
    for (const m of p.manual) {
      const url = norm(m.url);
      if (url === undefined) continue;
      const own = m.tabId !== undefined && tabs.some((x) => x.t.id === m.tabId && x.url === url);
      for (const { t, url: u } of tabs) {
        if (u !== url || (own && t.id !== m.tabId) || assignments.has(t.id)) continue;
        assignments.set(t.id, { projectId: p.id, key: p.key, via: 'manual', index: -1 });
      }
    }
  }

  const excluded = (p: Project | undefined, url: string): boolean => p !== undefined && p.excluded.includes(url);
  const ensure = (recipeId: string, key: string): Project => {
    const id = projectId(recipeId, key);
    let p = byId.get(id);
    if (!p) {
      p = { id, recipeId, key, createdAt: now, manual: [], excluded: [], linked: [] };
      byId.set(id, p);
      created.push(p);
    }
    return p;
  };
  const join = (tabId: number, url: string, p: Project, c: Pick<ProjectCandidate, 'ruleKey' | 'index'>): void => {
    assignments.set(tabId, { projectId: p.id, key: p.key, via: 'rule', ruleKey: c.ruleKey, index: c.index });
    sticky.set(tabId, { projectId: p.id, url, ruleKey: c.ruleKey, index: c.index });
  };

  // Rule candidates, and sticky membership for tabs whose URL is unchanged.
  const pending: { t: TabSnap; url: string; cands: ProjectCandidate[] }[] = [];
  for (const { t, url } of tabs) {
    if (assignments.has(t.id)) continue;
    const f = input.facts(t.id);
    const cands = evaluateTab(program, { ...f, tab: t }, now).project ?? [];
    const s = input.sticky.get(t.id);
    const sp = s && s.url === url ? byId.get(s.projectId) : undefined;
    if (sp && !excluded(sp, url)) {
      // The tab's own candidate for that key, else the rule that assigned it (at its current index), else the
      // lowest-priority assignProject rule of the recipe (a sticky tab never outranks a group rule it might not have
      // outranked).
      const own = cands.find((c) => recipeOf.get(c.ruleKey) === sp.recipeId && c.key === sp.key);
      const assigned = s?.ruleKey !== undefined ? program.rules.find((r) => r.key === s.ruleKey && r.recipeId === sp.recipeId) : undefined;
      const fallback = assigned ?? program.rules.filter((r) => r.recipeId === sp.recipeId && r.rule.actions.some((a) => 'assignProject' in a)).at(-1);
      const c = own ?? (fallback && { ruleKey: fallback.key, index: fallback.index });
      if (c) { join(t.id, url, sp, c); continue; }
    }
    if (cands.length) pending.push({ t, url, cands: cands.filter((c) => recipeOf.get(c.ruleKey) !== undefined) });
  }

  /** The first summary a project's creating tab reports: its rule's source `summary` field, else its extract. */
  const noteSummary = (p: Project, t: TabSnap, c: ProjectCandidate): void => {
    const v = input.facts(t.id).source?.[c.ruleKey]?.data?.summary;
    const s = typeof v === 'string' && v !== '' ? v : c.summary;
    if (s !== undefined && !summaries.has(p.id)) summaries.set(p.id, s);
  };
  const create = (t: TabSnap, url: string, c: ProjectCandidate): boolean => {
    const recipeId = recipeOf.get(c.ruleKey)!;
    if (excluded(byId.get(projectId(recipeId, c.key)), url)) return false;
    const p = ensure(recipeId, c.key);
    join(t.id, url, p, c);
    noteSummary(p, t, c);
    return true;
  };

  // Pass 1: tabs whose first candidate creates (ticket tabs).
  const rest: typeof pending = [];
  for (const x of pending) {
    const first = x.cands[0];
    if (!(first?.create && create(x.t, x.url, first))) rest.push(x);
  }
  // Pass 2a: tabs whose first candidate that can resolve now creates, so a PR listed before such a tab still finds
  // the project in 2b (M3-R56). A create:false candidate can resolve now if its project exists or its prefix is confirmed.
  // A candidate whose project excludes this tab's URL never applies to it, so it is skipped.
  const resolvable = (c: ProjectCandidate, url: string): boolean => {
    const id = projectId(recipeOf.get(c.ruleKey)!, c.key);
    return !excluded(byId.get(id), url) && (c.create || byId.has(id) || confirmed.has(prefixOf(c.key)));
  };
  const later: typeof rest = [];
  for (const x of rest) {
    const c = x.cands.find((y) => resolvable(y, x.url));
    if (!(c?.create && create(x.t, x.url, c))) later.push(x);
  }
  // Pass 2b: the first candidate that resolves.
  for (const { t, url, cands } of later) {
    for (const c of cands) {
      if (c.create) { if (create(t, url, c)) break; continue; }
      const recipeId = recipeOf.get(c.ruleKey)!;
      const p = byId.get(projectId(recipeId, c.key));
      if (p) {
        if (excluded(p, url)) continue;
        join(t.id, url, p, c);
        break;
      }
      if (confirmed.has(prefixOf(c.key))) {
        const np = ensure(recipeId, c.key);
        join(t.id, url, np, c);
        noteSummary(np, t, c);
        break;
      }
    }
  }
  return { assignments, created, summaries, sticky };
}

/** The project's group title: `def.title` rendered with `{key, summary}`; with no summary, just the key. */
export function projectGroupTitle(def: ProjectDef, p: Project): string {
  return p.summary ? renderTemplate(def.title, { key: p.key, summary: p.summary }) : p.key;
}

/** True when a group titled `title` is the project `key`'s: exactly the key, or `<key> · …`. */
export function titleBelongsToProject(title: string, key: string): boolean {
  return title === key || title.startsWith(`${key} · `);
}

/**
 * The planner override (PlanContext.overrides, M3-R39) for each assigned tab: its project's group. A project with no
 * def (its recipe is gone) or an assignment to an unknown project gets no target.
 */
export function projectTargets(assignments: Map<number, ProjectAssignment>, projects: Project[], defs: ProjectDef[]): Map<number, GroupTarget> {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const defOf = new Map(defs.map((d) => [d.recipeId, d]));
  const out = new Map<number, GroupTarget>();
  for (const [tabId, a] of assignments) {
    const p = byId.get(a.projectId);
    const def = p && defOf.get(p.recipeId);
    if (!p || !def) continue;
    const rendered = renderTemplate(def.color, { key: p.key, summary: p.summary ?? '' });
    const valid = COLORS.has(rendered);
    const ruleId = a.ruleKey ?? `${p.recipeId}/project`;
    out.set(tabId, {
      key: ruleId, ruleId, index: a.index, ruleIndex: a.index, title: projectGroupTitle(def, p),
      color: (valid ? rendered : 'grey') as GroupColor, collapsed: false, sortGroups: 'creation', strict: true, merge: false,
      dryRun: false, anchors: [], titleMatches: (t) => titleBelongsToProject(t, p.key),
      ...(valid ? {} : { invalidColor: true as const }),
    });
  }
  return out;
}
