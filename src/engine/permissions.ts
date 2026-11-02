// PermissionsManager (M2 T8): which recipe needs are granted, which recipes / rules are paused waiting for a
// permission, and where the watch content script runs.
//
// Needs come from the compiled Program (`Program.needs`, keyed by recipe id for recipe-level needs, or by rule key
// `<recipeId>/<ruleId>` for rule-level ones). The Program lists needs for paused items too, so reading needs from
// the program the manager pauses is not circular. Ruling R5: an unmet recipe-level need pauses the recipe (and
// `recipes.enable` refuses it); an unmet rule-level need pauses that rule key only. Any host need implies the
// `scripting` permission (the watch is registered through chrome.scripting).
//
// The manager is the one owner of the `tabchef-watch` registration: it covers the granted origins needed by enabled,
// unpaused recipes, plus every granted host origin while an enabled user rule uses page facts (ruling R44: user rules
// declare no needs), and is replaced as a whole on every sync. chrome.scripting is undefined until
// `scripting` is granted: the WatchScripting adapter then reports false and nothing is registered (no throw).
//
// Capability levels (M3 T12): a needs entry with `anyOf` runs at its first granted alternative (core/lang/needs.ts
// needsLevel), from the granted permissions plus the connection states (`connections`; a connection counts unless it
// is not-configured: needs-reauth, rate limits and errors keep the level, M3-R89 / M3-R70; SourceService still calls
// the API only while the connection is ok, so cached data turns stale and the page fallback is used where granted).
// No granted alternative pauses the key like any unmet need (M3-R16 wording). A recipe's `levels` are positional (M3-R69): levels[i] means LEVEL_KINDS[i]; a level
// is available when none of its rules is paused and at least one runs at that kind or better. compileProgram stays
// free of this state (R45, M3-R63).
import type { BrowserPort } from '../platform/browser-port';
import type { ConnectionState } from '../core/connections/types';
import type { NeedsAlt, NeedsEntry, Program, RecipeLevel } from '../core/lang/types';
import {
  accessText, alternativesOf, altKind, hostOf, kindRank, LEVEL_KINDS, missingOf, needsLevel, type Granted, type NeedsKind,
} from '../core/lang/needs';
import { usesPageFacts } from './page-facts';
import { watchOrigins, type WatchScripting } from './watch-registration';

export type { WatchScripting } from './watch-registration';

export interface Needs { origins: string[]; permissions: string[] }
export interface NeedStatus {
  ok: boolean; missing: Needs; reason?: string;
  /** Entries with `anyOf`, when ok: the index of the alternative in use (0 = best). */
  level?: number;
}
/** A rule's level: the index of its alternative in use (0 when it has no `anyOf`), -1 and the reason when paused. */
export interface RuleLevel { level: number; paused?: string }
/** One declared capability level of a recipe: `"<label>: available"` / `"<label>: locked, needs <needs>"`. */
export interface LevelStatus {
  id: string; label: string; available: boolean; needs?: string;
  /** An available level whose connections need a new sign-in (needs-reauth, M3-R89): their ids (#/connections). */
  reauth?: string[];
  /** What unlocks a locked level: hosts / permissions to request, or connections to set up (#/connections). */
  missing?: Needs & { connections: string[] };
}
/** status() per key; recipe ids also carry their rules' levels (when any rule has needs) and their declared capability levels. */
export interface KeyStatus extends NeedStatus { rules?: Record<string, RuleLevel>; levels?: LevelStatus[] }
export interface ConnectionInfo { id: string; label: string; state: ConnectionState }

export interface PermissionsOptions {
  /** The connections and their states (ConnectionManager defs + status). Without it no connection is usable. */
  connections?: () => Promise<ConnectionInfo[]>;
  /** The paused set changed: the Program recompiles on its next get (ProgramCache keys on it); re-plan. */
  onPausedChanged?: () => void;
  /** Default: console.warn. */
  warn?: (message: string, e: unknown) => void;
}

