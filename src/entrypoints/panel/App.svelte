<script lang="ts">
  // The side panel: the popup's Projects view at full height, kept current (config.changed, every 5 s while visible).
  // A card title opens that project's home in the panel itself (#/project/<id>, M4 T3); the panel switches on its hash.
  import { onMount } from 'svelte';
  import Projects from '../popup/tabs/Projects.svelte';
  import ProjectHome from '../options/ProjectHome.svelte';
  import { matchRoute, OPTIONS_ROUTES } from '../../ui/routes';

  const parse = () => matchRoute(OPTIONS_ROUTES, window.location.hash);
  let matched = $state(parse());
  onMount(() => {
    const onHash = (): void => { matched = parse(); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

<main>
  <header><h1>Projects</h1></header>
  {#if matched.path === '/project/:id'}
    {#key matched.params.id}<ProjectHome id={matched.params.id ?? ''} />{/key}
  {:else}
    <Projects live />
  {/if}
</main>

<style>
  /* Color tokens, the page base and .act: src/ui/tokens.css (main.ts). */
  main { min-height: 100vh; }
  header { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 15px; margin: 0; }
</style>
