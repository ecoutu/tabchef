<script lang="ts" module>
  export interface Crumb { label: string; subtitle?: string | undefined; href?: string | undefined; tip?: string | undefined }
  export interface CrumbTitle { title: string; subtitle?: string | undefined }

  /** `Projects › <project>` on a project's home; "Project" until its title is known. */
  export function projectCrumbs(project: CrumbTitle | undefined): Crumb[] {
    return [
      { label: 'Projects', href: '#/projects', tip: 'Back to all projects' },
      { label: project?.title ?? 'Project', subtitle: project?.subtitle },
    ];
  }
</script>

<script lang="ts">
  // Breadcrumbs (#180): where a page sits, e.g. `Projects › ABC-123 · Fix login`. Every crumb but the last is a link when
  // it has an href (in the accent color, so it reads as the way back); the last is the current page (aria-current), cut off with an
  // ellipsis when the line is too narrow. `size: 'title'` sets them at the side panel's heading size.
  import ProjectTitle from './ProjectTitle.svelte';

  let { crumbs, size = 'normal' }: { crumbs: readonly Crumb[]; size?: 'normal' | 'title' } = $props();
</script>

<nav aria-label="Breadcrumb" class={size}>
  <ol>
    {#each crumbs as c, i (i)}
      <li class:here={i === crumbs.length - 1}>
        {#if i < crumbs.length - 1 && c.href}
          <a href={c.href} title={c.tip}>{c.label}</a>
        {:else}
          <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}><ProjectTitle title={c.label} subtitle={c.subtitle} /></span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  ol { display: flex; align-items: baseline; min-width: 0; list-style: none; margin: 0; padding: 0; }
  li { flex: none; white-space: nowrap; }
  li + li::before { content: '›'; color: var(--muted); padding: 0 6px; }
  li.here { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  a { color: var(--accent); text-decoration: none; font-weight: 600; border-radius: 4px; padding: 1px 4px; margin: 0 -4px; }
  a:hover { text-decoration: underline; background: var(--hover); }
  .normal { font-size: 13px; margin: 8px 0; }
  .title { font-size: 15px; font-weight: 600; }
</style>
