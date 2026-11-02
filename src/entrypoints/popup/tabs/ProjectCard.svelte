<script lang="ts">
  // One project card (M3 T17, spec §6.5 mockup): title, status pill and tab count; the open tabs (title focuses the tab,
  // PR state pill, stale dot); the linked PRs not open, greyed with "Open ↗"; and the Done prompt.
  import { staleText, type ProjectCard } from '../../../ui/projects-model';
  import PrPill from '../../../ui/PrPill.svelte';

  let { card, prompt, onFocus, onOpenLinked, onCloseGroup, onKeep }: {
    card: ProjectCard;
    /** Show "Ticket is done. Close this group?" (the card is done and the prompt was not dismissed). */
    prompt: boolean;
    onFocus: (tabId: number) => void;
    onOpenLinked: (url: string) => void;
    onCloseGroup: () => void;
    onKeep: () => void;
  } = $props();

  // PR pills come from GitHub source data only (PrState).
  const STALE = staleText('GitHub');
</script>

<article class="card">
  <header>
    <h2>{card.title}</h2>
    {#if card.status}<span class={`status tone-${card.status.tone}`}>{card.status.label}</span>{/if}
    <span class="count">{card.tabCount} {card.tabCount === 1 ? 'tab' : 'tabs'}</span>
  </header>
  {#if prompt}
    <div class="prompt" role="group" aria-label="Ticket is done">
      <span>Ticket is done. Close this group?</span>
      <button type="button" class="act" onclick={onCloseGroup}>Close group</button>
      <button type="button" class="act" onclick={onKeep}>Keep</button>
    </div>
  {/if}
  <ul>
    {#each card.tabs as t (t.tabId)}
      <li class="row">
        {#if t.favIconUrl}
          <img class="fav" src={t.favIconUrl} alt="" width="16" height="16" />
        {:else}
          <span class="fav fav-ph" aria-hidden="true"></span>
        {/if}
        <button type="button" class="title" title={t.url} onclick={() => onFocus(t.tabId)}>{t.title || t.url}</button>
        <PrPill state={t.pill} stale={t.stale === true} staleLabel={STALE} />
      </li>
    {/each}
    {#each card.linked as l (l.url)}
      <li class="row linked">
        <span class="fav fav-ph" aria-hidden="true"></span>
        <span class="title" title={l.url}>{l.title}</span>
        <PrPill state={l.state} staleLabel={STALE} />
        <button type="button" class="act" aria-label={`Open ${l.title}`} onclick={() => onOpenLinked(l.url)}>Open ↗</button>
      </li>
    {/each}
  </ul>
</article>

<style>
  .card { border-bottom: 1px solid var(--border); padding: 4px 0 6px; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 12px 2px; }
  h2 { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { color: var(--muted); font-size: 11px; flex: none; }
  .status { flex: none; font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--border); color: var(--muted); }
  .tone-progress { color: var(--accent); border-color: var(--accent); }
  .tone-done { color: var(--ok, #1e8e3e); border-color: var(--ok, #1e8e3e); }
  .prompt { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 4px 12px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
  .prompt span { flex: 1; }
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 12px; }
  .row:focus-within, .row:hover { background: var(--hover); }
  .fav { width: 16px; height: 16px; flex: none; border-radius: 3px; }
  .fav-ph { background: var(--border); display: inline-block; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
    background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 2px 0; }
  span.title { cursor: default; }
  .linked .title, .linked .fav { opacity: 0.55; }
  .act { flex: none; } /* the button itself: .act in src/ui/tokens.css */
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
