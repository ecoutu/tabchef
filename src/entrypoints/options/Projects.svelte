<script lang="ts">
  // The Projects page (M4 T3): one link per project (projects.list) to its Project home. M4 T6 (M4-R8): a New project
  // form (a name, then projects.create of a Manual project), open on `#/projects?new=<tabId>` (the context menu's "Add
  // to project › New project…", with that tab), else behind a New project button; Create opens the new project's home.
  // M4-R10: with the Manual projects recipe off (R68: off on installs from before it), a note links to the Recipes page,
  // where it is turned on through the preview; no form. Unknown (config.get failed): the form, and Create's error.
  // M4 T8: a "Save a group" list of the open groups no project holds (projects.groups; self-contained: it loads and
  // saves by itself), each with a Save button (projects.saveGroup, then the new project's home). Not offered when the
  // recipe is off (the engine then lists none).
  // M4 T9: three sections, Open (projects.list; Close and archive on a ticket Done by fresh data, M3-R90), Saved (kept,
  // nothing open: Reopen, Archive) and Archived ("Archived: reopen?" when a rule assigns its key: Reopen, Unarchive), from
  // projects.savedLists; kept current like Project home (M4-R6: config.changed and every LIVE_MS while visible).
  import { onDestroy, onMount } from 'svelte';
  import { send } from '../../ui/send';
  import { createProjectActions, startLiveRefresh, type Toast } from '../../ui/project-actions';
  import { buildProjectCards, type ProjectCard } from '../../ui/projects-model';
  import { projectHomeHash } from '../../ui/routes';
  import type { SavedProjectData } from '../../core/projects/types';

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
  let saved = $state<SavedProjectData[]>([]);
  let archived = $state<SavedProjectData[]>([]);
  /** After Close and archive: the closed tabs' recently-closed entries, which Undo reopens (recent.undo). */
  let toast = $state<Toast | undefined>(undefined);
  let seq = 0;
  const empty = $derived(cards !== undefined && cards.length === 0 && saved.length === 0 && archived.length === 0);
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

  /** The three sections and the Save a group list. An error stays until an action succeeds (an initial one too). */
  async function load(): Promise<void> {
    const n = ++seq;
    const [r, l, g] = await Promise.all([send({ type: 'projects.list' }), send({ type: 'projects.savedLists' }), send({ type: 'projects.groups' })]);
    if (n !== seq) return; // a newer read is on its way
    if (r.ok) cards = buildProjectCards(r.data); else error = r.error;
    // Read defensively: the Saved / Archived and group lists must never break the page.
    const lists = l.ok ? (l.data as Partial<Record<'saved' | 'archived', unknown>> | null) : undefined;
    if (lists) {
      saved = Array.isArray(lists.saved) ? lists.saved : [];
      archived = Array.isArray(lists.archived) ? lists.archived : [];
    }
    if (g.ok && Array.isArray(g.data)) groups = g.data;
  }

  const actions = createProjectActions({
    reload: load,
    setError: (e) => { error = e; },
    getToast: () => toast,
    setToast: (t) => { toast = t; },
  });
  const { closeAndArchive, reopen, archive, unarchive, undo } = actions;

  let stopLive: (() => void) | undefined;
  onDestroy(() => stopLive?.());

  onMount(async () => {
    stopLive = startLiveRefresh(load);
    void send({ type: 'config.get' }).then((c) => {
      // Read defensively: this note must never break the page.
      const refs: unknown = c.ok ? (c.data as { config?: { recipes?: unknown } } | null)?.config?.recipes : undefined;
      if (Array.isArray(refs)) manualOn = refs.some((r: { id?: unknown; enabled?: unknown }) => r?.id === 'manual-project' && r.enabled === true);
    }, () => {});
    await load();
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
  {#if toast}
    {@const t = toast}
    <p class="toast" role="status">
      {t.text}
      {#if t.ids.length > 0}<button type="button" onclick={() => undo(t.ids)}>Undo</button>{/if}
    </p>
  {/if}
  {#if cards === undefined && !error}<p class="muted" role="status">Loading projects…</p>{/if}
  {#if empty}
    <p class="muted">No projects yet. Create one with New project, or turn on a Jira ticket recipe and open a Jira ticket.</p>
  {/if}
  {#if cards && cards.length > 0}
    <section aria-labelledby="projects-open">
      <h3 id="projects-open">Open</h3>
      <ul>
        {#each cards as c (c.id)}
          <li>
            <a href={projectHomeHash(c.id)}>{c.title}</a>
            {#if c.status}<span class="status">{c.status.label}</span>{/if}
            <span class="muted">{c.tabCount} {c.tabCount === 1 ? 'tab' : 'tabs'}</span>
            {#if c.showClose}
              <button type="button" aria-label={`Close and archive ${c.title}`} onclick={() => closeAndArchive(c.id)}>Close and archive</button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if saved.length > 0}
    <section aria-labelledby="projects-saved">
      <h3 id="projects-saved">Saved</h3>
      <ul>
        {#each saved as p (p.id)}
          <li>
            <a href={projectHomeHash(p.id)}>{p.title}</a>
            <span class="muted">{p.savedCount} saved {p.savedCount === 1 ? 'tab' : 'tabs'}</span>
            {#if p.savedCount > 0}
              <button type="button" aria-label={`Reopen ${p.title}`} onclick={() => reopen(p.id)}>Reopen</button>
            {/if}
            <button type="button" aria-label={`Archive ${p.title}`} onclick={() => archive(p.id)}>Archive</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if archived.length > 0}
    <section aria-labelledby="projects-archived">
      <h3 id="projects-archived">Archived</h3>
      <ul>
        {#each archived as p (p.id)}
          <li>
            <a href={projectHomeHash(p.id)}>{p.title}</a>
            {#if p.held > 0}<span class="note">Archived: reopen?</span>{/if}
            <button type="button" aria-label={`Reopen ${p.title}`} onclick={() => reopen(p.id)}>Reopen</button>
            <button type="button" aria-label={`Unarchive ${p.title}`} onclick={() => unarchive(p.id)}>Unarchive</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
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
  .note { font-size: 12px; color: var(--accent); }
  .toast { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
</style>
