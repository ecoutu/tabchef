<script lang="ts">
  // The Projects page (M4 T3): one link per project (projects.list) to its Project home.
  import { onMount } from 'svelte';
  import { send } from '../../ui/send';
  import { buildProjectCards, type ProjectCard } from '../../ui/projects-model';
  import { projectHomeHash } from '../../ui/routes';

  let cards = $state<ProjectCard[] | undefined>(undefined);
  let error = $state('');

  onMount(async () => {
    const r = await send({ type: 'projects.list' });
    if (r.ok) cards = buildProjectCards(r.data); else error = r.error;
  });
</script>

<section>
  <h2>Projects</h2>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if cards === undefined && !error}<p class="muted" role="status">Loading projects…</p>{/if}
  {#if cards && cards.length === 0}
    <p class="muted">No projects yet. Turn on a Jira ticket recipe, then open a Jira ticket.</p>
  {/if}
  <ul>
    {#each cards ?? [] as c (c.id)}
      <li>
        <a href={projectHomeHash(c.id)}>{c.title}</a>
        {#if c.status}<span class="status">{c.status.label}</span>{/if}
        <span class="muted">{c.tabCount} {c.tabCount === 1 ? 'tab' : 'tabs'}</span>
      </li>
    {/each}
  </ul>
</section>

<style>
  h2 { font-size: 16px; margin: 0 0 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
  li a { flex: 1; min-width: 0; color: var(--accent); }
  .status { font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; color: var(--muted); }
  .muted { color: var(--muted); }
  .err { color: var(--danger); }
</style>