/** `needs` as requested and checked: any host need adds the `scripting` permission (R5). */
export function effectiveNeeds(n: Needs): Needs {
  const permissions = [...new Set(n.permissions)];
  if (n.origins.length > 0 && !permissions.includes('scripting')) permissions.push('scripting');
  return { origins: [...new Set(n.origins)], permissions };
}

/** effectiveNeeds for a whole entry: its base and each alternative, connections kept. */
export function effectiveEntry(n: NeedsEntry): NeedsEntry {
  const eff = (a: NeedsAlt): NeedsAlt => ({ ...effectiveNeeds(a), ...(a.connections?.length && { connections: [...new Set(a.connections)] }) });
  return { ...eff(n), ...(n.anyOf && { anyOf: n.anyOf.map(eff) }) };
}

const UNUSABLE: ReadonlySet<ConnectionState> = new Set(['not-configured']);
const NONE: Needs = { origins: [], permissions: [] };
/** `reauth`: usable connections that are needs-reauth (the level stays; the Recipes page links to sign in again). */
interface Grants { granted: Granted; labels: Record<string, string>; reauth?: string[] }
interface Evaluated { key: string; kind?: NeedsKind; status: NeedStatus; origins: string[] }

/** The status of an (effective) entry given the grants. */
function statusOf(e: NeedsEntry, g: Grants): NeedStatus {
  const r = needsLevel(e, g.granted, g.labels);
  if (r.ok) return { ok: true, missing: { origins: [], permissions: [] }, ...(e.anyOf?.length && { level: r.level }) };
  const m = missingOf(e, g.granted) ?? union(alternativesOf(e).map((a) => missingOf(a, g.granted)));
  return { ok: false, missing: { origins: m?.origins ?? [], permissions: m?.permissions ?? [] }, reason: r.reason };
}

/** The kind of alternative an (effective) entry runs at, or undefined when paused. */
function kindOf(e: NeedsEntry, g: Grants): NeedsKind | undefined {
  const r = needsLevel(e, g.granted, g.labels);
  return r.ok ? altKind(alternativesOf(e)[r.level] ?? e) : undefined;
}

function union(ms: (ReturnType<typeof missingOf>)[]): Needs & { connections: string[] } {
  const list = (f: (m: NonNullable<ReturnType<typeof missingOf>>) => string[]) => [...new Set(ms.flatMap((m) => (m ? f(m) : [])))];
  return { origins: list((m) => m.origins), permissions: list((m) => m.permissions), connections: list((m) => m.connections) };
}

/**
 * The declared capability levels of recipe `recipeId` (M3-R69, positional kinds), from its effective needs entries
 * (rules without their own entry need nothing: titles). Locked copy: what the listed rules' alternatives of that kind
 * miss — hosts joined ", ", else connection labels joined " or " + " connection"; when the level is reached but a
 * listed rule is paused, what that rule's alternatives of the kind miss.
 */
export function levelStatuses(levels: readonly RecipeLevel[], recipeId: string, needs: Record<string, NeedsEntry>, g: Grants): LevelStatus[] {
  return levels.map((l, i) => {
    const kind = LEVEL_KINDS[Math.min(i, LEVEL_KINDS.length - 1)]!;
    const rules = l.rules.map((id) => {
      const e = needs[`${recipeId}/${id}`] ?? NONE;
      return { e, kind: kindOf(e, g), status: statusOf(e, g) };
    });
    const paused = rules.find((r) => r.kind === undefined);
    const reached = rules.some((r) => r.kind !== undefined && kindRank(r.kind) >= kindRank(kind));
    if (!paused && reached) {
      const reauth = [...new Set(rules.flatMap((r) => alternativesOf(r.e).filter((a) => altKind(a) === kind).flatMap((a) => a.connections ?? [])))]
        .filter((c) => g.reauth?.includes(c));
      return { id: l.id, label: l.label, available: true, ...(reauth.length && { reauth }) };
    }
    // Reached but blocked by a paused rule: what that rule's alternatives of this kind miss (an Allow button / a
    // Connections link like any locked level); only without such an alternative, its pause reason.
    const from = reached ? rules.filter((r) => r.kind === undefined) : rules;
    const missing = union(from.flatMap((r) => alternativesOf(r.e).filter((a) => altKind(a) === kind).map((a) => missingOf(a, g.granted))));
    if (reached && paused && !missing.connections.length && !missing.origins.length && !missing.permissions.length) {
      return { id: l.id, label: l.label, available: false, needs: (paused.status.reason ?? '').replace(/^Paused: needs /, '') };
    }
    const label = (c: string) => (Object.hasOwn(g.labels, c) ? g.labels[c] : c);
    const text = missing.connections.length ? `${missing.connections.map(label).join(' or ')} connection`
      : missing.origins.length ? missing.origins.map(hostOf).join(', ')
        : missing.permissions.length ? `the ${missing.permissions.join(', ')} permission` : `${kind} access`;
    return { id: l.id, label: l.label, available: false, needs: text, missing };
  });
}

