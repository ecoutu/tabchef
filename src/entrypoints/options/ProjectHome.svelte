<script lang="ts">
  // A project's home (M4 T4, spec §6.12, D4), in the dashboard (#/project/<id>) and the side panel: header (title,
  // status, PR counts, Open in tab bar / Close group) → open tabs by group in tab-bar order → linked PRs not open, with
  // "Open into project" → the project's settings, collapsed and read-only (edited inline from T20). Kept current like the
  // side panel: re-fetched on config.changed and every LIVE_MS while visible.
  // M4 T9 lifecycle: an open project offers Close group, Close and save, Keep, and Close and archive when its ticket is
  // Done by fresh data (M3-R90). One with nothing open shows its saved tab list with Reopen, Keep, Archive and Delete; an
  // archived one says so ("Archived: reopen?" when a rule assigns its key) with Reopen, Unarchive and Delete. Delete asks
  // in the page first (M4-R9: "Delete for good?"), then goes back to Projects.
  import { onDestroy, onMount, tick } from 'svelte';
  import { send } from '../../ui/send';
  import { createProjectActions, startLiveRefresh, type Toast } from '../../ui/project-actions';
  import { buildProjectHome, type ProjectHomeView } from '../../ui/project-home-model';
  import PrPill from '../../ui/PrPill.svelte';
  import ProjectTitle from '../../ui/ProjectTitle.svelte';
  import Help from './Help.svelte';

  let { id }: { id: string } = $props();
  const uid = $props.id();
  /** undefined: loading; null: the project is unknown, closed or has no tab. */
  let view = $state<ProjectHomeView | null | undefined>(undefined);
  let error = $state('');
  /** After Close group: the closed tabs' recently-closed entries, which Undo reopens (recent.undo). */
  let toast = $state<Toast | undefined>(undefined);
  let seq = 0;

  async function load(): Promise<void> {
    const n = ++seq;
    const r = await send({ type: 'projects.home', id });
    if (n !== seq) return; // a newer read is on its way
    if (r.ok) { view = r.data ? buildProjectHome(r.data) : null; error = ''; } else error = r.error;
  }

  const actions = createProjectActions({
    reload: load,
    setError: (e) => { error = e; },
    getToast: () => toast,
    setToast: (t) => { toast = t; },
  });
  const { focus, undo } = actions;
  const openLinked = (url: string) => actions.openLinked(id, url);
  const closeGroup = () => actions.closeGroup(id);
  /** M4-R9: Delete was clicked; "Delete for good?" waits for the answer. */
  let confirmDelete = $state(false);
  let deleteButton = $state<HTMLButtonElement | undefined>(undefined);
  let cancelButton = $state<HTMLButtonElement | undefined>(undefined);
  /** Opens "Delete for good?" with focus on Cancel (the Delete button it replaces had it). */
  async function askDelete(): Promise<void> {
    confirmDelete = true;
    await tick();
    cancelButton?.focus();
  }
  /** Closes the question and gives focus back to Delete. */
  async function cancelDelete(): Promise<void> {
    confirmDelete = false;
    await tick();
    deleteButton?.focus();
  }
  async function remove(): Promise<void> {
    confirmDelete = false;
    if (await actions.remove(id)) window.location.hash = '#/projects';
  }

  let stopLive: (() => void) | undefined;

  onMount(() => {
    stopLive = startLiveRefresh(load);
    void load();
    void send({ type: 'sources.refresh' }).then((r) => (r.ok ? load() : undefined));
  });
  onDestroy(() => stopLive?.());
</script>

