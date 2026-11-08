import { browser } from 'wxt/browser';

export interface RecentlyClosedInput {
  url: string; title: string; groupTitle?: string; windowId: number; reason: string; ruleId?: string; at: number;
  /** The closed tab's id: undo gives the tab it reopens to the project's manual entry that held this id (#150). */
  tabId?: number;
}
export type RecentlyClosedItem = RecentlyClosedInput & { id: string };

export const RECENTLY_CLOSED_KEY = 'recentlyClosed';
export const RECENTLY_CLOSED_MAX = 100;

/** The last 100 tabs Tabchef closed (newest first), persisted to storage.local. */
export class RecentlyClosed {
  private items: RecentlyClosedItem[] = [];
  private chain: Promise<void>;
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load();
    this.chain = this.ready;
  }

  private async load(): Promise<void> {
    try {
      const stored = (await browser.storage.local.get(RECENTLY_CLOSED_KEY))[RECENTLY_CLOSED_KEY];
      if (Array.isArray(stored)) this.items = [...this.items, ...(stored as RecentlyClosedItem[])].slice(0, RECENTLY_CLOSED_MAX);
    } catch {
      /* start empty */
    }
  }

  private persist(): void {
    this.chain = this.chain.then(() => browser.storage.local.set({ [RECENTLY_CLOSED_KEY]: this.items })).catch(() => {});
  }

  /** Resolves when pending writes have landed. */
  idle(): Promise<void> {
    return this.chain;
  }

  add(e: RecentlyClosedInput): string {
    const id = `rc-${e.at.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.items.unshift({ ...e, id });
    if (this.items.length > RECENTLY_CLOSED_MAX) this.items.length = RECENTLY_CLOSED_MAX;
    this.persist();
    return id;
  }

  list(): RecentlyClosedItem[] {
    return [...this.items];
  }

  take(id: string): RecentlyClosedItem | undefined {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [item] = this.items.splice(i, 1);
    this.persist();
    return item;
  }
}
