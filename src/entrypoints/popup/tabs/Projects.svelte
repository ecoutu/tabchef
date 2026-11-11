<script lang="ts">
  // The Projects tab (M3 T17): one card per open project (projects.list), in the popup and, full height, in the side
  // panel. Opening it sends sources.refresh (SourceService refresh('popup'), throttled; M3-R83), then lists again.
  // `live` (the side panel): also re-fetch on config.changed and every LIVE_MS while the page is visible.
  // `onOpenProject` (the popup): a card title opens the dashboard at that project; without it the title link is a plain
  // hash link (the side panel switches on its own hash).
  // `onChange` (the popup): called after Close group, Undo or Open, so the other tabs' counts are re-read.
  // Collapsed cards (#151): storage.local `projects.collapsed`, read before the first cards show and followed while open
  // (the popup and the side panel share it). Ids of projects no longer listed are pruned when the first list loads, not
  // on later refreshes: a project missing from one refresh of the live panel keeps its state when it comes back.
  import { onDestroy, onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { send } from '../../../ui/send';
  import { createProjectActions, startLiveRefresh, type Toast } from '../../../ui/project-actions';
  import { buildProjectCards, type ProjectCard as Card } from '../../../ui/projects-model';
  import {
    allCollapsed, collapseIds, COLLAPSED_PROJECTS_KEY, expandIds, parseCollapsed, pruneCollapsed, sameIds, type Edit,
  } from '../../../ui/collapsed-projects';
  import ProjectCard from './ProjectCard.svelte';

  let { live = false, onChange, onOpenProject }: { live?: boolean; onChange?: () => void; onOpenProject?: (id: string) => void } = $props();
  let cards = $state<Card[] | undefined>(undefined);
  let error = $state('');
  /** Done prompts the user answered Keep to (this page only); Keep also keeps the project (projects.setKeep). */
  let kept = $state<string[]>([]);
  /** After Close group: the closed tabs' recently-closed entries, which Undo reopens (M1 undo, recent.undo). */
  let toast = $state<Toast | undefined>(undefined);
  let seq = 0;
  /**
   * The collapsed cards' ids as shown: `stored` with this page's edits not yet stored on top. Storage is the source of
   * truth: every write is a read-modify-write of the stored set, one at a time, and every storage.onChanged value is
   * taken as it is, so the popup and the side panel converge on what is stored. None collapsed until read, or when
   * storage is unavailable.
   */
  let collapsed = $state<string[]>([]);
  /** The stored set as last known: the first read, then each storage.onChanged value and this page's own writes. */
  let stored: string[] = [];
  /**
   * One edit of this page: `echo` is its write (the set it read, the set it wrote) once made, and `done` is set when that
   * write has resolved.
   */
  type Pending = { e: Edit; echo?: { old: string[]; next: string[] }; done: boolean };
  /**
   * This page's edits, oldest first, shown on top of `stored` so none flickers back: each stays until the change event
   * of its own write (its echo) is heard, or at once when it wrote nothing or its write failed. Chrome can resolve set()
   * before delivering that event, and a change heard meanwhile would otherwise show the set without the edit.
   */
  const pending: Pending[] = [];
  let writes: Promise<void> = Promise.resolve();
  /** storage.onChanged values seen: a write that saw none since its read knows the stored set is its own. */
  let heard = 0;
  let collapsedRead: Promise<void> = Promise.resolve();
  let pruned = false;
  const allIds = $derived((cards ?? []).map((c) => c.id));
  const everyCollapsed = $derived(allCollapsed(collapsed, allIds));

  const show = (): void => { collapsed = pending.reduce((ids, p) => p.e(ids), stored); };
  const drop = (p: Pending): void => { const i = pending.indexOf(p); if (i >= 0) pending.splice(i, 1); };

  async function readCollapsed(): Promise<void> {
    try {
      const v = parseCollapsed((await browser.storage.local.get(COLLAPSED_PROJECTS_KEY))[COLLAPSED_PROJECTS_KEY]);
      if (heard === 0) { stored = v; show(); } // else a change already gave a newer value
    } catch { /* storage unavailable: every card expanded */ }
  }

  /** Shows the edit at once, then applies it to the stored set (best effort: without storage it stays on this page). */
  function edit(e: Edit): void {
    const p: Pending = { e, done: false };
    pending.push(p);
    show();
    writes = writes.then(async () => {
      let wrote = false;
      try {
        const seen = heard;
        const now = parseCollapsed((await browser.storage.local.get(COLLAPSED_PROJECTS_KEY))[COLLAPSED_PROJECTS_KEY]);
        const next = e(now);
        if (!sameIds(next, now)) {
          p.echo = { old: now, next };
          await browser.storage.local.set({ [COLLAPSED_PROJECTS_KEY]: next });
          wrote = true;
        }
        if (heard === seen) stored = next;
      } catch {
        stored = e(stored);
      }
      p.done = true;
      if (!wrote) drop(p); // no echo will come
      show();
    });
  }

  /**
   * The popup or the side panel (this page included) stored a new set: taken as it is. It ends the edit it is the echo
   * of. An edit whose write is done also ends at the first change that is not the echo of it or of an earlier edit of
   * this page (Chrome delivers changes in order), so it never waits for an echo that does not come: one another page's
   * write replaced before this page's set() (the echo then has another old value), or a set() that changed nothing.
   */
  const onStorage = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string): void => {
    const change = changes[COLLAPSED_PROJECTS_KEY];
    if (area !== 'local' || !change) return;
    heard++;
    stored = parseCollapsed(change.newValue);
    const old = parseCollapsed(change.oldValue);
    const i = pending.findIndex((p) => p.echo && sameIds(p.echo.old, old) && sameIds(p.echo.next, stored));
    const ended = pending.filter((p, j) => j === i || (p.done && (i < 0 || j < i)));
    for (const p of ended) drop(p);
    show();
  };

  /** Collapse (or expand) the cards `ids`, as the user saw them when clicking. */
  const setIds = (ids: readonly string[], collapse: boolean): void => {
    edit(collapse ? (s) => collapseIds(s, ids) : (s) => expandIds(s, ids));
  };

  /** After an action: re-list, and let the popup refresh its counts. */
  async function reload(): Promise<void> {
    onChange?.();
    await load();
  }

  async function load(): Promise<void> {
    const n = ++seq;
    const r = await send({ type: 'projects.list' });
    await collapsedRead; // no card shows expanded before its stored state is known
    if (n !== seq) return; // a newer list is on its way
    if (r.ok) {
      cards = buildProjectCards(r.data);
      error = '';
      if (!pruned) {
        pruned = true;
        const ids = cards.map((c) => c.id);
        edit((s) => pruneCollapsed(s, ids)); // from the stored set as it is then, not as this page last saw it
      }
    } else error = r.error;
  }

  const actions = createProjectActions({
    reload,
    setError: (e) => { error = e; },
    getToast: () => toast,
    setToast: (t) => { toast = t; },
  });
  const { focus, openLinked, closeGroup, closeAndArchive, setKeep, undo } = actions;

  let stopLive: (() => void) | undefined;

  onMount(() => {
    browser.storage.onChanged.addListener(onStorage);
    collapsedRead = readCollapsed();
    if (live) stopLive = startLiveRefresh(load);
    void load();
    void send({ type: 'sources.refresh' }).then((r) => (r.ok ? load() : undefined));
  });
  onDestroy(() => {
    stopLive?.();
    browser.storage.onChanged.removeListener(onStorage);
  });