/** UI text for a paused recipe or rule: `"Paused: needs access to <origin>"` (spec §6.10; wording in core/lang/needs.ts). */
export function pausedReason(missing: Needs): string {
  return `Paused: ${accessText(missing)}`;
}

const MATCH_PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/:*]+)(?::(\*|\d{1,5}))?(\/.*)$/;
const pathRegexes = new Map<string, RegExp>();

/**
 * Whether a Chrome match pattern (as in `needs.hosts`) matches `url`: scheme `*` = http or https; host `*`,
 * `*.<name>` (the name or any subdomain) or a name; no port = any port; the path glob covers path and query.
 */
export function matchesPattern(pattern: string, url: string): boolean {
  const m = MATCH_PATTERN.exec(pattern);
  if (!m) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (m[1] === '*' ? scheme !== 'http' && scheme !== 'https' : scheme !== m[1]) return false;
  const host = (m[2] as string).toLowerCase();
  if (host !== '*') {
    const name = host.startsWith('*.') ? host.slice(2) : host;
    if (u.hostname !== name && !(host.startsWith('*.') && u.hostname.endsWith(`.${name}`))) return false;
  }
  if (m[3] !== undefined && m[3] !== '*' && (u.port || (scheme === 'https' ? '443' : '80')) !== m[3]) return false;
  const path = m[4] as string;
  let re = pathRegexes.get(path);
  if (!re) {
    re = new RegExp(`^${path.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    pathRegexes.set(path, re);
  }
  return re.test(u.pathname + u.search);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
/** Recipe id of a needs key (`<recipeId>` or `<recipeId>/<ruleId>`). */
const recipeOf = (key: string) => key.split('/')[0] as string;

export class PermissionsManager {
  private pausedSet: ReadonlySet<string> = new Set();
  /** Per needs key, the kind of alternative it runs at (absent: paused), from the last sync. */
  private kinds = new Map<string, NeedsKind | undefined>();
  /** Origins the watch is registered for; undefined until the first sync (the persisted registration is unknown). */
  private registered?: string[];
  /** `registered` is what is actually registered now: false before the first sync and after a failed sync (I1). */
  private registrationKnown = false;
  private chain: Promise<void> = Promise.resolve();
  private markReady!: () => void;
  /**
   * Resolves once the first onChanged() sync has finished, whether it succeeded or not (a failed sync or a missing
   * `scripting` still resolves it). Until then paused() is empty, so engine steps that act on it await this.
   */
  readonly ready: Promise<void> = new Promise((r) => { this.markReady = r; });

  constructor(
    private readonly port: BrowserPort,
    private readonly getProgram: () => Promise<Program>,
    private readonly scripting: WatchScripting,
    private readonly opts: PermissionsOptions = {},
  ) {}

  /** Recipe ids and rule keys waiting for a permission (ProgramCache's `paused`). */
  paused(): ReadonlySet<string> {
    return this.pausedSet;
  }

  /**
   * Which of `needs` (made effective: host needs add `scripting`) are not granted. With `anyOf`, ok means some
   * alternative is granted (`level` = its index); otherwise `missing` lists what the alternatives miss.
   */
  async check(needs: Needs | NeedsEntry): Promise<NeedStatus> {
    const e = effectiveEntry(needs);
    return statusOf(e, await this.grants([e]));
  }

  /** Status per needs key of the current Program: recipe ids of enabled recipes (with their rules' and capability levels), plus rule keys with their own needs. */
  async status(): Promise<Record<string, KeyStatus>> {
    const { program, all, grants } = await this.evaluateProgram();
    const out: Record<string, KeyStatus> = Object.fromEntries(all.map((e) => [e.key, e.status]));
    for (const id of Object.keys(out).filter((k) => !k.includes('/'))) {
      const rules: Record<string, RuleLevel> = {};
      for (const e of all) {
        if (e.key.startsWith(`${id}/`)) rules[e.key] = e.status.ok ? { level: e.status.level ?? 0 } : { level: -1, paused: e.status.reason ?? 'Paused' };
      }
      const levels = program.levels?.[id];
      out[id] = { ...out[id]!, ...(Object.keys(rules).length && { rules }), ...(levels && { levels: levelStatuses(levels, id, this.effective(program), grants) }) };
    }
    return out;
  }

  /** The capability levels recipe `recipeId` declares in `program` (e.g. compiled as if enabled), or undefined. */
  async levels(program: Program, recipeId: string): Promise<LevelStatus[] | undefined> {
    const levels = program.levels?.[recipeId];
    if (!levels) return undefined;
    const needs = this.effective(program);
    return levelStatuses(levels, recipeId, needs, await this.grants(Object.values(needs)));
  }

  /**
   * The kind of alternative rule `ruleKey` runs at after the last sync (a rule without its own needs runs at its
   * recipe's), or undefined while it or its recipe is paused. Waits for the first sync. SourceService's level (M3-R65).
   */
  async levelFor(ruleKey: string): Promise<NeedsKind | undefined> {
    await this.ready;
    if (this.pausedSet.has(recipeOf(ruleKey))) return undefined;
    return this.kinds.has(ruleKey) ? this.kinds.get(ruleKey) : this.kinds.get(recipeOf(ruleKey));
  }

  private effective(program: Program): Record<string, NeedsEntry> {
    return Object.fromEntries(Object.entries(program.needs).map(([k, n]) => [k, effectiveEntry(n)]));
  }

  /** What of `entries` is granted: origins (exact or by a broader grant), permissions, and the usable connections. */
  private async grants(entries: NeedsEntry[]): Promise<Grants> {
    const alts = entries.flatMap((e) => [e, ...(e.anyOf ?? [])]);
    const wanted = [...new Set(alts.flatMap((a) => a.origins))];
    const granted = new Set(wanted.length ? await this.port.grantedOrigins() : []);
    const origins: string[] = [];
    // An exact grant is the common case (we request exactly these patterns); contains() also honors broader grants.
    for (const o of wanted) if (granted.has(o) || (await this.port.hasPermission({ origins: [o] }))) origins.push(o);
    const permissions: string[] = [];
    for (const p of new Set(alts.flatMap((a) => a.permissions))) if (await this.port.hasPermission({ permissions: [p] })) permissions.push(p);
    const labels: Record<string, string> = {};
    const connections: string[] = [];
    const reauth: string[] = [];
    if (this.opts.connections && alts.some((a) => a.connections?.length)) {
      for (const c of await this.opts.connections()) {
        labels[c.id] = c.label;
        if (!UNUSABLE.has(c.state)) connections.push(c.id);
        if (c.state === 'needs-reauth') reauth.push(c.id);
      }
    }
    return { granted: { origins, permissions, connections }, labels, reauth };
  }

  /** Every needs key's status and kind, plus `origins`: its granted host origins, alternatives included (the watch). */
  private async evaluateProgram(): Promise<{ program: Program; grants: Grants; all: Evaluated[] }> {
    const program = await this.getProgram();
    const needs = this.effective(program);
    const grants = await this.grants(Object.values(needs));
    const all = Object.entries(needs).map(([key, e]) => ({
      key, kind: kindOf(e, grants), status: statusOf(e, grants),
      origins: [e, ...(e.anyOf ?? [])].flatMap((a) => a.origins).filter((o) => grants.granted.origins.includes(o)),
    }));
    return { program, grants, all };
  }

  /** R44: every granted host origin when an enabled user rule uses page facts (and `scripting` is held); else none. */
  private async userRuleOrigins(p: Program): Promise<string[]> {
    if (!p.rules.some((r) => r.key.startsWith('user/') && usesPageFacts(r.rule))) return [];
    if (!(await this.port.hasPermission({ permissions: ['scripting'] }))) return [];
    return watchOrigins(await this.port.grantedOrigins());
  }

  /**
   * Whether the watch is registered for `url`: PageFacts arms its page-facts hold only there. Before the first sync
   * the registration is unknown, so every http(s) URL counts (a wrong guess costs a hold, not a missed fact).
   */
  covers(url: string): boolean {
    if (this.registered === undefined) return /^https?:\/\//i.test(url);
    return this.registered.some((o) => matchesPattern(o, url));
  }

  /**
   * Like covers(), but evidence-only (I1): false while the registration is unknown (before the first sync, after a
   * failed register or evaluation). For safety decisions (CloseExecutor's form observability), never the hold.
   */
  coversKnown(url: string): boolean {
    return this.registrationKnown && this.registered !== undefined && this.registered.some((o) => matchesPattern(o, url));
  }

  /**
   * Recompute the status, the paused set and the watch registration. Wire to permissions.onAdded / onRemoved, config
   * changes and worker start. Serialized; never rejects (problems are reported through `warn`).
   */
  onChanged(): Promise<void> {
    const run = this.chain.then(() => this.sync()).catch((e: unknown) => { this.warn('[tabchef] permission sync failed', e); });
    this.chain = run;
    void run.finally(() => this.markReady());
    return run;
  }

  private warn(message: string, e: unknown): void {
    (this.opts.warn ?? ((m: string, x: unknown) => console.warn(m, x)))(message, e);
  }

  private async sync(): Promise<void> {
    let all: Evaluated[];
    let extra: string[];
    try {
      const r = await this.evaluateProgram();
      all = r.all;
      extra = await this.userRuleOrigins(r.program);
    } catch (e) {
      this.registrationKnown = false;
      this.warn('[tabchef] permission status failed', e);
      return;
    }
    this.kinds = new Map(all.map((e) => [e.key, e.kind]));
    const paused = new Set(all.filter((e) => !e.status.ok).map((e) => e.key));
    if (!sameSet(paused, this.pausedSet)) {
      this.pausedSet = paused;
      this.opts.onPausedChanged?.();
    }
    // Granted origins of the needs that run: not paused, and not a rule of a paused recipe.
    const origins = watchOrigins([
      ...all.filter((e) => e.status.ok && !paused.has(recipeOf(e.key))).flatMap((e) => e.origins),
      ...extra,
    ]).sort();
    await this.register(origins);
  }

  private async register(origins: string[]): Promise<void> {
    let prev: string[] | false;
    try {
      prev = origins.length ? await this.scripting.register(origins) : await this.scripting.unregister();
    } catch (e) {
      this.registrationKnown = false;
      this.warn('[tabchef] watch registration failed', e);
      return;
    }
    this.registrationKnown = true;
    if (prev === false) {
      this.registered = []; // scripting not granted: nothing runs anywhere
      return;
    }
    this.registered = origins;
    const added = origins.filter((o) => !prev.includes(o));
    if (added.length === 0 || !this.scripting.inject) return;
    // A registration only reaches documents loaded after it: inject into the open tabs it now covers.
    try {
      const { tabs } = await this.port.snapshot();
      const ids = tabs.filter((t) => !t.discarded && !t.frozen && added.some((o) => matchesPattern(o, t.url))).map((t) => t.id);
      if (ids.length) await this.scripting.inject(ids);
    } catch (e) {
      this.warn('[tabchef] watch injection failed', e);
    }
  }
}
