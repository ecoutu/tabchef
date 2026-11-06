<script lang="ts">
  // A project's home (M4 T3 stub; the body arrives with T4). Shows the project's title (or its id) and a link back.
  import { onMount } from 'svelte';
  import { send } from '../../ui/send';
  import { buildProjectCards } from '../../ui/projects-model';

  let { id }: { id: string } = $props();
  let title = $state<string | undefined>(undefined);

  onMount(async () => {
    const r = await send({ type: 'projects.list' });
    if (r.ok) title = buildProjectCards(r.data).find((c) => c.id === id)?.title;
  });
</script>

<section>
  <p><a href="#/projects">Projects</a></p>
  <h2>{title ?? id}</h2>
</section>

<style>
  h2 { font-size: 16px; margin: 0 0 8px; }
  a { color: var(--accent); }
</style>
