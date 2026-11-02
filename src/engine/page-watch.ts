// The page side of the watch content script (M2 T7); src/entrypoints/watch.content.ts only wires it to the page.
// Pulls its config with watch.hello (ruling R12), then reports page.facts whenever they change: which needles the
// page text contains (never the text itself), selector extract values, and whether a form field was edited.
import { MAX_EXTRACT_VALUE, MAX_FACT_ITEMS, MAX_FACT_TEXT, type PageFactsMessage, type WatchConfigMessage, type WatchHelloMessage } from './messages';
import type { WatchConfig } from './page-facts';
import { foldText } from '../core/lang/fold-text';

/** DOM re-scans happen at most once per this many ms. */
export const WATCH_SCAN_MS = 1000;
export const MAX_EXTRACT_CHARS = MAX_EXTRACT_VALUE;

export interface PageWatchEnv {
  doc: Document;
  win: Window;
  /** runtime.sendMessage; resolves with the worker's answer. */
  send: (m: WatchHelloMessage | PageFactsMessage) => Promise<unknown>;
  /** The Navigation API (`window.navigation`, Chrome 102+): `currententrychange` reports same-document navigations. */
  nav?: EventTarget;
  now?: () => number;
}

const EMPTY: WatchConfig = { needles: [], selectors: [] };

function asConfig(r: unknown): WatchConfig {
  const x = r as Partial<WatchConfigMessage> | undefined;
  if (x?.type !== 'watch.config' || !Array.isArray(x.needles) || !Array.isArray(x.selectors)) return EMPTY;
  return {
    needles: x.needles.filter((n): n is string => typeof n === 'string' && n !== ''),
    selectors: x.selectors.filter((s) => typeof s?.key === 'string' && typeof s.selector === 'string'),
  };
}

function editable(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) return !['button', 'submit', 'reset', 'image', 'hidden'].includes(t.type);
  return t.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

export function startPageWatch(env: PageWatchEnv): { stop(): void } {
  const { doc, win } = env;
  const now = env.now ?? Date.now;
  let config = EMPTY;
  let formEdited = false;
  /** The elements holding edits: a submit clears only those in the submitted form (M5). */
  const editedEls = new Set<Element>();
  /** The URL formEdited belongs to: a same-document navigation drops it, as the worker does (SafetyService). */
  let editedHref = '';
  let lastSent: string | undefined;
  let lastScan = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let stopped = false;
  /** The URL the current config was asked for; a different location.href means a same-document navigation. */
  let configHref = win.location.href;
  /** Hellos sent; only the latest one's answer applies. While one is in flight, nothing is reported. */
  let helloSeq = 0;
  let helloPending = false;

  const facts = (): PageFactsMessage => {
    const text = foldText(doc.body?.textContent ?? '');
    // Within the worker's page.facts bounds (isPageFactsMessage), so a report is never rejected (I2).
    const texts = config.needles.filter((n) => n.length <= MAX_FACT_TEXT && text.includes(foldText(n))).slice(0, MAX_FACT_ITEMS);
    const extracts: Record<string, string> = {};
    let nExtracts = 0;
    for (const s of config.selectors) {
      if (s.key.length > MAX_FACT_TEXT || nExtracts >= MAX_FACT_ITEMS) continue;
      let el: Element | null = null;
      try {
        el = doc.querySelector(s.selector);
      } catch {
        continue; // invalid selector
      }
      if (!el) continue;
      const v = s.attr !== undefined ? el.getAttribute(s.attr) : el.textContent;
      if (v === null) continue;
      if (!Object.prototype.hasOwnProperty.call(extracts, s.key)) nExtracts++;
      extracts[s.key] = v.trim().slice(0, MAX_EXTRACT_CHARS);
    }
    if (formEdited && editedHref !== win.location.href) { formEdited = false; editedEls.clear(); }
    return { type: 'page.facts', texts, extracts, formEdited };
  };

  const report = (force = false) => {
    if (stopped || helloPending) return; // the fresh report follows the hello's answer
    const m = facts();
    const key = JSON.stringify(m);
    if (!force && key === lastSent) return;
    lastSent = key;
    void env.send(m).catch(() => {});
  };

  const scan = () => {
    timer = undefined;
    lastScan = now();
    if (!checkHref()) report();
  };

  /** Throttled: a burst of mutations yields one scan, at most one per WATCH_SCAN_MS. */
  const requestScan = () => {
    if (timer !== undefined || stopped) return;
    timer = setTimeout(scan, Math.max(0, lastScan + WATCH_SCAN_MS - now()));
  };

  const observe = () => {
    observer?.disconnect();
    observer = undefined;
    if (!doc.body || (config.needles.length === 0 && config.selectors.length === 0)) return;
    observer = new MutationObserver(requestScan);
    observer.observe(doc.body, {
      childList: true, subtree: true, characterData: true, attributes: config.selectors.some((s) => s.attr !== undefined),
    });
  };

  // The worker clears this tab's facts on every hello and answers with the config for the URL it came from.
  async function hello(force: boolean): Promise<void> {
    const seq = ++helloSeq;
    helloPending = true;
    configHref = win.location.href;
    const edited = formEdited && editedHref === configHref;
    let r: unknown;
    try {
      r = await env.send({ type: 'watch.hello', formEdited: edited });
    } catch {
      r = undefined; // worker unreachable: still report form edits
    }
    if (stopped || seq !== helloSeq) return;
    helloPending = false;
    config = asConfig(r);
    observe();
    lastScan = now();
    report(force);
  }

  /**
   * A same-document navigation (pushState, popstate, Navigation API): the config was filtered by the old URL, so ask
   * again; the old texts/extracts are dropped (the next report is built from the new config). True when it re-helloed.
   */
  function checkHref(): boolean {
    if (stopped || win.location.href === configHref) return false;
    void hello(true);
    return true;
  }

  const onInput = (e: Event) => {
    if (!editable(e.target)) return;
    editedEls.add(e.target as Element);
    formEdited = true;
    editedHref = win.location.href;
    if (!checkHref()) report();
  };
  const onSubmit = (e: Event) => {
    const form = e.target;
    if (!(form instanceof Element)) return;
    // Only the submitted form's fields are sent; a draft elsewhere on the page still holds unsaved edits.
    for (const el of editedEls) {
      if (form.contains(el) || (el as Partial<HTMLInputElement>).form === form) editedEls.delete(el);
    }
    formEdited = editedEls.size > 0;
    report();
  };
  // A back/forward-cache restore commits again, which cleared this page's facts in the worker: say hello again.
  const onPageShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) void hello(true);
  };
  win.addEventListener('input', onInput, true);
  win.addEventListener('submit', onSubmit, true);
  win.addEventListener('pageshow', onPageShow);
  const onUrlMaybeChanged = () => { checkHref(); };
  win.addEventListener('popstate', onUrlMaybeChanged);
  const nav = env.nav ?? (win as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('currententrychange', onUrlMaybeChanged);
  void hello(true);

  return {
    stop() {
      stopped = true;
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      win.removeEventListener('input', onInput, true);
      win.removeEventListener('submit', onSubmit, true);
      win.removeEventListener('pageshow', onPageShow);
      win.removeEventListener('popstate', onUrlMaybeChanged);
      nav?.removeEventListener('currententrychange', onUrlMaybeChanged);
    },
  };
}
