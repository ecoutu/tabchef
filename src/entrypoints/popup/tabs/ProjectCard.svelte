<script lang="ts">
  // One project card (M3 T17, spec §6.5 mockup): title, status pill and tab count; the open tabs (title focuses the tab,
  // PR state pill, stale dot); the linked PRs not open, greyed with "Open ↗"; and the Done prompt (Close group, M4 T9's
  // Close and archive, and "Keep open"). Collapsed (#151): the header alone, whose disclosure button expands it again; a
  // Done prompt then shows in the header as a Done badge and Close group (Close and archive and the keep button stay in
  // the body). The keep button says what it does (#157): "Keep open", or "Keep and save to bookmarks" while project sync
  // is on (`syncOn`) and the project is not kept yet (`card.keep`). The card holding the window's active tab (`activeTabId`,
  // #212) and that tab's row are marked current; a collapsed card is marked in its header alone and stays collapsed.
  import { staleText, type ProjectCard } from '../../../ui/projects-model';
  import PrPill from '../../../ui/PrPill.svelte';
  import ProjectTitle from '../../../ui/ProjectTitle.svelte';
  import { projectHomeHash } from '../../../ui/routes';
  import { browser } from 'wxt/browser';
  import { doneKeepLabel } from '../../../ui/keep-wording';

  let { card, prompt, collapsed = false, syncOn = false, activeTabId, onToggle, onFocus, onOpenLinked, onCloseGroup, onCloseAndArchive, onKeep, onOpenProject }: {
    card: ProjectCard;
    /**
     * Show "Ticket is done. Close this group?", or "Issue is closed. Close this group?" for a GitHub issue (`card.issue`)
     * (the card is done and the prompt was not dismissed).
     */
    prompt: boolean;
    /** Only the header shows (#151). */
    collapsed?: boolean;
    /** Project sync is on (projects.sync.status `enabled`): Keep also saves the project to bookmarks. */
    syncOn?: boolean;
    /** The active tab of the page's window (#212): the card holding it is the current project. */
    activeTabId?: number;
    /** The header's disclosure button: collapse or expand the card. */
    onToggle: () => void;
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
  const uid = $props.id();
  const bodyId = `${uid}-body`;
  // GitHub calls them issues, closed rather than done; a Jira card keeps the ticket wording.
  const DONE = $derived(card.issue ? 'Issue is closed' : 'Ticket is done');
  const PROMPT = $derived(`${DONE}. Close this group?`);
  const current = $derived(activeTabId !== undefined && card.tabs.some((t) => t.tabId === activeTabId));
</script>

<article class="card" class:current aria-current={current ? 'true' : undefined}>
  <header>
    <button type="button" class="disclosure" aria-expanded={!collapsed} aria-controls={bodyId} aria-label={card.title}
      title={collapsed ? 'Expand' : 'Collapse'} onclick={onToggle}><span aria-hidden="true">{collapsed ? '▸' : '▾'}</span></button>
    <h2><a class="home" href={homeHref}
      onclick={onOpenProject ? (e) => { if (modified(e)) return; e.preventDefault(); onOpenProject(); } : undefined}><ProjectTitle title={card.title} subtitle={card.subtitle} /></a></h2>
    {#if collapsed && prompt}
      <!-- The badge stands in for the status pill (a Done status), so the header does not read "Done Done". -->
      <span class="status badge" title={PROMPT}>Done</span>
      <button type="button" class="act" onclick={onCloseGroup}>Close group</button>
    {:else if card.status}<span class={`status tone-${card.status.tone}`}>{card.status.label}</span>{/if}
    <span class="count">{card.tabCount} {card.tabCount === 1 ? 'tab' : 'tabs'}</span>
  </header>
  <div id={bodyId} hidden={collapsed}>
  {#if prompt}
    <div class="prompt" role="group" aria-label={DONE}>
      <span>{PROMPT}</span>
      <div class="prompt-actions">
        <button type="button" class="act" onclick={onCloseGroup}>Close group</button>
        <button type="button" class="act" onclick={onCloseAndArchive}>Close and archive</button>
        <button type="button" class="act" onclick={onKeep}>{doneKeepLabel(syncOn, card.keep === true)}</button>
      </div>
    </div>
  {/if}
  <ul>
    {#each card.tabs as t (t.tabId)}
      <li class="row" class:current={t.tabId === activeTabId}>
        {#if t.favIconUrl}
          <img class="fav" src={t.favIconUrl} alt="" width="16" height="16" />
        {:else}
          <span class="fav fav-ph" aria-hidden="true"></span>
        {/if}
        <button type="button" class="title" title={t.url} aria-current={t.tabId === activeTabId ? 'true' : undefined} onclick={() => onFocus(t.tabId)}>{t.title || t.url}</button>
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
  </div>
</article>

<style>
  .card { border-bottom: 1px solid var(--border); padding: 4px 0 6px; }
  /* The current project (#212): a rounded, inset card (the header alone when collapsed) with an accent outline and tint,
     and a rounded, stronger tint and bold title on its tab row, which hover and focus deepen rather than replace. The
     outline takes no space and the divider turns transparent rather than going, so marking a card never moves the list.
     An outline rather than an inset bar: on a rounded box an inset shadow thins into a crescent at the corners. */
  .card.current { margin: 0 6px; border-radius: 8px; border-bottom-color: transparent;
    outline: 1px solid var(--accent); outline-offset: -1px; background: color-mix(in srgb, var(--accent) 8%, transparent);
    /* On the tints the muted, accent and green text falls below 4.5:1 (11px): inks pushed toward --text keep it at
       4.6:1 or more in both themes, hover included. The outline and tints keep the plain accent. */
    --muted-ink: color-mix(in srgb, var(--text) 75%, var(--bg));
    --accent-ink: color-mix(in srgb, var(--accent) 62%, var(--text));
    --ok-ink: color-mix(in srgb, var(--ok, #1e8e3e) 50%, var(--text)); }
  .card.current button, .card.current .count, .card.current .status, .card.current :global(.pill),
  .card.current :global(.pr-stale) { --muted: var(--muted-ink); --accent: var(--accent-ink); --ok: var(--ok-ink); }
  /* The opaque --hover would flatten the tint (1.03:1): a translucent shade of the text deepens it instead. */
  .card.current .row:not(.current):hover, .card.current .row:not(.current):focus-within, .card.current .disclosure:hover {
    background: color-mix(in srgb, var(--text) 7%, transparent); }
  .card.current .prompt { background: var(--bg); }
  /* The rows of the current card are rounded and inset, so the curve of the current row and of a hovered row shows;
     6 px margin + 6 px padding keep the row content 12 px from the card edge, as before. */
  .card.current .row { margin: 0 6px; padding: 4px 6px; border-radius: 6px; }
  .row.current { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  .row.current:hover, .row.current:focus-within { background: color-mix(in srgb, var(--accent) 26%, transparent); }
  .row.current .title { font-weight: 600; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 12px 2px 4px; }
  .disclosure { flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: none;
    color: var(--muted); font: inherit; line-height: 1; cursor: pointer; }
  .disclosure:hover { background: var(--hover); color: inherit; }
  h2 { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home { color: inherit; text-decoration: none; }
  .home:hover { text-decoration: underline; }
  .count { color: var(--muted); font-size: 11px; flex: none; }
  .status { flex: none; font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--border); color: var(--muted); }
  .tone-progress { color: var(--accent); border-color: var(--accent); }
  .tone-done { color: var(--ok); border-color: var(--ok); }
  /* White on the Chrome group green (#188038, as in the options page): 5.0:1 in both themes (WCAG AA at 11px). */
  .badge { color: #fff; background: #188038; border-color: #188038; font-weight: 600; }
  .prompt { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 4px 12px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
  /* The buttons wrap as one unit below the text when the row is too narrow (the side panel): with a zero basis the text
     squeezed to one word per line beside them. 12em keeps the wide popup's single row. */
  .prompt span { flex: 1 1 12em; }
  .prompt-actions { display: flex; flex-wrap: wrap; gap: 6px; }
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
