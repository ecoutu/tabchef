import { browser } from 'wxt/browser';

export interface WhyEntry { tabId?: number; ruleId?: string; action: string; detail: string; at: number }

export const WHY_LOG_KEY = 'whyLog';
export const WHY_LOG_MAX = 1000;
const DEBOUNCE_MS = 1000;
/** Steady activity must not postpone the write forever. */
const MAX_WAIT_MS = 5000;

/** Ring buffer of the last 1000 engine decisions, persisted to storage.local (debounced 1 s). */
export class WhyLog {
  private entries: WhyEntry[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private dirtySince = 0;
  /** Resolves once persisted entries were merged beneath anything added meanwhile. */
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const stored = (await browser.storage.local.get(WHY_LOG_KEY))[WHY_LOG_KEY];
      if (Array.isArray(stored)) this.entries = [...(stored as WhyEntry[]), ...this.entries].slice(-WHY_LOG_MAX);
    } catch {
      /* start empty */
    }
  }

  add(e: WhyEntry): void {
    this.entries.push(e);
    if (this.entries.length > WHY_LOG_MAX) this.entries.shift();
    const now = Date.now();
    if (this.timer !== undefined) clearTimeout(this.timer);
    else this.dirtySince = now;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, Math.max(0, Math.min(DEBOUNCE_MS, this.dirtySince + MAX_WAIT_MS - now)));
  }

  async flush(): Promise<void> {
    await this.ready;
    await browser.storage.local.set({ [WHY_LOG_KEY]: this.entries }).catch(() => {});
  }

  all(): WhyEntry[] {
    return [...this.entries];
  }

  forTab(tabId: number): WhyEntry[] {
    return this.entries.filter((e) => e.tabId === tabId);
  }

  /** Entries in the buffer attributed to the rule. */
  hits(ruleId: string): number {
    return this.entries.filter((e) => e.ruleId === ruleId).length;
  }
}
