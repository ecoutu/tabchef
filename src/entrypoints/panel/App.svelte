<script lang="ts">
  // The side panel: the popup's Projects view at full height, kept current (config.changed, every 5 s while visible).
  import Projects from '../popup/tabs/Projects.svelte';
</script>

<main>
  <header><h1>Projects</h1></header>
  <Projects live />
</main>

<style>
  /* Color tokens, the page base and .act: src/ui/tokens.css (main.ts). */
  main { min-height: 100vh; }
  header { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 15px; margin: 0; }
</style>
