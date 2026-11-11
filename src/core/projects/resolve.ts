// Project membership (M3 T14). Pure: which project each open tab belongs to, by manual membership, sticky membership
// and the `assignProject` candidates of the Program, plus the group targets the planner uses for them (M3-R43).
//
// Order per tab: manual > sticky (same normalized URL) > rules. Rules: pass 1 settles tabs whose highest-priority
// candidate creates (Jira ticket tabs); pass 2 walks every other tab's candidates in priority order, and the first one
// that resolves wins. A `create: false` candidate (a PR) resolves only into a project that exists (stored or created in
// pass 1/2) or whose key prefix is confirmed (`allowPrefixes` ∪ `knownPrefixes`, Review Focus #5).
import { COLORS } from '../config/schema';
import { parseIssueKey, type IssueRef } from '../keys/github-issue';
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
 * `sig` is that rule's signature (ruleSig) when the tab joined: once the rule is gone or its signature differs, a
 * settings change has touched it, and only the tab's own candidate keeps it. Entries without it are from older builds.
 */
export type StickyMap = Map<number, { projectId: string; url: string; ruleKey?: string; index?: number; sig?: string }>;

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

/**
 * A compiled rule's signature: FNV-1a over its match, extract and actions as compiled (params substituted and
 * folded), so a setting that changes what the rule matches or extracts changes it, and one it does not use (a group
 * color, a title format) does not. Short, as it is stored with each sticky tab.
 */
function ruleSig(r: Program['rules'][number]): string {
  const j = JSON.stringify([r.rule.match, r.rule.extract, r.rule.actions]);
  let h = 0x811c9dc5;
  for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}-${j.length}`;
}

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

  // Manual: an entry first holds its own tab while that tab is at the entry's URL, then every other tab at that URL
  // (a second copy of the page, or any copy once its own tab is gone or has navigated away). The first project
  // listing a tab wins.
  const entries = input.projects.flatMap((p) => p.manual.flatMap((m) => {
    const url = norm(m.url);
    return url === undefined ? [] : [{ p, tabId: m.tabId, url }];
  }));
  for (const ownOnly of [true, false]) {
    for (const { p, tabId, url } of entries) {
      for (const { t, url: u } of tabs) {
        if (u !== url || (ownOnly && t.id !== tabId) || assignments.has(t.id)) continue;
        assignments.set(t.id, { projectId: p.id, key: p.key, via: 'manual', index: -1 });
      }
    }
  }

  const excluded = (p: Project | undefined, url: string): boolean => p !== undefined && p.excluded.includes(url);
  const ensure = (recipeId: string, key: string): Project => {
    const id = projectId(recipeId, key);
    let p = byId.get(id);
    if (!p) {
      p = { id, recipeId, key, createdAt: now, updatedAt: now, manual: [], excluded: [], linked: [] };
      byId.set(id, p);
      created.push(p);
    }
    return p;
  };
  const sigs = new Map(program.rules.map((r) => [r.key, ruleSig(r)]));
  const join = (tabId: number, url: string, p: Project, c: Pick<ProjectCandidate, 'ruleKey' | 'index'>): void => {
    assignments.set(tabId, { projectId: p.id, key: p.key, via: 'rule', ruleKey: c.ruleKey, index: c.index });
    const sig = sigs.get(c.ruleKey);
    sticky.set(tabId, { projectId: p.id, url, ruleKey: c.ruleKey, index: c.index, ...(sig !== undefined && { sig }) });
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
      // outranked). When a settings change turned the assigning rule off or changed it (its signature differs), only
      // the tab's own candidate keeps it: the rule may no longer match (#196).
      const own = cands.find((c) => recipeOf.get(c.ruleKey) === sp.recipeId && c.key === sp.key);
      const assigned = s?.ruleKey !== undefined ? program.rules.find((r) => r.key === s.ruleKey && r.recipeId === sp.recipeId) : undefined;
      const changed = s?.sig !== undefined && (!assigned || s.sig !== sigs.get(assigned.key));
      const fallback = assigned ?? program.rules.filter((r) => r.recipeId === sp.recipeId && r.rule.actions.some((a) => 'assignProject' in a)).at(-1);
      const c = own ?? (!changed && fallback ? { ruleKey: fallback.key, index: fallback.index } : undefined);
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

/** An issue's title forms, least to most specific: `#N`, `repo#N`, `owner/repo#N`. */
const issueForms = (r: IssueRef): string[] => [`#${r.number}`, `${r.repo}#${r.number}`, `${r.owner}/${r.repo}#${r.number}`];

/**
 * The base form of an issue title template (an index into issueForms): `owner/repo#N` (the key, so never escalated)
 * when it starts with `{owner}/{repo}#{num}`, `repo#N` when it starts with `{repo}#{num}`, else `#N`.
 */
const baseForm = (template: string): number => (template.startsWith('{owner}/{repo}#{num}') ? 2 : template.startsWith('{repo}#{num}') ? 1 : 0);

/**
 * An issue project's title prefix: the base form of `def.title`, or the more specific `prefix` (issueTitlePrefixes)
 * when two open projects would otherwise share it.
 */
function issueHead(def: ProjectDef, r: IssueRef, prefix: string | undefined): string {
  const forms = issueForms(r);
  return forms[Math.max(baseForm(def.title), prefix === undefined ? 0 : forms.indexOf(prefix))]!;
}

