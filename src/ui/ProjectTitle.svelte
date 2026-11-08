<script lang="ts">
  // A project's title in a list or heading, with its ticket title (projectSubtitle) muted beside it on the same line:
  // `ABC-123 · Fix login`. The space before the dot is outside the muted span, so the accessible name reads the same.
  // The full text is the hover tooltip, for when the line is cut off. It sits on this span, not on the link or heading
  // around it, so their accessible name stays the text and the same text is not read again as their description.
  let { title, subtitle }: { title: string; subtitle?: string | undefined } = $props();
  const lead = $derived(subtitle ? `${title} ` : title);
  const full = $derived(subtitle ? `${title} · ${subtitle}` : title);
</script>

<span title={full}>{lead}{#if subtitle}<span class="sub">· {subtitle}</span>{/if}</span>

<style>
  .sub { color: var(--muted); font-weight: 400; }
</style>
