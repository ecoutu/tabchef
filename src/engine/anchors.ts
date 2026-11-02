// Anchor tabs (M2 T11, spec §6.1): URLs a group rule keeps open inside its group.
//
// - Opened (in the background) only when Tabchef CREATES the group (Reconciler.apply, ruling R9); an adopted group
//   (e.g. after a restart) gets none. A tab already at that URL in the window (ungrouped, or already in the group) is
//   used instead of opening a new one.
// - A user-closed anchor dismisses its group's anchors ("<windowId>|<title>") until tabGroups.onRemoved for that group.
// - Anchor tabs are never closed by dedupe, auto-close or dupes.close* (R11); the planner leaves them alone while they
//   are still at their anchor URL (R21), since that URL need not match the group's rule.
// State lives in the reconciler's RuntimeState (shared LiveState object), so it survives worker restarts.
import { normalizeUrl } from '../core/url/normalize';
import type { Program } from '../core/lang/types';
import type { GroupColor, Op, Snapshot, TabSnap } from '../core/types';
import type { BrowserPort } from '../platform/browser-port';
import { saveState, type LiveState } from './state';

export interface AnchorLog {
  add(e: { tabId?: number; ruleId?: string; action: string; detail: string; at: number }): void;
}

export interface AnchorDeps {
  /** The reconciler's LiveState (Reconciler.liveState): anchors share its RuntimeState. */
  state: () => Promise<LiveState>;
  /** DedupeHandler.armExemption: armed before each anchor tab is created, so it is not closed as a new duplicate (R11). */
  armExemption?: (url: string, windowId?: number) => () => void;
  log?: AnchorLog;
  now?: () => number;
}

/** A group Tabchef just created (not adopted): `tabIds` already joined it, `urls` are its rendered anchors. */
export interface CreatedGroup {
  groupId: number;
  windowId: number;
  title: string;
  color: GroupColor;
  tabIds: number[];
  urls: string[];
  ruleId?: string;
}

const groupKey = (windowId: number, title: string): string => `${windowId}|${title}`;
const urlOf = (t: TabSnap): string => (t.pendingUrl ? t.pendingUrl : t.url);

function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** URL identity for "the same page": the dedupe normalization of the program (fragment, tracking params, ...). */
function sameKey(p: Program): (url: string) => string {
  return (url) => normalizeUrl(url, p.dedupe)?.key ?? url;
}

/**
 * Anchor tabs still at their anchor URL: merged into the planner's leaveAlone (R21) so `strict` does not ungroup them
 * and other rules do not move them. Once an anchor navigates elsewhere it is planned like any tab again.
 */
export function anchorLeaveAlone(anchors: readonly { tabId: number; url: string }[], snap: Snapshot, p: Program): number[] {
  if (anchors.length === 0) return [];
  const key = sameKey(p);
  const byId = new Map(snap.tabs.map((t) => [t.id, t]));
  return anchors.flatMap((a) => {
    const t = byId.get(a.tabId);
    return t && key(urlOf(t)) === key(a.url) ? [a.tabId] : [];
  });
}

export class AnchorService {
  /** Resolves once the persisted anchors are loaded; isAnchor is false until then (await it before deciding). */
  readonly ready: Promise<void>;
  private st?: LiveState;
  private readonly now: () => number;

  constructor(
    private readonly port: Pick<BrowserPort, 'createTab' | 'snapshot'>,
    private readonly deps: AnchorDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.ready = deps.state().then((st) => { this.st = st; });
  }

  isAnchor(tabId: number): boolean {
    return this.st?.anchors.some((a) => a.tabId === tabId) ?? false;
  }

