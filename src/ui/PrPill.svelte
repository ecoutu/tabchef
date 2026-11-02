<script lang="ts">
  // A PR's state pill and stale marker, shared by the popup list views (M3 T13) and the project cards (M3 T17).
  // `staleLabel` is each caller's own copy (the marker's tooltip and accessible name).
  let { state, stale = false, staleLabel }: { state?: string; stale?: boolean; staleLabel: string } = $props();
</script>

{#if state}<span class={`pill pill-${state}`}>{state}</span>{/if}
{#if stale}<span class="pr-stale" role="img" title={staleLabel} aria-label={staleLabel}><span class="dot" aria-hidden="true"></span>stale</span>{/if}

<style>
  .pill { flex: none; font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--border); color: var(--muted); }
  .pill-merged { color: var(--accent); border-color: var(--accent); }
  .pr-stale { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--muted); font-style: italic; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
</style>
