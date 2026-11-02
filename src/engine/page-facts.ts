// Page facts per tab, reported by the watch content script (M2 T7): which pageText needles matched, selector extract
// values and whether a form was edited. Held in memory, mirrored to storage.session (key `pageFacts`) so a restarted
// worker keeps them; cleared on a top-frame navigation (onCommitted) and when the tab is removed.
import { compilePattern } from '../core/match/pattern';
import type { Cond, Program, Rule, TabFacts } from '../core/lang/types';
import type { PageLookup } from '../core/group/plan';

export type PageFactsData = NonNullable<TabFacts['page']>;
export interface WatchSelector { key: string; selector: string; attr?: string }
export interface WatchConfig { needles: string[]; selectors: WatchSelector[] }

export const PAGE_FACTS_KEY = 'pageFacts';
/** How long after a navigation the planner holds a tab whose group outcome waits on its page facts. */
export const PAGE_HOLD_MS = 5000;
/** How many replaced documents per tab PageFacts remembers (isRetiredDocument). */
export const RETIRED_DOCS_MAX = 4;

export interface PageFactsDeps {
  session: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
  now?: () => number;
  /** A hold expired without facts: re-plan so the held tab is grouped after all (background: reconciler.schedule). */
  onHoldExpired?: () => void;
  /**
   * Whether the watch script is registered for `url` (background: PermissionsManager.covers). A commit elsewhere
   * arms no hold: no facts will come (no scripting, an ungranted host, a non-http page). Default: every URL.
   */
  covers?: (url: string) => boolean;
}

const isFacts = (v: unknown): v is PageFactsData => {
  if (typeof v !== 'object' || v === null) return false;
  const x = v as Record<string, unknown>;
  return Array.isArray(x.texts) && x.texts.every((t) => typeof t === 'string')
    && typeof x.extracts === 'object' && x.extracts !== null && Object.values(x.extracts).every((t) => typeof t === 'string')
    && typeof x.formEdited === 'boolean';
};

/** Three-valued "could this condition be true at `url`": only url conditions are known here; the rest may go either way. */
function urlMay(c: Cond, url: string): boolean | undefined {
  if (typeof c !== 'object' || c === null) return false;
  const [k] = Object.keys(c);
  const v = (c as Record<string, unknown>)[k as string];
  switch (k) {
    case 'url':
      return (Array.isArray(v) ? v : [v]).some((p) => {
        try {
          return typeof p === 'string' && compilePattern(p)(url) !== null;
        } catch {
          return false;
        }
      });
    case 'all': {
      const rs = (v as Cond[]).map((x) => urlMay(x, url));
      return rs.includes(false) ? false : rs.every((r) => r === true) ? true : undefined;
    }
    case 'any': {
      const rs = (v as Cond[]).map((x) => urlMay(x, url));
      return rs.includes(true) ? true : rs.every((r) => r === false) ? false : undefined;
    }
    case 'not': {
      const r = urlMay(v as Cond, url);
      return r === undefined ? undefined : !r;
    }
    default:
      return undefined;
  }
}

/** pageText needles of a condition (not under `opener`: an opener's page is never watched). */
function needlesOf(c: Cond, out: string[]): void {
  if (typeof c !== 'object' || c === null) return;
  const [k] = Object.keys(c);
  const v = (c as Record<string, unknown>)[k as string];
  if (k === 'pageText') {
    for (const n of Array.isArray(v) ? v : [v]) if (typeof n === 'string' && n !== '') out.push(n);
  } else if (k === 'all' || k === 'any') {
    for (const x of v as Cond[]) needlesOf(x, out);
  } else if (k === 'not') {
    needlesOf(v as Cond, out);
  }
}

/**
 * Whether a rule reads page facts the watch reports: a pageText condition (not under `opener`) or a selector extract,
 * the same parts watchConfigFor collects. (formEdited is a safety fact, not a rule condition.) Ruling R44.
 */
export function usesPageFacts(r: Rule): boolean {
  const needles: string[] = [];
  needlesOf(r.match, needles);
  return needles.length > 0 || Object.values(r.extract ?? {}).some((x) => 'selector' in x);
}

export class PageFacts implements PageLookup {
  private readonly facts = new Map<number, PageFactsData>();
  /** Tabs set or cleared before the stored mirror loaded: their live value wins over the stored one. */
  private readonly touched = new Set<number>();
  /** Top-frame commit time per tab, while its facts are outstanding (this worker's lifetime only). */
  private readonly committedAt = new Map<number, number>();
  private readonly holdTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The tab's current top-frame document (webNavigation / sender documentId), where known. */
  private readonly docs = new Map<number, string>();
  /**
   * Per tab, the last RETIRED_DOCS_MAX documents a commit replaced (oldest first). A message from one of them is stale
   * for sure, unlike a document not seen yet: a new page's hello can reach the worker before its own commit.
   */
  private readonly retired = new Map<number, string[]>();
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  readonly ready: Promise<void>;

