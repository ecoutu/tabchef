<script lang="ts">
  // The Projects page (M4 T3): one link per project (projects.list) to its Project home. M4 T6 (M4-R8): a New project
  // form (a name, then projects.create of a Manual project), open on `#/projects?new=<tabId>` (the context menu's "Add
  // to project › New project…", with that tab), else behind a New project button; Create opens the new project's home.
  // M4-R10: with the Manual projects recipe off (R68: off on installs from before it), a note links to the Recipes page,
  // where it is turned on through the preview; no form. Unknown (config.get failed): the form, and Create's error.
  // M4 T8: a "Save a group" list of the open groups no project holds (projects.groups; self-contained: it loads and
  // saves by itself), each with a Save button (projects.saveGroup, then the new project's home). Not offered when the
  // recipe is off (the engine then lists none).
  import { onMount } from 'svelte';
  import { send } from '../../ui/send';
  import { buildProjectCards, type ProjectCard } from '../../ui/projects-model';
  import { projectHomeHash } from '../../ui/routes';

  /** The route's `new` param: the tab to put in the new project. */
  let { newTab, initialError }: { newTab?: string; initialError?: string } = $props();

  let cards = $state<ProjectCard[] | undefined>(undefined);
  // svelte-ignore state_referenced_locally
  let error = $state(initialError ?? ''); // M4 T8: the context menu's failed Save group as project
  // Read once: the route remounts this page ({#key}) when `new` changes.
  // svelte-ignore state_referenced_locally
  let formOpen = $state(newTab !== undefined);
  let name = $state('');
  let creating = $state(false);
  /** Whether the manual-project recipe is on; undefined until (or unless) config.get answers. */
  let manualOn = $state<boolean | undefined>(undefined);
  let groups = $state<{ id: number; title: string; color: string; tabCount: number }[]>([]);
  let savingGroup = $state<number | undefined>(undefined);
  const tabId = $derived(newTab !== undefined && /^\d+$/.test(newTab) ? Number(newTab) : undefined);

  async function create(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || creating) return;
    creating = true;
    const r = await send({ type: 'projects.create', recipeId: 'manual-project', name: name.trim(), ...(tabId !== undefined && { tabIds: [tabId] }) });
    creating = false;
    if (!r.ok) { error = r.error; return; }
    error = '';
    window.location.hash = projectHomeHash(r.data.id);
  }

  async function saveGroup(id: number): Promise<void> {
    if (savingGroup !== undefined) return;
    savingGroup = id;
    const r = await send({ type: 'projects.saveGroup', groupId: id });
    savingGroup = undefined;
    if (!r.ok) { error = r.error; return; }
    error = '';
    window.location.hash = projectHomeHash(r.data.id);
  }

  onMount(async () => {
    void send({ type: 'projects.groups' }).then((g) => { if (g.ok && Array.isArray(g.data)) groups = g.data; }, () => {});
    void send({ type: 'config.get' }).then((c) => {
      // Read defensively: this note must never break the page.
      const refs: unknown = c.ok ? (c.data as { config?: { recipes?: unknown } } | null)?.config?.recipes : undefined;
      if (Array.isArray(refs)) manualOn = refs.some((r: { id?: unknown; enabled?: unknown }) => r?.id === 'manual-project' && r.enabled === true);
    }, () => {});
    const r = await send({ type: 'projects.list' });
    if (r.ok) cards = buildProjectCards(r.data); else error = r.error;
  });
</script>

<section>
  <h2>Projects</h2>
  {#if manualOn === false}
    <p class="muted">Manual projects are turned off. Turn them on under <a href="#/recipes">Recipes</a> to create a project.</p>
  {:else if formOpen}
    <form class="new" onsubmit={create}>
      <label for="new-project-name">Project name</label>
      <input id="new-project-name" bind:value={name} />
      <button type="submit" disabled={!name.trim() || creating}>Create</button>
    </form>
  {:else}
    <button type="button" onclick={() => { formOpen = true; }}>New project</button>
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if cards === undefined && !error}<p class="muted" role="status">Loading projects…</p>{/if}
  {#if cards && cards.length === 0}
    <p class="muted">No projects yet. Create one with New project, or turn on a Jira ticket recipe and open a Jira ticket.</p>
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
  {#if groups.length > 0 && manualOn !== false}
    <h3>Save a group</h3>
    <ul>
      {#each groups as g (g.id)}
        <li>
          <span class={`swatch g-${g.color}`} aria-hidden="true"></span>
          <span class="grow">{g.title || 'Name the group in Chrome to save it'}</span>
          <span class="muted">{g.tabCount} {g.tabCount === 1 ? 'tab' : 'tabs'}</span>
          {#if g.title}
            <button type="button" aria-label={`Save ${g.title}`} disabled={savingGroup !== undefined} onclick={() => saveGroup(g.id)}>Save</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  h3 { font-size: 14px; margin: 16px 0 4px; }
  .grow { flex: 1; min-width: 0; }
  .swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #5f6368; }
  .g-blue { background: #1a73e8; } .g-red { background: #d93025; } .g-yellow { background: #f9ab00; }
  .g-green { background: #188038; } .g-pink { background: #d01884; } .g-purple { background: #a142f4; }
  .g-cyan { background: #007b83; } .g-orange { background: #fa903e; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  .new { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
  li a { flex: 1; min-width: 0; color: var(--accent); }
  .status { font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; color: var(--muted); }
  .muted { color: var(--muted); }
  .err { color: var(--danger); }
</style>
