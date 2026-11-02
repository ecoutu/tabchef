<script lang="ts">
  import { onMount } from 'svelte';
  import { send } from '../../ui/send';
  import type { WhyEntry } from '../../core/safety/why-log';
  import type { RecentlyClosedItem } from '../../core/safety/recently-closed';

  let why = $state<WhyEntry[]>([]);
  let recent = $state<RecentlyClosedItem[]>([]);
  let filter = $state('');
  let dryOnly = $state(false);
  let error = $state('');

  const shown = $derived.by(() => {
    const id = filter.trim() === '' ? undefined : Number(filter);
    const byTab = id === undefined || Number.isNaN(id) ? why : why.filter((e) => e.tabId === id);
    const list = dryOnly ? byTab.filter((e) => e.dryRun) : byTab;
    return list.slice().sort((a, b) => b.at - a.at);
  });
  const time = (at: number): string => new Date(at).toLocaleString();

  async function load(): Promise<void> {
    const [w, r] = await Promise.all([send({ type: 'why.all' }), send({ type: 'recent.list' })]);
    error = '';
    if (w.ok) why = w.data; else error = w.error;
    if (r.ok) recent = r.data; else error = r.error;
  }
  async function undo(id: string): Promise<void> {
    const r = await send({ type: 'recent.undo', id });
    if (!r.ok) error = r.error;
    await load();
  }
  onMount(load);
</script>

<section>
  {#if error}<p class="err" role="alert">{error}</p>{/if}

  <h2>Recently closed</h2>
  {#if recent.length === 0}<p class="empty">Nothing closed by Tabchef recently.</p>{/if}
  <ul>
    {#each recent as e (e.id)}
      <li>
        <div class="main">
          <span class="title">{e.title || e.url}</span>
          <span class="meta">{e.url} · {e.reason}{e.groupTitle ? ` · ${e.groupTitle}` : ''} · {time(e.at)}</span>
        </div>
        <button type="button" aria-label={`Undo close of ${e.title || e.url}`} onclick={() => undo(e.id)}>Undo</button>
      </li>
    {/each}
  </ul>

  <h2>Why log</h2>
  <div class="filters">
    <label class="filter">Filter by tab id <input inputmode="numeric" bind:value={filter} placeholder="all tabs" /></label>
    <label class="filter"><input type="checkbox" bind:checked={dryOnly} /> Dry run only</label>
  </div>
  {#if shown.length === 0}<p class="empty">No entries.</p>{/if}
  <ul>
    {#each shown as e, i (`${e.at}-${i}`)}
      <li>
        <div class="main">
          <span class="title">{#if e.dryRun}<span class="chip">dry run</span> {/if}{e.action}{e.tabId !== undefined ? ` · tab ${e.tabId}` : ''}{e.ruleId ? ` · rule ${e.ruleId}` : ''}</span>
          <span class="meta">{e.detail} · {time(e.at)}</span>
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  h2 { font-size: 15px; margin: 16px 0 6px; }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 6px 8px; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .title { overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .empty { color: var(--muted); }
  .filters { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .filter { display: inline-flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .chip { display: inline-block; border: 1px solid var(--border); background: var(--hover); color: var(--muted); border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .err { color: var(--danger); }
</style>
