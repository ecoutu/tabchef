// The page side of the watch content script (M2 T7); src/entrypoints/watch.content.ts only wires it to the page.
// Pulls its config with watch.hello (ruling R12), then reports page.facts whenever they change: which needles the
// page text contains (never the text itself), selector extract values, and whether a form field was edited.
import { MAX_EXTRACT_VALUE, type PageFactsMessage, type WatchConfigMessage, type WatchHelloMessage } from './messages';
import type { WatchConfig } from './page-facts';

/** DOM re-scans happen at most once per this many ms. */
export const WATCH_SCAN_MS = 1000;
export const MAX_EXTRACT_CHARS = MAX_EXTRACT_VALUE;

export interface PageWatchEnv {
  doc: Document;
  win: Window;
  /** runtime.sendMessage; resolves with the worker's answer. */
  send: (m: WatchHelloMessage | PageFactsMessage) => Promise<unknown>;
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
  /** The URL formEdited belongs to: a same-document navigation drops it, as the worker does (SafetyService). */
  let editedHref = '';
  let lastSent: string | undefined;
  let lastScan = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let stopped = false;

  const facts = (): PageFactsMessage => {
    const text = (doc.body?.textContent ?? '').toLowerCase();
    const texts = config.needles.filter((n) => text.includes(n.toLowerCase()));
    const extracts: Record<string, string> = {};
    for (const s of config.selectors) {
      let el: Element | null = null;
      try {
        el = doc.querySelector(s.selector);
      } catch {
        continue; // invalid selector
      }
      if (!el) continue;
      const v = s.attr !== undefined ? el.getAttribute(s.attr) : el.textContent;
      if (v !== null) extracts[s.key] = v.trim().slice(0, MAX_EXTRACT_CHARS);
    }
    if (formEdited && editedHref !== win.location.href) formEdited = false;
    return { type: 'page.facts', texts, extracts, formEdited };
  };

  const report = (force = false) => {
    if (stopped) return;
    const m = facts();
    const key = JSON.stringify(m);
    if (!force && key === lastSent) return;
    lastSent = key;
    void env.send(m).catch(() => {});
  };

  const scan = () => {
    timer = undefined;
    lastScan = now();
    report();
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

  const hello = async (force: boolean) => {
    const edited = formEdited && editedHref === win.location.href;
    let r: unknown;
    try {
      r = await env.send({ type: 'watch.hello', formEdited: edited });
    } catch {
      r = undefined; // worker unreachable: still report form edits
    }
    if (stopped) return;
    config = asConfig(r);
    observe();
    lastScan = now();
    report(force);
  };

  const onInput = (e: Event) => {
    if (!editable(e.target)) return;
    formEdited = true;
    editedHref = win.location.href;
    report();
  };
  const onSubmit = () => {
    formEdited = false;
    report();
  };
  // A back/forward-cache restore commits again, which cleared this page's facts in the worker: say hello again.
  const onPageShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) void hello(true);
  };
  win.addEventListener('input', onInput, true);
  win.addEventListener('submit', onSubmit, true);
  win.addEventListener('pageshow', onPageShow);
  void hello(true);

  return {
    stop() {
      stopped = true;
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      win.removeEventListener('input', onInput, true);
      win.removeEventListener('submit', onSubmit, true);
      win.removeEventListener('pageshow', onPageShow);
    },
  };
}
