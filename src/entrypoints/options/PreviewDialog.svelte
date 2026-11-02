<script lang="ts">
  // Preview before apply (M2 T13): what a change would do to the open tabs. It only reports; the caller sends the
  // change on Apply (options Save → config.set, T15 recipes → recipes.enable). Dry-run entries are labelled and left
  // out of the counts (R30).
  import { onMount } from 'svelte';
  import { previewText, type PreviewResult } from '../../core/lang/preview';

  let { result, onApply, onCancel }: { result: PreviewResult; onApply: () => void; onCancel: () => void } = $props();

  /** Long lists are cut here; the counts above stay exact. */
  const SHOWN = 50;
  const DRY = '(dry run: logged only)';
  const place = (title: string | undefined): string => title ?? 'no group';
  const delay = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);
  const moves = $derived(result.moves.slice(0, SHOWN));
  const closes = $derived(result.closes.slice(0, SHOWN));
  let apply = $state<HTMLButtonElement>();

  onMount(() => { apply?.focus(); });
</script>

<div class="backdrop">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title" tabindex="-1"
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}>
    <h2 id="preview-title">Preview</h2>
    <p class="summary">{previewText(result)}</p>
    {#if result.dryRun}<p class="note">Dry run is on: nothing would really move or close.</p>{/if}
    {#if result.anchorsOpened > 0}<p class="note">{result.anchorsOpened} anchor tabs would open.</p>{/if}
    {#if result.groupsCreated.length}<p class="note">New groups: {result.groupsCreated.join(', ')}</p>{/if}
    {#if moves.length}
      <h3>Moves</h3>
      <ul>
        {#each moves as m, i (`${m.tabId}|${i}`)}
          <li>{m.title || 'Untitled tab'}: {place(m.from)} → {place(m.to)}{#if m.dryRun} <span class="dry">{DRY}</span>{/if}</li>
        {/each}
      </ul>
      {#if result.moves.length > SHOWN}<p class="note">and {result.moves.length - SHOWN} more</p>{/if}
    {/if}
    {#if closes.length}
      <h3>Closes</h3>
      <ul>
        {#each closes as c, i (`${c.tabId}|${i}`)}
          <li>{c.title || 'Untitled tab'}: closes after {delay(c.afterMs)}{#if c.dryRun} <span class="dry">{DRY}</span>{/if}</li>
        {/each}
      </ul>
      {#if result.closes.length > SHOWN}<p class="note">and {result.closes.length - SHOWN} more</p>{/if}
    {/if}
    <div class="actions">
      <button type="button" class="primary" bind:this={apply} onclick={onApply}>Apply</button>
      <button type="button" onclick={onCancel}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / 0.35); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 10; }
  .dialog { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 16px; width: min(560px, 100%); max-height: 80vh; overflow: auto; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  h3 { font-size: 13px; margin: 12px 0 4px; color: var(--muted); }
  .summary { font-weight: 600; margin: 0 0 6px; }
  .note { color: var(--muted); margin: 2px 0; }
  ul { margin: 0; padding-left: 18px; }
  li { overflow-wrap: anywhere; }
  .dry { color: var(--muted); font-style: italic; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
</style>
