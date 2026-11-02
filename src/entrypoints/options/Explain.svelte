<script lang="ts">
  // The conflict view (M2 T14): why a tab is where it is. Rules are listed by name (R19) in priority order, with the
  // action kinds each one won and, for kinds it lost, the rule that won them (R34). Dry-run rules read "Would win"
  // (R48), paused ones show their reason (R45). Read-only.
  import { onMount } from 'svelte';
  import { send } from '../../ui/send';
  import type { ExplainView } from '../../engine/messages';
  import type { ExplainEntry } from '../../core/lang/explain';

  let { tabId }: { tabId: number } = $props();

  let view = $state<ExplainView | null>(null);
  let error = $state('');

  const nameOf = (key: string): string => view?.rules.find((r) => r.key === key)?.name ?? key;
  const KIND: Record<string, string> = { group: 'group', dedupe: 'dedupe', close: 'close', showInView: 'view', assignProject: 'project' };
  const kinds = (ks: string[]): string => ks.map((k) => KIND[k] ?? k).join(', ');
  const lost = (e: ExplainEntry): [string, string][] => Object.entries(e.lostTo).filter((x): x is [string, string] => typeof x[1] === 'string');

  async function load(): Promise<void> {
    if (!Number.isInteger(tabId)) { error = 'Unknown tab.'; return; }
    const r = await send({ type: 'explain.tab', tabId });
    if (r.ok) { view = r.data; error = ''; } else error = r.error;
  }
  onMount(load);
</script>

<section>
  <h2>Why is this tab here?</h2>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if view}
    <div class="tab">
      <span class="title">{view.tab.title || view.tab.url}</span>
      <span class="meta">{view.tab.url}</span>
      <span class="meta">{view.tab.groupTitle !== undefined ? `In group "${view.tab.groupTitle}"` : 'Not in a group'} · tab {view.tab.id}</span>
    </div>
    <button type="button" onclick={load}>Refresh</button>
    {#if view.rules.length === 0}
      <p class="empty">No rule applies to this tab.</p>
    {:else}
      <ol>
        {#each view.rules as e (e.key)}
          <li aria-label={e.name} class:inactive={!e.matched || e.paused !== undefined}>
            <div class="head">
              <span class="name">{e.name}</span>
              <span class="key">{e.key}</span>
              {#if e.dryRun}<span class="chip">dry run: logged only</span>{/if}
              {#if e.needsPage}<span class="chip">needs page facts</span>{/if}
            </div>
            {#if e.paused !== undefined}
              <span class="meta">{e.paused}</span>
            {:else if !e.matched}
              <span class="meta">Does not match{e.needsPage ? ' yet' : ''}.</span>
            {/if}
            {#if e.won.length}<span class="won">{e.dryRun ? 'Would win' : 'Won'} {kinds(e.won)}</span>{/if}
            {#each lost(e) as [kind, by] (kind)}
              <span class="lost">Lost {kinds([kind])} to {nameOf(by)}</span>
            {/each}
            {#if e.matched && e.paused === undefined && !e.won.length && !lost(e).length}
              <span class="meta">Matches, but has no effect on this tab.</span>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</section>

<style>
  h2 { font-size: 15px; margin: 0 0 8px; }
  .tab { display: flex; flex-direction: column; margin-bottom: 8px; }
  .title { overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  ol { padding: 0; margin: 10px 0 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 6px 8px; }
  li.inactive { opacity: 0.7; }
  .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .key { color: var(--muted); font-size: 11px; font-family: monospace; }
  .won { color: var(--accent); font-size: 12px; }
  .lost { font-size: 12px; }
  .chip { display: inline-block; border: 1px solid var(--border); background: var(--hover); color: var(--muted); border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .empty { color: var(--muted); }
  .err { color: var(--danger); }
</style>
