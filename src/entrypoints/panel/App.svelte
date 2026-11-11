<script lang="ts">
  // The side panel: the popup's Projects view at full height, kept current (config.changed, every 5 s while visible).
  // A card title opens that project's home in the panel itself (#/project/<id>, M4 T3); the panel switches on its hash.
  // There the header turns into breadcrumbs (#180), `Projects › <project>`, whose Projects goes back to the list.
  import { onMount } from 'svelte';
  import Projects from '../popup/tabs/Projects.svelte';
  import ProjectHome from '../options/ProjectHome.svelte';
  import Breadcrumbs, { projectCrumbs, type CrumbTitle } from '../../ui/Breadcrumbs.svelte';
  import { matchRoute, OPTIONS_ROUTES } from '../../ui/routes';

  const parse = () => matchRoute(OPTIONS_ROUTES, window.location.hash);
  let matched = $state(parse());
  let project = $state<CrumbTitle | undefined>(undefined);
  onMount(() => {
    const onHash = (): void => { matched = parse(); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

<main>
  {#if matched.path === '/project/:id'}
    <header><h1 class="sr-only">Projects</h1><Breadcrumbs crumbs={projectCrumbs(project)} size="title" /></header>
    {#key matched.params.id}<ProjectHome id={matched.params.id ?? ''} onTitle={(t) => { project = t; }} />{/key}
  {:else}
    <header><h1>Projects</h1></header>
    <Projects live />
  {/if}
</main>

<style>
  /* Color tokens, the page base and .act: src/ui/tokens.css (main.ts). */
  main { min-height: 100vh; }
  header { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 15px; margin: 0; }
  /* Read by screen readers only: the breadcrumbs show the page's place, and the page keeps one level-1 heading. */
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
