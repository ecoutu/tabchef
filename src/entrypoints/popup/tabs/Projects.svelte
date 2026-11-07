<script lang="ts">
  // The Projects tab (M3 T17): one card per open project (projects.list), in the popup and, full height, in the side
  // panel. Opening it sends sources.refresh (SourceService refresh('popup'), throttled; M3-R83), then lists again.
  // `live` (the side panel): also re-fetch on config.changed and every LIVE_MS while the page is visible.
  // `onOpenProject` (the popup): a card title opens the dashboard at that project; without it the title link is a plain
  // hash link (the side panel switches on its own hash).
  // `onChange` (the popup): called after Close group, Undo or Open, so the other tabs' counts are re-read.
  import { onDestroy, onMount } from 'svelte';
  import { send } from '../../../ui/send';
  import { createProjectActions, startLiveRefresh, type Toast } from '../../../ui/project-actions';
  import { buildProjectCards, type ProjectCard as Card } from '../../../ui/projects-model';
  import ProjectCard from './ProjectCard.svelte';

  let { live = false, onChange, onOpenProject }: { live?: boolean; onChange?: () => void; onOpenProject?: (id: string) => void } = $props();
  let cards = $state<Card[] | undefined>(undefined);
  let error = $state('');
  /** Done prompts the user answered Keep to (this page only); Keep also keeps the project (projects.setKeep). */
  let kept = $state<string[]>([]);
  /** After Close group: the closed tabs' recently-closed entries, which Undo reopens (M1 undo, recent.undo). */
  let toast = $state<Toast | undefined>(undefined);
  let seq = 0;

  /** After an action: re-list, and let the popup refresh its counts. */
  async function reload(): Promise<void> {
    onChange?.();
    await load();
  }

  async function load(): Promise<void> {
    const n = ++seq;
    const r = await send({ type: 'projects.list' });
    if (n !== seq) return; // a newer list is on its way
    if (r.ok) { cards = buildProjectCards(r.data); error = ''; } else error = r.error;
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
    if (live) stopLive = startLiveRefresh(load);
    void load();
    void send({ type: 'sources.refresh' }).then((r) => (r.ok ? load() : undefined));
  });
  onDestroy(() => stopLive?.());
</script>

<section>
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
    <p class="empty">No projects yet. Turn on a Jira ticket recipe, then open a Jira ticket.</p>
  {/if}
  {#each cards ?? [] as c (c.id)}
    <ProjectCard card={c} prompt={c.showClose && !kept.includes(c.id)}
      onFocus={focus} onOpenLinked={(url) => openLinked(c.id, url)} onCloseGroup={() => closeGroup(c.id)}
      onCloseAndArchive={() => closeAndArchive(c.id)}
      onKeep={() => { kept = [...kept, c.id]; void setKeep(c.id, true); }} onOpenProject={onOpenProject ? () => onOpenProject(c.id) : undefined} />
  {/each}
</section>

<style>
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
