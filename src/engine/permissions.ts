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
import type { BrowserPort } from '../platform/browser-port';
import type { Program } from '../core/lang/types';
import { accessText } from '../core/lang/needs';
import { usesPageFacts } from './page-facts';
import { watchOrigins, type WatchScripting } from './watch-registration';

export type { WatchScripting } from './watch-registration';

export interface Needs { origins: string[]; permissions: string[] }
export interface NeedStatus { ok: boolean; missing: Needs; reason?: string }

export interface PermissionsOptions {
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

  /** Which of `needs` (made effective: host needs add `scripting`) are not granted. */
  async check(needs: Needs): Promise<NeedStatus> {
    const n = effectiveNeeds(needs);
    const granted = new Set(n.origins.length ? await this.port.grantedOrigins() : []);
    const origins: string[] = [];
    // An exact grant is the common case (we request exactly these patterns); contains() also honors broader grants.
    for (const o of n.origins) if (!granted.has(o) && !(await this.port.hasPermission({ origins: [o] }))) origins.push(o);
    const permissions: string[] = [];
    for (const p of n.permissions) if (!(await this.port.hasPermission({ permissions: [p] }))) permissions.push(p);
    const missing = { origins, permissions };
    return origins.length || permissions.length ? { ok: false, missing, reason: pausedReason(missing) } : { ok: true, missing };
  }

  /** Status per needs key of the current Program: recipe ids of enabled recipes, plus rule keys with their own needs. */
  async status(): Promise<Record<string, NeedStatus>> {
    return Object.fromEntries((await this.evaluateProgram()).all.map((e) => [e.key, e.status]));
  }

  private async evaluateProgram(): Promise<{ program: Program; all: { key: string; needs: Needs; status: NeedStatus }[] }> {
    const program = await this.getProgram();
    const all: { key: string; needs: Needs; status: NeedStatus }[] = [];
    for (const [key, needs] of Object.entries(program.needs)) all.push({ key, needs, status: await this.check(needs) });
    return { program, all };
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
    let all: { key: string; needs: Needs; status: NeedStatus }[];
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
    const paused = new Set(all.filter((e) => !e.status.ok).map((e) => e.key));
    if (!sameSet(paused, this.pausedSet)) {
      this.pausedSet = paused;
      this.opts.onPausedChanged?.();
    }
    // Granted origins of the needs that run: not paused, and not a rule of a paused recipe.
    const origins = watchOrigins([
      ...all.filter((e) => e.status.ok && !paused.has(recipeOf(e.key))).flatMap((e) => e.needs.origins),
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
