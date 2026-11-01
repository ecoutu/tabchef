<script lang="ts">
  import { onMount } from 'svelte';
  import { onPermissionsChanged, parseSites, readPermissions, removePermissions, requestPermissions, type PermissionState } from '../../ui/permissions';

  let granted = $state<PermissionState | null>(null);
  let sites = $state('');
  let siteErrors = $state<string[]>([]);
  let error = $state('');

  async function refresh(): Promise<void> {
    try { granted = await readPermissions(); error = ''; } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  onMount(() => {
    void refresh();
    return onPermissionsChanged(() => { void refresh(); });
  });

  /** Requests run first thing in the click handler (user gesture); the outcome is read back from Chrome. */
  function settle(p: Promise<boolean>): void {
    p.then(() => refresh(), (e: unknown) => { error = e instanceof Error ? e.message : String(e); });
  }

  function enablePrompts(): void {
    const { origins, errors } = parseSites(sites);
    siteErrors = errors;
    if (errors.length) return;
    settle(requestPermissions({ permissions: ['scripting'], origins }));
  }
  function disablePrompts(): void {
    settle(removePermissions({ permissions: ['scripting'], ...(granted?.origins.length ? { origins: [...granted.origins] } : {}) }));
  }
  const enableNotifications = (): void => settle(requestPermissions({ permissions: ['notifications'] }));
  const disableNotifications = (): void => settle(removePermissions({ permissions: ['notifications'] }));

  const promptsOn = $derived(!!granted?.scripting && granted.origins.length > 0);
</script>

<div class="perms">
  <h3>Ask-mode prompts</h3>
  <p class="help">In ask mode Tabchef asks on the duplicate tab itself where it may, else with a notification, else in the popup.</p>

  <p class="state" role="status">{promptsOn ? `In-page prompts: on for ${granted!.origins.join(', ')}` : 'In-page prompts: off'}</p>
  <label class="col">Sites for in-page prompts (one per line)
    <textarea rows="2" placeholder="https://github.com/*" bind:value={sites}></textarea>
  </label>
  {#each siteErrors as m (m)}<p class="err" role="alert">{m}</p>{/each}
  <div class="row">
    <button type="button" onclick={enablePrompts}>Enable in-page prompts</button>
    {#if granted?.scripting || granted?.origins.length}
      <button type="button" onclick={disablePrompts}>Turn off in-page prompts</button>
    {/if}
  </div>

  <p class="state" role="status">{granted?.notifications ? 'Notifications: on' : 'Notifications: off'}</p>
  <div class="row">
    {#if granted?.notifications}
      <button type="button" onclick={disableNotifications}>Turn off notifications</button>
    {:else}
      <button type="button" onclick={enableNotifications}>Enable notifications</button>
    {/if}
  </div>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
</div>

<style>
  .perms { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  h3 { margin: 0; font-size: 13px; }
  .help { color: var(--muted); margin: 0; }
  .state { margin: 0; }
  .col { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  textarea { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; }
  .row { display: flex; gap: 8px; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
</style>
