<script lang="ts">
  import { send } from '../../../ui/send';
  import type { DupeSetView } from '../../../engine/messages';
  import type { PendingAsk } from '../../../engine/ask';

  let { data, onChange }: { data: { sets: DupeSetView[]; pending: PendingAsk[]; locked?: number[] }; onChange: () => void } = $props();
  let error = $state('');

  /** Runs a request; shows a one-line error on failure, refreshes the list on success. */
  async function act(run: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    const r = await run();
    if (r.ok) { error = ''; onChange(); } else error = r.error ?? 'Something went wrong';
  }
  const closeExtras = (key: string) => act(() => send({ type: 'dupes.closeExtras', key }));
  const closeAll = () => act(() => send({ type: 'dupes.closeAll' }));
  const focus = (tabId: number) => act(() => send({ type: 'tab.focus', tabId }));
  const isLocked = (tabId: number): boolean => (data.locked ?? []).includes(tabId);
  const toggleLock = (tabId: number) => act(() => send({ type: isLocked(tabId) ? 'tab.unlock' : 'tab.lock', tabId }));
  const resolve = (a: PendingAsk, choice: 'switch' | 'keep') =>
    act(() => send({ type: 'dupes.resolve', newTabId: a.newTabId, existingTabId: a.existingTabId, choice }));
  const anyClosable = $derived(data.sets.some((s) => s.closable > 0));
</script>

<section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#each data.pending as a (a.newTabId)}
    <div class="ask">
      <span class="ask-text">A new tab duplicates an open one.</span>
      <button type="button" onclick={() => resolve(a, 'switch')}>Switch</button>
      <button type="button" onclick={() => resolve(a, 'keep')}>Keep both</button>
    </div>
  {/each}

  {#if data.sets.length === 0 && data.pending.length === 0}
    <p class="empty">No duplicate tabs.</p>
  {/if}

  <ul>
    {#each data.sets as s (s.key)}
      {@const oldest = s.tabs[0]}
      {#if oldest}
        <li class="row">
          {#if oldest.favIconUrl}
            <img class="fav" src={oldest.favIconUrl} alt="" width="16" height="16" />
          {:else}
            <span class="fav fav-ph" aria-hidden="true"></span>
          {/if}
          <button type="button" class="title" onclick={() => focus(oldest.id)}>{oldest.title || oldest.url}</button>
          <span class="count">open {s.tabs.length}×</span>
          <button type="button" class="lock" aria-label={`${isLocked(oldest.id) ? 'Unlock' : 'Lock'} tab ${oldest.title || oldest.url}`}
            aria-pressed={isLocked(oldest.id)} onclick={() => toggleLock(oldest.id)}>{isLocked(oldest.id) ? 'Unlock' : 'Lock'}</button>
          {#if s.closable > 0}
            <button type="button" class="close" onclick={() => closeExtras(s.key)}>close {s.closable}</button>
          {/if}
        </li>
      {/if}
    {/each}
  </ul>

  {#if anyClosable}
    <button type="button" class="all" onclick={closeAll}>Close all duplicates</button>
  {/if}
</section>

<style>
  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; }
  .row:focus-within, .row:hover { background: var(--hover); }
  .fav { width: 16px; height: 16px; flex: none; border-radius: 3px; }
  .fav-ph { background: var(--border); display: inline-block; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
    background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 2px 0; }
  .count { color: var(--muted); font-size: 12px; white-space: nowrap; }
  button { font: inherit; }
  .close, .lock, .ask button, .all { border: 1px solid var(--border); background: var(--surface); color: inherit; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .all { display: block; width: calc(100% - 24px); margin: 8px 12px; padding: 6px; }
  .ask { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: var(--hover); }
  .ask-text { flex: 1; font-size: 12px; }
  .error { color: var(--danger); margin: 6px 12px; font-size: 12px; }
  .empty { color: var(--muted); padding: 12px; margin: 0; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
