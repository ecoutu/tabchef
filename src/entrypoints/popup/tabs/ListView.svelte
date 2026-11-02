<script lang="ts">
  // A recipe-declared `list` view (M2 T17), e.g. Finished: rows from view.data, buttons from the view's `actions`.
  import { send } from '../../../ui/send';
  import type { ViewRow, ViewSummary } from '../../../engine/views';

  let { view, rows, onChange }: { view: ViewSummary; rows: ViewRow[]; onChange: () => void } = $props();
  let error = $state('');

  const can = (a: ViewSummary['actions'][number]): boolean => view.actions.includes(a);
  /** Rows split into runs of the same `group` (rows arrive grouped and sorted). */
  const groups = $derived(rows.reduce<{ name?: string; rows: ViewRow[] }[]>((out, r) => {
    const last = out[out.length - 1];
    if (last && last.name === r.group) last.rows.push(r);
    else out.push({ ...(r.group !== undefined && { name: r.group }), rows: [r] });
    return out;
  }, []));

  /** Runs requests in order; shows a one-line error on the first failure, refreshes on success. */
  async function act(...runs: (() => Promise<{ ok: boolean; error?: string }>)[]): Promise<void> {
    for (const run of runs) {
      const r = await run();
      if (!r.ok) { error = r.error ?? 'Something went wrong'; return; }
    }
    error = '';
    onChange();
  }
  const focus = (tabId: number) => act(() => send({ type: 'tab.focus', tabId }));
  const close = (tabId: number) => act(() => send({ type: 'view.close', viewId: view.id, tabId }));
  const keep = (tabId: number) => act(() => send({ type: 'view.keep', viewId: view.id, tabId }));
  const closeAll = () => act(...rows.map((r) => () => send({ type: 'view.close', viewId: view.id, tabId: r.tabId })));
</script>

<section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if view.paused ?? view.notice}<p class="paused" role="status">{view.paused ?? view.notice}</p>{/if}
  {#if rows.length === 0}<p class="empty">Nothing here.</p>{/if}

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
          {#if can('keep') && r.suggested}
            <button type="button" class="act" aria-label={`Keep ${name}`} onclick={() => keep(r.tabId)}>Keep</button>
          {/if}
          {#if can('close')}
            <button type="button" class="act" aria-label={`Close ${name}`} onclick={() => close(r.tabId)}>Close</button>
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
  .act, .all { border: 1px solid var(--border); background: var(--surface); color: inherit; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .all { display: block; width: calc(100% - 24px); margin: 8px 12px; padding: 6px; }
  .error { color: var(--danger); margin: 6px 12px; font-size: 12px; }
  .paused { color: var(--muted); margin: 6px 12px; font-size: 12px; }
  .empty { color: var(--muted); padding: 12px; margin: 0; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
