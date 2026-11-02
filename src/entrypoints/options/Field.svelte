<script lang="ts">
  // One options setting: its label wrapping the control (text above it, or after it when `inline`, for checkboxes) and
  // an optional help tip beside the label, never inside it (a button in a label is invalid and can toggle the control).
  import type { Snippet } from 'svelte';
  import Help from './Help.svelte';

  let { label, help, helpLabel, inline = false, children }: {
    label: string;
    /** The tip's text; no tip without it. */
    help?: string;
    /** The tip's short name ("About <helpLabel>"); default `label`. */
    helpLabel?: string;
    inline?: boolean;
    children: Snippet;
  } = $props();
</script>

<span class="field" class:inline>
  {#if inline}
    <label>{@render children()} {label}</label>
  {:else}
    <label>{label}{@render children()}</label>
  {/if}
  {#if help}<Help label={helpLabel ?? label} text={help} />{/if}
</span>

<style>
  .field { display: inline-flex; align-items: flex-end; gap: 6px; min-width: 0; }
  .field > label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); min-width: 0; flex: 1; }
  .field.inline { align-items: center; }
  .field.inline > label { flex-direction: row; align-items: center; gap: 6px; font-size: inherit; color: inherit; flex: 0 1 auto; }
</style>