  /**
   * Called by Reconciler.apply right after it created `g` (never for an adopted group). Records the anchors and returns
   * the op that moves new and reused anchor tabs into the group (applied by the reconciler, which tracks the events).
   */
  async onGroupCreated(st: LiveState, g: CreatedGroup, snap: Snapshot, p: Program): Promise<Op[]> {
    if (g.urls.length === 0) return [];
    const gk = groupKey(g.windowId, g.title);
    if (st.anchorsDismissed.has(gk)) {
      this.log({ action: 'anchor-dismissed', detail: `Anchors of ${g.title} not opened: one was closed (until the group is removed)` }, g.ruleId);
      return [];
    }
    const key = sameKey(p);
    const inGroup = new Set(g.tabIds);
    const used = new Set(st.anchors.map((a) => a.tabId));
    const join: number[] = [];
    for (const url of new Set(g.urls)) {
      if (!isHttp(url)) {
        this.log({ action: 'anchor-skipped', detail: `Anchor "${url}" of ${g.title} skipped: only http(s) URLs open` }, g.ruleId);
        continue;
      }
      // An open tab at that URL in the window (ungrouped, or already in the new group) becomes the anchor; not one the
      // user chose to leave alone (e.g. dragged out of a group): moving it would undo that choice.
      const existing = snap.tabs.find((t) => t.windowId === g.windowId && !t.pinned && !used.has(t.id) && !st.leaveAlone.has(t.id)
        && (t.groupId === -1 || inGroup.has(t.id)) && key(urlOf(t)) === key(url));
      let tabId: number;
      let disarm: (() => void) | undefined;
      if (existing) {
        tabId = existing.id;
        if (!inGroup.has(tabId)) join.push(tabId);
      } else {
        disarm = this.deps.armExemption?.(url, g.windowId);
        try {
          tabId = await this.port.createTab({ url, windowId: g.windowId, active: false });
        } catch (e) {
          disarm?.();
          this.log({ action: 'anchor-failed', detail: `Could not open anchor ${url} in ${g.title} (${e instanceof Error ? e.message : String(e)})` }, g.ruleId);
          continue;
        }
        join.push(tabId);
        this.log({ tabId, action: 'anchor-opened', detail: `Opened anchor ${url} in ${g.title}` }, g.ruleId);
      }
      used.add(tabId);
      st.anchors.push({ tabId, windowId: g.windowId, title: g.title, url });
      // Recorded: isAnchor now keeps it from dedupe, so an unconsumed exemption would only exempt the user's own
      // duplicate of this URL opened in the next 15 s.
      disarm?.();
    }
    if (join.length === 0) return [];
    return [{
      kind: 'group', tabIds: join, windowId: g.windowId, title: g.title, color: g.color, existingGroupId: g.groupId,
      ...(g.ruleId !== undefined && { ruleId: g.ruleId }),
    }];
  }

  /** tabs.onRemoved. A user close dismisses the group's anchors; a window closing (not the user's choice) does not. */
  async onTabRemoved(tabId: number, isWindowClosing = false): Promise<void> {
    const st = await this.state();
    const i = st.anchors.findIndex((a) => a.tabId === tabId);
    if (i < 0) return;
    const a = st.anchors.splice(i, 1)[0]!;
    if (!isWindowClosing) st.anchorsDismissed.add(groupKey(a.windowId, a.title));
    await saveState(st);
  }

  /** tabs.onReplaced (prerender / discard swap): the anchor moves to the new tab id. */
  async onTabReplaced(added: number, removed: number): Promise<void> {
    const st = await this.state();
    const a = st.anchors.find((x) => x.tabId === removed);
    if (!a) return;
    a.tabId = added;
    await saveState(st);
  }

  /**
   * tabGroups.onUpdated: a renamed group keeps its anchors. Their entries take the new title, so removing the group (by
   * its new title) drops them and a user close dismisses the right group.
   */
  async onGroupUpdated(g: { id: number; windowId: number; title?: string }): Promise<void> {
    if (g.title === undefined) return;
    const st = await this.state();
    const stale = st.anchors.filter((a) => a.windowId === g.windowId && a.title !== g.title);
    if (stale.length === 0) return;
    const members = new Set((await this.port.snapshot()).tabs.filter((t) => t.groupId === g.id).map((t) => t.id));
    let changed = false;
    for (const a of stale) if (members.has(a.tabId)) { a.title = g.title; changed = true; }
    if (changed) await saveState(st);
  }

  /** tabGroups.onRemoved: the group may be created again with its anchors; tabs that outlived it are anchors no more. */
  async onGroupRemoved(g: { windowId: number; title?: string }): Promise<void> {
    if (g.title === undefined) return;
    const st = await this.state();
    const gk = groupKey(g.windowId, g.title);
    const before = st.anchors.length;
    st.anchors = st.anchors.filter((a) => groupKey(a.windowId, a.title) !== gk);
    if (!st.anchorsDismissed.delete(gk) && st.anchors.length === before) return;
    await saveState(st);
  }

  private async state(): Promise<LiveState> {
    await this.ready;
    return this.st!;
  }

  private log(e: { tabId?: number; action: string; detail: string }, ruleId: string | undefined): void {
    this.deps.log?.add({ ...e, ...(ruleId !== undefined && { ruleId }), at: this.now() });
  }
}