</script>

<section>
  {#if cards && cards.length > 0}
    <div class="bar">
      <button type="button" class="act" onclick={() => setIds(allIds, !everyCollapsed)}>
        {everyCollapsed ? 'Expand all' : 'Collapse all'}</button>
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if toast}
    {@const t = toast}
    <p class="toast" role="status">
      {t.text}
      {#if t.ids.length > 0}<button type="button" class="act" onclick={() => undo(t.ids)}>Undo</button>{/if}
    </p>
  {/if}
  <!-- The first list can take seconds (it waits on the queues and the Jira / GitHub fetches); later refreshes keep the cards. -->
  {#if cards === undefined && !error}
    <p class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading projects…</p>
  {/if}
  {#if cards && cards.length === 0}
    <p class="empty">No projects yet. Turn on a Jira ticket or GitHub issue recipe, then open a ticket or issue.</p>
  {/if}
  {#each cards ?? [] as c (c.id)}
    <ProjectCard card={c} prompt={c.showClose && !kept.includes(c.id)}
      collapsed={collapsed.includes(c.id)} onToggle={() => setIds([c.id], !collapsed.includes(c.id))}
      onFocus={focus} onOpenLinked={(url) => openLinked(c.id, url)} onCloseGroup={() => closeGroup(c.id)}
      onCloseAndArchive={() => closeAndArchive(c.id)}
      onKeep={() => { kept = [...kept, c.id]; void setKeep(c.id, true); }} onOpenProject={onOpenProject ? () => onOpenProject(c.id) : undefined} />
  {/each}
</section>

<style>
  .bar { display: flex; justify-content: flex-end; padding: 6px 12px 0; }
  .error { color: var(--danger); margin: 6px 12px; font-size: 12px; }
  .empty { color: var(--muted); padding: 12px; margin: 0; }
  .loading { display: flex; align-items: center; gap: 8px; color: var(--muted); padding: 12px; margin: 0; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  /* Undo on the --surface toast: the page background, so it stands out (overrides .act's --surface). */
  .toast .act { background: var(--bg); }
  .toast { display: flex; align-items: center; gap: 8px; margin: 6px 12px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
</style>