  constructor(private readonly deps: PageFactsDeps) {
    this.now = deps.now ?? Date.now;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const stored = await this.deps.session.get(PAGE_FACTS_KEY);
      if (Array.isArray(stored)) {
        for (const e of stored) {
          if (!Array.isArray(e) || typeof e[0] !== 'number' || !isFacts(e[1])) continue;
          if (!this.touched.has(e[0])) this.facts.set(e[0], e[1]);
        }
      }
    } catch {
      /* start empty */
    } finally {
      this.loaded = true;
      this.touched.clear();
    }
  }

  get(tabId: number): PageFactsData | undefined {
    return this.facts.get(tabId);
  }

  set(tabId: number, facts: PageFactsData): void {
    this.facts.set(tabId, facts);
    this.endHold(tabId);
    this.save(tabId);
  }

  /** Wire to tabs.onRemoved (and the replaced tab of tabs.onReplaced). */
  clear(tabId: number): void {
    this.retired.delete(tabId);
    this.docs.delete(tabId);
    this.clearFacts(tabId);
  }

  private clearFacts(tabId: number): void {
    this.endHold(tabId);
    if (this.facts.delete(tabId) || !this.loaded) this.save(tabId);
  }

  /**
   * Wire to webNavigation.onCommitted (frameId 0) with the committed URL: the new document's facts are not known until
   * its watch reports, so the planner holds the tab, but only where the watch runs (`covers`). `documentId` is the new
   * document's, so a late report from the previous one can be told apart (isCurrentDocument), and the previous one is
   * retired (isRetiredDocument). A re-commit of a retired document (back/forward-cache restore) makes it current
   * again. Only commits change the current document or retire one: a hello never does (onHello).
   */
  onCommitted(tabId: number, url?: string, documentId?: string): void {
    const previous = this.docs.get(tabId);
    this.clearFacts(tabId);
    this.docs.delete(tabId);
    if (documentId !== undefined) {
      const retired = (this.retired.get(tabId) ?? []).filter((d) => d !== documentId);
      if (previous !== undefined && previous !== documentId) retired.push(previous);
      if (retired.length) this.retired.set(tabId, retired.slice(-RETIRED_DOCS_MAX));
      else this.retired.delete(tabId);
      this.docs.set(tabId, documentId);
    }
    if (url !== undefined && this.deps.covers && !this.deps.covers(url)) return;
    this.committedAt.set(tabId, this.now());
  }

  /**
   * A watch.hello from the tab's current document (or one not known to differ): a new page state (load, same-document
   * navigation, back/forward-cache restore). Drops the facts and holds the tab until the fresh report that follows the
   * hello's answer (the watch is evidently running, so always). The current document and retired ones stay as they are.
   */
  onHello(tabId: number): void {
    this.clearFacts(tabId);
    this.committedAt.set(tabId, this.now());
  }

  /** False only when both ids are known and differ: a report from a document the tab has since navigated away from. */
  isCurrentDocument(tabId: number, documentId: string | undefined): boolean {
    const current = this.docs.get(tabId);
    return documentId === undefined || current === undefined || current === documentId;
  }

  /** A document a commit in the tab has replaced (and not restored since): its messages are stale. */
  isRetiredDocument(tabId: number, documentId: string | undefined): boolean {
    return documentId !== undefined && (this.retired.get(tabId)?.includes(documentId) ?? false);
  }

  /** No facts yet for the tab's current document, which committed less than PAGE_HOLD_MS ago (PageLookup). */
  awaiting(tabId: number): boolean {
    const at = this.committedAt.get(tabId);
    if (at === undefined || this.facts.has(tabId)) return false;
    const left = at + PAGE_HOLD_MS - this.now();
    if (left <= 0) {
      this.endHold(tabId);
      return false;
    }
    // Armed lazily, only for tabs the planner actually holds: on expiry the planner must look again.
    if (!this.holdTimers.has(tabId)) {
      this.holdTimers.set(tabId, setTimeout(() => {
        this.holdTimers.delete(tabId);
        this.committedAt.delete(tabId);
        this.deps.onHoldExpired?.();
      }, left));
    }
    return true;
  }

  /**
   * What the watch content script at `url` should look for: the pageText needles and selector extracts of every
   * program rule whose URL condition can match `url` (a rule without one counts as matching). Selector keys are
   * `<ruleKey>.<name>`, the names evaluateTab reads back from `page.extracts`.
   */
  watchConfigFor(url: string, p: Program): WatchConfig {
    const needles: string[] = [];
    const selectors: WatchSelector[] = [];
    for (const r of p.rules) {
      if (urlMay(r.rule.match, url) === false) continue;
      needlesOf(r.rule.match, needles);
      for (const [name, x] of Object.entries(r.rule.extract ?? {})) {
        if ('selector' in x) selectors.push({ key: `${r.key}.${name}`, selector: x.selector, ...(x.attr !== undefined && { attr: x.attr }) });
      }
    }
    return { needles: [...new Set(needles)], selectors };
  }

  /** Resolves when queued storage writes have landed (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private endHold(tabId: number): void {
    this.committedAt.delete(tabId);
    const t = this.holdTimers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    this.holdTimers.delete(tabId);
  }

  private save(tabId: number): void {
    if (!this.loaded) this.touched.add(tabId);
    // Written after the load so the mirror is never replaced by a partial map.
    this.chain = this.chain.then(() => this.ready).then(
      () => this.deps.session.set(PAGE_FACTS_KEY, [...this.facts]),
    ).then(() => {}, () => {});
  }
}
