<script lang="ts">
  // One project card (M3 T17, spec §6.5 mockup): title, status pill and tab count; the open tabs (title focuses the tab,
  // PR state pill, stale dot); the linked PRs not open, greyed with "Open ↗"; and the Done prompt (Close group, M4 T9's
  // Close and archive, Keep).
  import { staleText, type ProjectCard } from '../../../ui/projects-model';
  import PrPill from '../../../ui/PrPill.svelte';
  import ProjectTitle from '../../../ui/ProjectTitle.svelte';
  import { projectHomeHash } from '../../../ui/routes';
  import { browser } from 'wxt/browser';

  let { card, prompt, onFocus, onOpenLinked, onCloseGroup, onCloseAndArchive, onKeep, onOpenProject }: {
    card: ProjectCard;
    /** Show "Ticket is done. Close this group?" (the card is done and the prompt was not dismissed). */
    prompt: boolean;
    onFocus: (tabId: number) => void;
    onOpenLinked: (url: string) => void;
    onCloseGroup: () => void;
    /** M4 T9: Close and save, then archive (the prompt is shown only for a ticket Done by fresh data, M3-R90). */
    onCloseAndArchive: () => void;
    onKeep: () => void;
    /** The popup opens the dashboard tab; without it (the side panel) the link navigates the panel's own hash. */
    onOpenProject?: () => void;
  } = $props();

  // PR pills come from GitHub source data only (PrState).
  const STALE = staleText('GitHub');
  // In the popup the hash alone would resolve against popup.html, so the href is the dashboard page itself; a modified or
  // middle click then follows it in the browser's own way, and a plain click opens the tab through `onOpenProject`.
  const homeHref = $derived(onOpenProject ? browser.runtime.getURL('/options.html') + projectHomeHash(card.id) : projectHomeHash(card.id));
  const modified = (e: MouseEvent): boolean => e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
</script>

<article class="card">
  <header>
    <h2><a class="home" href={homeHref}
      onclick={onOpenProject ? (e) => { if (modified(e)) return; e.preventDefault(); onOpenProject(); } : undefined}><ProjectTitle title={card.title} subtitle={card.subtitle} /></a></h2>
    {#if card.status}<span class={`status tone-${card.status.tone}`}>{card.status.label}</span>{/if}
    <span class="count">{card.tabCount} {card.tabCount === 1 ? 'tab' : 'tabs'}</span>
  </header>
  {#if prompt}
    <div class="prompt" role="group" aria-label="Ticket is done">
      <span>Ticket is done. Close this group?</span>
      <button type="button" class="act" onclick={onCloseGroup}>Close group</button>
      <button type="button" class="act" onclick={onCloseAndArchive}>Close and archive</button>
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
  .home { color: inherit; text-decoration: none; }
  .home:hover { text-decoration: underline; }
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