/**
 * The project's group title: `def.title` rendered with `{key, summary, name}` (and an issue key's `{owner, repo, num}`);
 * with no summary or name, just the key, or for a GitHub issue key the template's base form (`#N`, `repo#N` for a
 * `{repo}#{num}` template, `owner/repo#N` for an `{owner}/{repo}#{num}` one). `prefixes` (issueTitlePrefixes of the
 * open projects) replaces an issue title's leading base form with a more specific one (`repo#N`, `owner/repo#N`) when
 * two open projects would collide.
 */
export function projectGroupTitle(def: ProjectDef, p: Project, prefixes?: ReadonlyMap<string, string>): string {
  const r = parseIssueKey(p.key);
  if (!r) return p.summary || p.name ? renderTemplate(def.title, templateVars(p)) : p.key;
  const base = issueForms(r)[baseForm(def.title)]!;
  const head = issueHead(def, r, prefixes?.get(p.id));
  if (!(p.summary || p.name)) return head;
  const t = renderTemplate(def.title, templateVars(p));
  return t.startsWith(base) && !/\d/.test(t.charAt(base.length)) ? head + t.slice(base.length) : t;
}

/**
 * The least specific group title prefix each GitHub issue project in `projects` (the open ones, those with tabs) can
 * use: `#N`, or, when two of them have the same number, `repo#N`, or `owner/repo#N` when their repo names are the same
 * too. A `{repo}#{num}` template never goes below `repo#N`, an `{owner}/{repo}#{num}` one never below `owner/repo#N`
 * (projectGroupTitle). The check spans every open project, whatever its window: the planner matches groups by title,
 * so two projects must never share one (Review Focus 2).
 */
export function issueTitlePrefixes(projects: Iterable<Project>): Map<string, string> {
  const byNumber = new Map<number, { id: string; owner: string; repo: string }[]>();
  const seen = new Set<string>();
  for (const p of projects) {
    const r = parseIssueKey(p.key);
    if (!r || seen.has(p.id)) continue;
    seen.add(p.id);
    byNumber.set(r.number, [...(byNumber.get(r.number) ?? []), { id: p.id, owner: r.owner, repo: r.repo }]);
  }
  const out = new Map<string, string>();
  for (const [n, list] of byNumber) {
    for (const x of list) {
      const sameRepo = list.filter((y) => y.repo === x.repo).length;
      out.set(x.id, list.length === 1 ? `#${n}` : sameRepo === 1 ? `${x.repo}#${n}` : `${x.owner}/${x.repo}#${n}`);
    }
  }
  return out;
}

/** A project's values for its recipe's title and color templates: `{key}`, `{summary}`, (M4 T6) `{name}`, and an issue key's `{owner}`, `{repo}`, `{num}`. */
function templateVars(p: Project): Record<string, string> {
  const r = parseIssueKey(p.key);
  return { key: p.key, summary: p.summary ?? '', name: p.name ?? '', ...(r && { owner: r.owner, repo: r.repo, num: String(r.number) }) };
}

/**
 * True when a group titled `title` is the project `key`'s: exactly the key, or `<key> · …`. For a GitHub issue key, the
 * project's title `prefix` (its group title's head; default `#N`) or a more specific one of its own (`repo#N`,
 * `owner/repo#N`): a project titled `web#12` never takes a bare `#12` group, which may be another repo's.
 */
export function titleBelongsToProject(title: string, key: string, prefix?: string): boolean {
  const r = parseIssueKey(key);
  const forms = r ? issueForms(r) : [key];
  const from = r && prefix !== undefined ? Math.max(0, forms.indexOf(prefix)) : 0;
  return forms.slice(from).some((h) => title === h || title.startsWith(`${h} · `));
}

/**
 * The planner override (PlanContext.overrides, M3-R39) for each assigned tab: its project's group. A project with no
 * def (its recipe is gone) or an assignment to an unknown project gets no target.
 */
export function projectTargets(assignments: Map<number, ProjectAssignment>, projects: Project[], defs: ProjectDef[]): Map<number, GroupTarget> {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const defOf = new Map(defs.map((d) => [d.recipeId, d]));
  const out = new Map<number, GroupTarget>();
  const assigned = new Set([...assignments.values()].map((a) => a.projectId));
  const prefixes = issueTitlePrefixes(projects.filter((p) => assigned.has(p.id)));
  for (const [tabId, a] of assignments) {
    const p = byId.get(a.projectId);
    const def = p && defOf.get(p.recipeId);
    if (!p || !def) continue;
    const rendered = p.color ?? renderTemplate(def.color, templateVars(p));
    const valid = COLORS.has(rendered);
    const ruleId = a.ruleKey ?? `${p.recipeId}/project`;
    const issue = parseIssueKey(p.key);
    const prefix = issue ? issueHead(def, issue, prefixes.get(p.id)) : undefined;
    // Manual-only (a saved group): its group is the user's, so it is not strict (a tab Chrome or the user puts into it
    // stays) and has no place in the order pass (M4-R16).
    const manualOnly = def.join.length === 1 && def.join[0] === 'manual';
    out.set(tabId, {
      key: ruleId, ruleId, index: a.index, ruleIndex: a.index, title: projectGroupTitle(def, p, prefixes),
      color: (valid ? rendered : 'grey') as GroupColor, collapsed: false, sortGroups: 'creation', strict: !manualOnly, merge: false,
      dryRun: false, anchors: [], titleMatches: (t) => titleBelongsToProject(t, p.key, prefix),
      ...(manualOnly ? { unordered: true as const } : {}),
      ...(valid ? {} : { invalidColor: true as const }),
    });
  }
  return out;
}
