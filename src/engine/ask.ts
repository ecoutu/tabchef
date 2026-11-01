import { findDuplicate, tabUrl } from '../core/dedupe/find';
import { evaluateGroupRules } from '../core/group/evaluate';
import { normalizeUrl } from '../core/url/normalize';
import type { Config, TabSnap } from '../core/types';
import type { BrowserPort } from '../platform/browser-port';
import type { BannerChoice, BannerShowMessage } from './messages';
import { withFragment, type LogEntry, type RecentlyClosedEntry } from './dedupe-handler';

export const PENDING_KEY = 'dedupe.pending';
export const NOTIFICATION_PREFIX = 'dedupe:';

export interface PendingAsk { newTabId: number; existingTabId: number; key: string; at: number }

type SessionStore = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };

/** The slice of chrome.* the ask prompt needs beyond BrowserPort; injected so the logic is testable. */
export interface AskApi {
  /** chrome.scripting.executeScript({ target: { tabId }, files: [file] }) */
  executeScript(tabId: number, file: string): Promise<void>;
  /** Resolves with the content script's reply (an ack `{ ok: true }` once the banner is rendered). */
  sendMessage(tabId: number, message: BannerShowMessage): Promise<unknown>;
  /** Resolves true when the tab reports status 'complete', false on timeout or if the tab is gone. */
  waitForComplete(tabId: number, timeoutMs: number): Promise<boolean>;
  createNotification(id: string, opts: { title: string; message: string; buttons: { title: string }[] }): Promise<void>;
  clearNotification(id: string): Promise<void>;
  listNotificationIds(): Promise<string[]>;
  session: SessionStore;
}

export interface AskDeps {
  api: AskApi;
  /** Built path of the runtime-registered banner content script, e.g. '/content-scripts/banner.js'. */
  bannerFile: string;
  getConfig: () => Promise<Config>;
  updateConfig: (fn: (c: Config) => Config) => Promise<void>;
  recentlyClosed: { add(e: RecentlyClosedEntry): string };
  log: { add(e: LogEntry): void };
  isLocked?: (tabId: number) => boolean;
  /** Called (fire-and-forget) after an ask-mode close, with the focused existing tab; used for the undo toast. */
  onClosed?: (entryId: string, entry: RecentlyClosedEntry, focused: TabSnap) => void;
  /** How long to wait for the tab to finish loading before giving up on the banner. Default 10 s. */
  completeTimeoutMs?: number;
  now?: () => number;
}

export async function listPendingAsks(session: Pick<SessionStore, 'get'>): Promise<PendingAsk[]> {
  try {
    const v = await session.get(PENDING_KEY);
    return Array.isArray(v) ? (v as PendingAsk[]) : [];
  } catch {
    return [];
  }
}

const originOf = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Ask-mode prompt. `ask` resolves as soon as the prompt is shown or queued (never waits for the answer); answers arrive
 * later through handleChoice / onNotificationButton / resolvePending. Order of preference: in-page banner,
 * notification, pending list + badge. Optional permissions are only checked, never requested.
 */
