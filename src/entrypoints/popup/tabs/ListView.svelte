<script lang="ts">
  // A recipe-declared `list` view (M2 T17), e.g. Finished: rows from view.data, buttons from the view's `actions`.
  // M3 T13: a row's source state as a pill (and a stale marker), and the locked state of a view whose rules all
  // wait for a connection or host access (Connect opens #/connections; Allow requests in the click handler).
  // #195: the Finished view's done projects (`projects`) come first, one row each with the card prompt's actions (Close
  // group, Close and archive, Keep), sent as the card sends them; Close group's toast offers Undo as the card's does.
  import { browser } from 'wxt/browser';
  import { send } from '../../../ui/send';
  import { requestNeeds } from '../../../ui/permissions';
  import { createProjectActions, type Toast } from '../../../ui/project-actions';
  import { buildDoneRows } from '../../../ui/projects-model';
  import PrPill from '../../../ui/PrPill.svelte';
  import ProjectTitle from '../../../ui/ProjectTitle.svelte';
  import type { ViewRow, ViewSummary } from '../../../engine/views';
  import type { DoneProject } from '../../../core/projects/types';

  let { view, rows, projects = [], onChange }: { view: ViewSummary; rows: ViewRow[]; projects?: DoneProject[]; onChange: () => void } = $props();
  let error = $state('');
  let status = $state('');
  /** After Close group or Close and archive: the closed tabs' recently-closed entries, which Undo reopens. */
  let toast = $state<Toast | undefined>(undefined);
  const done = $derived(buildDoneRows(projects));
  const projectActions = createProjectActions({
    reload: async () => { onChange(); },
    setError: (e) => { error = e; },
    getToast: () => toast,
    setToast: (t) => { toast = t; },
  });

  const can = (a: ViewSummary['actions'][number]): boolean => view.actions.includes(a);
  /** Rows split into runs of the same `group` (rows arrive grouped and sorted). */
  const groups = $derived(rows.reduce<{ name?: string; rows: ViewRow[] }[]>((out, r) => {
    const last = out[out.length - 1];
    if (last && last.name === r.group) last.rows.push(r);
    else out.push({ ...(r.group !== undefined && { name: r.group }), rows: [r] });
    return out;
  }, []));

  /** Runs a request; shows a one-line error on failure, refreshes on success. */
  async function act(run: () => Promise<{ ok: boolean; error?: string; data?: unknown }>): Promise<void> {
    const r = await run();
    if (!r.ok) { error = r.error ?? 'Something went wrong'; return; }
    error = '';
    const skipped = (r.data as { skipped?: unknown } | null | undefined)?.skipped;
    status = typeof skipped === 'number' && skipped > 0 ? `${skipped} skipped` : '';
    onChange();
  }
  const focus = (tabId: number) => act(() => send({ type: 'tab.focus', tabId }));
  // The row's URL goes along: the worker refuses if the tab has navigated since (R61).
  const close = (r: ViewRow) => act(() => send({ type: 'view.close', viewId: view.id, tabId: r.tabId, url: r.url }));
  const keep = (r: ViewRow) => act(() => send({ type: 'view.keep', viewId: view.id, tabId: r.tabId, url: r.url }));
  // One request: the worker skips (and counts) pinned, locked and protected tabs (M3-R76).
  const closeAll = () => act(() => send({ type: 'view.close', viewId: view.id, tabs: rows.map((r) => ({ tabId: r.tabId, url: r.url })) }));
  /** The row's source state (e.g. merged), shown as a pill. */
  const stateOf = (r: ViewRow): string | undefined => (typeof r.source?.state === 'string' ? r.source.state : undefined);

  async function connect(): Promise<void> {
    try {
      await browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#/connections` });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  /** The permission request is the handler's first statement (user gesture), before any await. */
  function allow(lock: NonNullable<ViewSummary['locked']>): void {
    requestNeeds({ origins: lock.origins, permissions: lock.permissions }).then((granted) => { if (granted) onChange(); }, (e: unknown) => {
      error = e instanceof Error ? e.message : String(e);
    });
  }
</script>

<section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if status}<p class="paused" role="status">{status}</p>{/if}
  {#if view.locked}
    {@const lock = view.locked}
    <div class="locked">
      <p class="locked-text" title={view.paused}>{lock.text}</p>
      <div class="locked-actions">
        {#each lock.connections as c (c.id)}
          <button type="button" class="act" onclick={connect}>Connect {c.label}</button>
        {/each}
        {#if lock.origins.length > 0}
          <button type="button" class="act" onclick={() => allow(lock)}>Allow {lock.hosts.join(', ')}</button>
        {/if}
      </div>
    </div>
  {:else}
    {#if view.paused ?? view.notice}<p class="paused">{view.paused ?? view.notice}</p>{/if}
    {#if rows.length === 0 && done.length === 0}<p class="empty">Nothing here.</p>{/if}
  {/if}

  {#if toast}
    {@const t = toast}
    <p class="toast" role="status">
      {t.text}
      {#if t.ids.length > 0}<button type="button" class="act" onclick={() => projectActions.undo(t.ids)}>Undo</button>{/if}
    </p>
  {/if}
  {#if done.length > 0}
    <ul>
      {#each done as d (d.id)}
        <li>
          <div class="row project" role="group" aria-label={d.title}>
            <span class="text">
              <span class="title"><ProjectTitle title={d.title} subtitle={d.subtitle} /></span>
              <span class="reason">{d.issue ? 'Issue is closed' : 'Ticket is done'}</span>
            </span>
            {#if d.status}<span class={`status tone-${d.status.tone}`}>{d.status.label}</span>{/if}
            <span class="count">{d.tabCount} {d.tabCount === 1 ? 'tab' : 'tabs'}</span>
            <span class="project-actions">
              <button type="button" class="act" aria-label={`Close group ${d.title}`} onclick={() => projectActions.closeGroup(d.id)}>Close group</button>
              <button type="button" class="act" aria-label={`Close and archive ${d.title}`} onclick={() => projectActions.closeAndArchive(d.id)}>Close and archive</button>
              <button type="button" class="act" aria-label={`Keep ${d.title}`} onclick={() => projectActions.keepDone(d.id)}>Keep</button>
            </span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#each groups as g, gi (gi)}
    {#if g.name !== undefined}<h2 class="group">{g.name || '—'}</h2>{/if}
    <ul>
      {#each g.rows as r (r.tabId)}
        {@const name = r.title || r.url}
        <li class="row">
          {#if r.favIconUrl}
            <img class="fav" src={r.favIconUrl} alt="" width="16" height="16" />
          {:else}
            <span class="fav fav-ph" aria-hidden="true"></span>
          {/if}
          <span class="text">
            {#if can('focus')}
              <button type="button" class="title" title={r.url} onclick={() => focus(r.tabId)}>{name}</button>
            {:else}
              <span class="title" title={r.url}>{name}</span>
            {/if}
            {#if r.reason}<span class="reason">{r.reason}</span>{/if}
          </span>
          <PrPill state={stateOf(r)} stale={r.stale === true} staleLabel="Could not refresh this; it may be out of date" />
          {#if can('keep') && r.suggested}
            <button type="button" class="act" aria-label={`Keep ${name}`} onclick={() => keep(r)}>Keep</button>
          {/if}
          {#if can('close')}
            <button type="button" class="act" aria-label={`Close ${name}`} onclick={() => close(r)}>Close</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/each}

  {#if can('close-all') && rows.length > 0}
    <button type="button" class="all" onclick={closeAll}>Close all</button>
  {/if}
</section>

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; }
  .row:focus-within, .row:hover { background: var(--hover); }
  .fav { width: 16px; height: 16px; flex: none; border-radius: 3px; }
  .fav-ph { background: var(--border); display: inline-block; }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
    background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 2px 0; }
  span.title { cursor: default; }
  .reason { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group { font-size: 11px; font-weight: 600; color: var(--muted); margin: 0; padding: 8px 12px 2px; text-transform: none; }
  button { font: inherit; }
  /* .act: src/ui/tokens.css; .all looks the same. */
  .all { border: 1px solid var(--border); background: var(--surface); color: inherit; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .all { display: block; width: calc(100% - 24px); margin: 8px 12px; padding: 6px; }
  .error { color: var(--danger); margin: 6px 12px; font-size: 12px; }
  .paused { color: var(--muted); margin: 6px 12px; font-size: 12px; }
  .empty { color: var(--muted); padding: 12px; margin: 0; }
  /* A done project (#195): the card header's status pill and tab count; the buttons wrap below when narrow. */
  .project { flex-wrap: wrap; }
  .count { color: var(--muted); font-size: 11px; flex: none; }
  .status { flex: none; font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--border); color: var(--muted); }
  .tone-progress { color: var(--accent); border-color: var(--accent); }
  .tone-done { color: var(--ok, #1e8e3e); border-color: var(--ok, #1e8e3e); }
  .project-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .toast { display: flex; align-items: center; gap: 8px; margin: 6px 12px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
  .toast .act { background: var(--bg); }
  .locked { padding: 12px; }
  .locked-text { margin: 0 0 8px; font-weight: 600; }
  .locked-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
