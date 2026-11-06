<script lang="ts">
  // A project's home (M4 T4, spec §6.12, D4), in the dashboard (#/project/<id>) and the side panel: header (title,
  // status, PR counts, Open in tab bar / Close group) → open tabs by group in tab-bar order → linked PRs not open, with
  // "Open into project" → the project's settings, collapsed and read-only (edited inline from T20). Kept current like the
  // side panel: re-fetched on config.changed and every LIVE_MS while visible.
  import { onDestroy, onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { send } from '../../ui/send';
  import { isConfigChangedMessage } from '../../engine/messages';
  import { buildProjectHome, type ProjectHomeView } from '../../ui/project-home-model';
  import PrPill from '../../ui/PrPill.svelte';
  import Help from './Help.svelte';

  const LIVE_MS = 5000;
  let { id }: { id: string } = $props();
  const uid = $props.id();
  /** undefined: loading; null: the project is unknown, closed or has no tab. */
  let view = $state<ProjectHomeView | null | undefined>(undefined);
  let error = $state('');
  /** After Close group: the closed tabs' recently-closed entries, which Undo reopens (recent.undo). */
  let toast = $state<{ text: string; ids: string[] } | undefined>(undefined);
  let seq = 0;

  async function load(): Promise<void> {
    const n = ++seq;
    const r = await send({ type: 'projects.home', id });
    if (n !== seq) return; // a newer read is on its way
    if (r.ok) { view = r.data ? buildProjectHome(r.data) : null; error = ''; } else error = r.error;
  }

  async function act(run: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
    const r = await run();
    if (!r.ok) { error = r.error ?? 'Something went wrong'; return false; }
    error = '';
    return true;
  }

  const focus = (tabId: number) => void act(() => send({ type: 'tab.focus', tabId }));
  async function openLinked(url: string): Promise<void> {
    if (await act(() => send({ type: 'projects.openLinked', projectId: id, url }))) await load();
  }
  async function closeGroup(): Promise<void> {
    const r = await send({ type: 'projects.closeGroup', projectId: id });
    if (!r.ok) { error = r.error; return; }
    error = '';
    const { closed, skipped, ids } = r.data;
    const text = `Closed ${closed} ${closed === 1 ? 'tab' : 'tabs'}${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
    toast = closed > 0 || skipped > 0 ? { text, ids } : undefined;
    await load();
  }
  /** Restores the entries in turn; on a failure the ones not restored stay behind Undo. */
  async function undo(ids: string[]): Promise<void> {
    const text = toast?.text ?? '';
    for (const [i, entry] of ids.entries()) {
      if (!(await act(() => send({ type: 'recent.undo', id: entry })))) { toast = { text, ids: ids.slice(i) }; await load(); return; }
    }
    toast = undefined;
    await load();
  }

  const onMessage = (m: unknown) => { if (isConfigChangedMessage(m)) void load(); };
  const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    browser.runtime.onMessage.addListener(onMessage);
    timer = setInterval(onVisible, LIVE_MS);
    document.addEventListener('visibilitychange', onVisible);
    void load();
    void send({ type: 'sources.refresh' }).then((r) => (r.ok ? load() : undefined));
  });
  onDestroy(() => {
    if (timer !== undefined) clearInterval(timer);
    browser.runtime.onMessage.removeListener(onMessage);
    document.removeEventListener('visibilitychange', onVisible);
  });
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
      <h2>{v.title}</h2>
      {#if v.status}<span class={`status tone-${v.status.tone}`}>{v.status.label}</span>{/if}
      {#if v.prSummary}<span class="prs">{v.prSummary}</span>{/if}
      <span class="actions">
        {#if v.firstTabId !== undefined}
          {@const first = v.firstTabId}
          <button type="button" class="act" onclick={() => focus(first)}>Open in tab bar</button>
        {/if}
        <button type="button" class="act" onclick={closeGroup}>Close group</button>
      </span>
    </header>

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
</section>

<style>
  .home { padding: 0 12px 12px; }
  .back { margin: 8px 0; }
  a { color: var(--accent); }
  header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 4px 0 12px; }
  h2 { font-size: 16px; margin: 0; }
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