<section class="home">
  <p class="back"><a href="#/projects">Projects</a></p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if toast}
    {@const t = toast}
    <p class="toast" role="status">
      {t.text}
      {#if t.ids.length > 0}<button type="button" class="act" onclick={() => undo(t.ids)}>Undo</button>{/if}
    </p>
  {/if}
  {#if view === undefined && !error}
    <p class="muted" role="status">Loading project…</p>
  {:else if view === null}
    <p class="muted">This project is no longer open. <a href="#/projects">See all projects</a></p>
  {:else if view}
    {@const v = view}
    <header>
      <h2><ProjectTitle title={v.title} subtitle={v.subtitle} /></h2>
      {#if v.status}<span class={`status tone-${v.status.tone}`}>{v.status.label}</span>{/if}
      {#if v.prSummary}<span class="prs">{v.prSummary}</span>{/if}
      <span class="actions">
        {#if v.open}
          {#if v.firstTabId !== undefined}
            {@const first = v.firstTabId}
            <button type="button" class="act" onclick={() => focus(first)}>Open in tab bar</button>
          {/if}
          <button type="button" class="act" onclick={closeGroup}>Close group</button>
          <button type="button" class="act" onclick={() => actions.closeAndSave(id)}>Close and save</button>
          {#if v.done}<button type="button" class="act" onclick={() => actions.closeAndArchive(id)}>Close and archive</button>{/if}
        {:else}
          {#if !v.recipeOff && (v.archived || v.savedTabs.length > 0)}<button type="button" class="act" onclick={() => actions.reopen(id)}>Reopen</button>{/if}
          {#if v.archived}
            <button type="button" class="act" onclick={() => actions.unarchive(id)}>Unarchive</button>
          {:else}
            <button type="button" class="act" onclick={() => actions.archive(id)}>Archive</button>
          {/if}
        {/if}
        {#if !v.archived}
          <button type="button" class="act" aria-pressed={v.keep} title="A kept project is saved and never forgotten" onclick={() => actions.setKeep(id, !v.keep)}>Keep</button>
        {/if}
        {#if !v.open}
          {#if confirmDelete}
            <span class="confirm" role="group" aria-label="Delete this project">
              <span role="alert">Delete for good?</span>
              <button type="button" class="act danger" onclick={remove}>Delete for good</button>
              <button type="button" class="act" bind:this={cancelButton} onclick={cancelDelete}>Cancel</button>
            </span>
          {:else}
            <button type="button" class="act" bind:this={deleteButton} onclick={askDelete}>Delete</button>
          {/if}
        {/if}
      </span>
    </header>
    {#if v.archived}<p class="note">{v.held > 0 && !v.recipeOff ? 'Archived: reopen?' : 'Archived.'}</p>{/if}
    {#if v.recipeOff}
      <p class="muted">The recipe {v.recipeName} is turned off. Turn it on under <a href="#/recipes">Recipes</a> to reopen this project.</p>
    {/if}

    {#if !v.open}
    <section aria-labelledby={`${uid}-saved`}>
      <h3 id={`${uid}-saved`}>Saved tabs</h3>
      {#if v.savedTabs.length === 0}
        <p class="muted">No saved tabs yet.</p>
      {:else}
        <ul>
          {#each v.savedTabs as t, i (`${i}:${t.url}`)}
            <li class="row"><span class="title" title={t.group ? `${t.url} · ${t.group}` : t.url}>{t.title || t.url}</span></li>
          {/each}
        </ul>
      {/if}
    </section>
    {:else}
    <section aria-labelledby={`${uid}-tabs`}>
      <h3 id={`${uid}-tabs`}>Open tabs</h3>
      {#each v.groups as g (`${g.windowId}:${g.title}:${g.tabs[0]?.tabId}`)}
        <h4><span class={`swatch g-${g.color}`} aria-hidden="true"></span>{g.title}</h4>
        <ul>
          {#each g.tabs as t (t.tabId)}
            <li class="row">
              {#if t.favIconUrl}
                <img class="fav" src={t.favIconUrl} alt="" width="16" height="16" />
              {:else}
                <span class="fav fav-ph" aria-hidden="true"></span>
              {/if}
              <button type="button" class="title" title={t.url} onclick={() => focus(t.tabId)}>{t.title || t.url}</button>
              <PrPill state={t.pill} stale={t.stale === true} staleLabel={t.staleTip ?? ''} />
            </li>
          {/each}
        </ul>
      {/each}
    </section>
    {/if}

    <section aria-labelledby={`${uid}-linked`}>
      <h3 id={`${uid}-linked`}>Linked, not open</h3>
      {#if v.linked.length === 0}
        <p class="muted">Nothing linked that is not open.</p>
      {:else}
        <ul>
          {#each v.linked as l (l.url)}
            <li class="row linked">
              <span class="title" title={l.url}>{l.title}</span>
              <PrPill state={l.state} staleLabel="" />
              <button type="button" class="act" aria-label={`Open ${l.title} into project`} onclick={() => openLinked(l.url)}>Open into project</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if !v.recipeOff}
    <details class="settings">
      <summary>Settings</summary>
      <p class="muted">From the recipe {v.recipeName}. Read only for now.</p>
      <dl>
        {#each v.settings as s (s.label)}
          <dt>{s.label} <Help label={s.label} text={s.help} /></dt>
          <dd>{s.value}</dd>
        {/each}
      </dl>
    </details>
    {/if}
  {/if}
</section>

<style>
  .home { padding: 0 12px 12px; }
  .back { margin: 8px 0; }
  a { color: var(--accent); }
  header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 4px 0 12px; }
  h2 { font-size: 16px; margin: 0; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h3 { font-size: 13px; margin: 16px 0 6px; }
  h4 { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); margin: 8px 0 2px; }
  .actions { display: inline-flex; gap: 6px; margin-left: auto; }
  .prs { color: var(--muted); font-size: 12px; }
  .status { flex: none; font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--border); color: var(--muted); }
  .tone-progress { color: var(--accent); border-color: var(--accent); }
  .tone-done { color: var(--ok, #1e8e3e); border-color: var(--ok, #1e8e3e); }
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .fav { width: 16px; height: 16px; flex: none; border-radius: 3px; }
  .fav-ph { background: var(--border); display: inline-block; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
    background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 2px 0; }
  span.title { cursor: default; }
  .linked .title { opacity: 0.55; }
  .act { flex: none; } /* the button itself: .act in src/ui/tokens.css */
  .muted { color: var(--muted); }
  .note { margin: 0 0 8px; color: var(--accent); }
  .confirm { display: inline-flex; align-items: center; gap: 6px; }
  .danger { color: var(--danger); }
  .error { color: var(--danger); font-size: 12px; }
  .toast { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
  .toast .act { background: var(--bg); }
  .settings { margin-top: 16px; }
  .settings summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0 0; font-size: 12px; }
  dt { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  dd { margin: 0; }
  /* Chrome's tab group colors. */
  .swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #5f6368; }
  .g-blue { background: #1a73e8; } .g-red { background: #d93025; } .g-yellow { background: #f9ab00; }
  .g-green { background: #188038; } .g-pink { background: #d01884; } .g-purple { background: #a142f4; }
  .g-cyan { background: #007b83; } .g-orange { background: #fa903e; }
</style>