export function createAskController(port: BrowserPort, deps: AskDeps) {
  const now = deps.now ?? Date.now;
  const { api } = deps;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const writePending = async (list: PendingAsk[]): Promise<void> => {
    await api.session.set(PENDING_KEY, list);
    await port.setBadge(list.length ? String(list.length) : '');
  };
  const mutatePending = (fn: (l: PendingAsk[]) => PendingAsk[]) =>
    serial(async () => {
      const before = await listPendingAsks(api.session);
      const after = fn(before);
      if (after.length === before.length && after.every((p, i) => p === before[i])) return;
      await writePending(after);
    });

  const dropPair = (newTabId: number, existingTabId: number) =>
    mutatePending((l) => l.filter((p) => !(p.newTabId === newTabId && p.existingTabId === existingTabId)));

  const hostPattern = (url: string): string | undefined => {
    try {
      const u = new URL(url);
      // Permission match patterns carry no port.
      return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.hostname}/*` : undefined;
    } catch {
      return undefined;
    }
  };

  const bannerEligible = async (t: TabSnap): Promise<boolean> => {
    if (t.discarded || t.frozen) return false;
    const origin = hostPattern(t.url);
    if (origin === undefined) return false;
    return (await port.hasPermission({ origins: [origin] })) && (await port.hasPermission({ permissions: ['scripting'] }));
  };

  /** True once the content script acked that the banner is on screen. */
  async function tryBanner(newTab: TabSnap, existing: TabSnap, groupTitle: string | undefined): Promise<boolean> {
    if (!(await bannerEligible(newTab))) return false;
    try {
      if (!(await api.waitForComplete(newTab.id, deps.completeTimeoutMs ?? 10_000))) return false;
      // State may have changed while loading: re-check it is still safe to inject.
      const live = (await port.snapshot()).tabs.find((t) => t.id === newTab.id);
      if (!live || !(await bannerEligible(live))) return false;
      await api.executeScript(newTab.id, deps.bannerFile);
      const reply = await api.sendMessage(newTab.id, {
        type: 'banner.show',
        payload: {
          kind: 'duplicate', existingTitle: existing.title, tabId: newTab.id, existingTabId: existing.id,
          ...(groupTitle ? { groupTitle } : {}),
        },
      });
      return (reply as { ok?: unknown } | undefined)?.ok === true;
    } catch {
      return false;
    }
  }

  async function tryNotification(newTab: TabSnap, existing: TabSnap): Promise<boolean> {
    if (!(await port.hasPermission({ permissions: ['notifications'] }))) return false;
    try {
      await api.createNotification(`${NOTIFICATION_PREFIX}${newTab.id}:${existing.id}`, {
        title: 'Duplicate tab',
        message: `"${existing.title}" is already open.`,
        buttons: [{ title: 'Switch' }, { title: 'Keep both' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Banner (acked) or notification; a delivered prompt is dropped from the pending list. Otherwise it stays pending. */
  async function deliver(newTab: TabSnap, existing: TabSnap): Promise<void> {
    try {
      const snap = await port.snapshot();
      const live = snap.tabs.find((t) => t.id === newTab.id);
      if (!live) return;
      const groupTitle = snap.groups.find((g) => g.id === existing.groupId)?.title || undefined;
      if (await tryBanner({ ...live, url: newTab.url }, existing, groupTitle) || await tryNotification(newTab, existing)) {
        await dropPair(newTab.id, existing.id);
      }
    } catch {
      /* stays pending */
    }
  }

  const inflight = new Set<Promise<void>>();

  /** Records the pair as pending (badge), resolves, and delivers the prompt in the background. */
  async function ask(newTab: TabSnap, existing: TabSnap): Promise<void> {
    const cfg = await deps.getConfig();
    const key = normalizeUrl(newTab.url, cfg.dedupe)?.key ?? newTab.url;
    await mutatePending((l) => [
      ...l.filter((p) => !(p.newTabId === newTab.id && p.existingTabId === existing.id)),
      { newTabId: newTab.id, existingTabId: existing.id, key, at: now() },
    ]);
    const p = deliver(newTab, existing).finally(() => inflight.delete(p));
    inflight.add(p);
  }

  /** Resolves when all background prompt deliveries have finished (tests). */
  const settled = async (): Promise<void> => {
    while (inflight.size) await Promise.all([...inflight]);
  };

  /** Re-checks with dedupe semantics, then closes the new tab and focuses the existing one. Skips silently on mismatch. */
  async function switchTo(newTabId: number, existingTabId: number): Promise<void> {
    const cfg = await deps.getConfig();
    const s = cfg.dedupe;
    const snap = await port.snapshot();
    const cand = snap.tabs.find((t) => t.id === newTabId);
    const existing = snap.tabs.find((t) => t.id === existingTabId);
    if (!cand || !existing) return;
    const cur: TabSnap = { ...cand, url: tabUrl(cand) };
    delete cur.pendingUrl;
    const isLocked = deps.isLocked ?? (() => false);
    const ruleId = evaluateGroupRules(cur, cfg.groupRules)?.ruleId;
    const ruleMode = ruleId !== undefined ? cfg.groupRules.find((r) => r.id === ruleId)?.dedupe : undefined;
    const dup = findDuplicate(cur, [existing], s, ruleMode, new Set(isLocked(newTabId) ? [newTabId] : []));
    if (!dup) return;
    const at = now();
    const groupTitle = snap.groups.find((g) => g.id === cand.groupId)?.title;
    const entry: RecentlyClosedEntry = {
      url: cur.url, title: cand.title, windowId: cand.windowId, reason: 'duplicate', at,
      ...(groupTitle !== undefined ? { groupTitle } : {}),
      ...(ruleId !== undefined ? { ruleId } : {}),
    };
    const entryId = deps.recentlyClosed.add(entry);
    await port.closeTab(newTabId);
    await port.focusTab(existing.id, existing.windowId, s.followFragment ? withFragment(tabUrl(existing), dup.fragment) : undefined);
    deps.log.add({
      tabId: newTabId, action: 'dedupe-close', detail: `Closed duplicate of tab ${existing.id} (${existing.title}) after ask`, at,
      ...(ruleId !== undefined ? { ruleId } : {}),
    });
    deps.onClosed?.(entryId, entry, existing);
  }

  async function addAlwaysSwitchSite(url: string): Promise<void> {
    const origin = originOf(url);
    if (origin === undefined) return;
    const pattern = `${origin}/*`;
    await deps.updateConfig((c) => (c.dedupe.alwaysSwitchSites ?? []).includes(pattern)
      ? c
      : { ...c, dedupe: { ...c.dedupe, alwaysSwitchSites: [...(c.dedupe.alwaysSwitchSites ?? []), pattern] } });
  }

  async function handleChoice(newTabId: number, existingTabId: number, choice: BannerChoice): Promise<void> {
    await dropPair(newTabId, existingTabId);
    if (choice === 'keep') return;
    if (choice === 'always-switch-site') {
      const t = (await port.snapshot()).tabs.find((x) => x.id === newTabId);
      if (t) await addAlwaysSwitchSite(tabUrl(t));
    }
    await switchTo(newTabId, existingTabId);
  }

  const parseId = (id: string): { newTabId: number; existingTabId: number } | undefined => {
    const m = /^dedupe:(\d+):(\d+)$/.exec(id);
    return m ? { newTabId: Number(m[1]), existingTabId: Number(m[2]) } : undefined;
  };

  async function onNotificationButton(id: string, buttonIndex: number): Promise<void> {
    const p = parseId(id);
    if (!p) return;
    if (buttonIndex === 0) await switchTo(p.newTabId, p.existingTabId);
  }

  /** Closing a notification without a choice means keep both. */
  async function onNotificationClosed(id: string): Promise<void> {
    void id;
  }

  /** Popup Duplicates tab: act on a pending entry. */
  async function resolvePending(newTabId: number, existingTabId: number, choice: 'switch' | 'keep'): Promise<void> {
    await dropPair(newTabId, existingTabId);
    if (choice === 'switch') await switchTo(newTabId, existingTabId);
  }

  /** Call from tabs.onRemoved. */
  async function onTabRemoved(tabId: number): Promise<void> {
    await mutatePending((l) => l.filter((p) => p.newTabId !== tabId && p.existingTabId !== tabId));
    try {
      for (const id of await api.listNotificationIds()) {
        const p = parseId(id);
        if (p && (p.newTabId === tabId || p.existingTabId === tabId)) await api.clearNotification(id);
      }
    } catch {
      /* notifications unavailable */
    }
  }

  return { ask, settled, handleChoice, onNotificationButton, onNotificationClosed, resolvePending, onTabRemoved };
}

/** `(newTab, existing) => Promise<void>` for DedupeDeps.ask. */
export function createAsk(port: BrowserPort, deps: AskDeps): (newTab: TabSnap, existing: TabSnap) => Promise<void> {
  return createAskController(port, deps).ask;
}
