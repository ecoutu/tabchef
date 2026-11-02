<script lang="ts">
  // The Projects tab (M3 T17): one card per open project (projects.list), in the popup and, full height, in the side
  // panel. Opening it sends sources.refresh (SourceService refresh('popup'), throttled; M3-R83), then lists again.
  // `live` (the side panel): also re-fetch on config.changed and every LIVE_MS while the page is visible.
  import { onDestroy, onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { send } from '../../../ui/send';
  import { isConfigChangedMessage } from '../../../engine/messages';
  import { buildProjectCards, type ProjectCard as Card } from '../../../ui/projects-model';
  import ProjectCard from './ProjectCard.svelte';

  const LIVE_MS = 5000;
  let { live = false }: { live?: boolean } = $props();
  let cards = $state<Card[] | undefined>(undefined);
  let error = $state('');
  /** Done prompts the user answered Keep to (this page only). */
  let kept = $state<string[]>([]);
  /** After Close group: the closed tabs' recently-closed entries, which Undo reopens (M1 undo, recent.undo). */
  let toast = $state<{ text: string; ids: string[] } | undefined>(undefined);
  let seq = 0;

  async function load(): Promise<void> {
    const n = ++seq;
    const r = await send({ type: 'projects.list' });
    if (n !== seq) return; // a newer list is on its way
    if (r.ok) { cards = buildProjectCards(r.data); error = ''; } else error = r.error;
  }

  async function act(run: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
    const r = await run();
    if (!r.ok) { error = r.error ?? 'Something went wrong'; return false; }
    error = '';
    return true;
  }

  const focus = (tabId: number) => void act(() => send({ type: 'tab.focus', tabId }));
  async function openLinked(projectId: string, url: string): Promise<void> {
    if (await act(() => send({ type: 'projects.openLinked', projectId, url }))) await load();
  }
  async function closeGroup(projectId: string): Promise<void> {
    const r = await send({ type: 'projects.closeGroup', projectId });
    if (!r.ok) { error = r.error; return; }
    error = '';
    const { closed, skipped, ids } = r.data;
    const text = `Closed ${closed} ${closed === 1 ? 'tab' : 'tabs'}${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
    toast = closed > 0 || skipped > 0 ? { text, ids } : undefined;
    await load();
  }
  /** Restores the entries in turn; on a failure the ones not restored stay behind Undo. */
  async function undo(ids: string[]): Promise<void> {
    const text = toast?.text ?? '';
    for (const [i, id] of ids.entries()) {
      if (!(await act(() => send({ type: 'recent.undo', id })))) { toast = { text, ids: ids.slice(i) }; await load(); return; }
    }
    toast = undefined;
    await load();
  }

  const onMessage = (m: unknown) => { if (isConfigChangedMessage(m)) void load(); };
  const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    if (live) {
      browser.runtime.onMessage.addListener(onMessage);
      timer = setInterval(onVisible, LIVE_MS);
      document.addEventListener('visibilitychange', onVisible);
    }
    void load();
    void send({ type: 'sources.refresh' }).then((r) => (r.ok ? load() : undefined));
  });
  onDestroy(() => {
    if (timer !== undefined) clearInterval(timer);
    if (live) {
      browser.runtime.onMessage.removeListener(onMessage);
      document.removeEventListener('visibilitychange', onVisible);
    }
  });
</script>

<section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if toast}
    {@const t = toast}
    <p class="toast" role="status">
      {t.text}
      {#if t.ids.length > 0}<button type="button" class="act" onclick={() => undo(t.ids)}>Undo</button>{/if}
    </p>
  {/if}
  {#if cards && cards.length === 0}
    <p class="empty">No projects yet. Turn on a Jira ticket recipe, then open a Jira ticket.</p>
  {/if}
  {#each cards ?? [] as c (c.id)}
    <ProjectCard card={c} prompt={c.showClose && !kept.includes(c.id)}
      onFocus={focus} onOpenLinked={(url) => openLinked(c.id, url)} onCloseGroup={() => closeGroup(c.id)}
      onKeep={() => { kept = [...kept, c.id]; }} />
  {/each}
</section>

<style>
  .error { color: var(--danger); margin: 6px 12px; font-size: 12px; }
  .empty { color: var(--muted); padding: 12px; margin: 0; }
  /* Undo on the --surface toast: the page background, so it stands out (overrides .act's --surface). */
  .toast .act { background: var(--bg); }
  .toast { display: flex; align-items: center; gap: 8px; margin: 6px 12px; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
</style>
