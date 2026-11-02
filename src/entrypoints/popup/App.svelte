<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { send } from '../../ui/send';
  import { buildPopupModel, TAB_REGISTRY } from '../../ui/popup-model';
  import type { DupeSetView } from '../../engine/messages';
  import type { PendingAsk } from '../../engine/ask';
  import type { PauseDuration } from '../../engine/safety';
  import Duplicates from './tabs/Duplicates.svelte';

  let sets = $state<DupeSetView[]>([]);
  let pending = $state<PendingAsk[]>([]);
  let paused = $state(false);
  let locked = $state<number[]>([]);
  let currentTabId = $state<number | undefined>(undefined);
  let syncWarning = $state('');
  /** Global dry run (config.dryRun, M2 T12): the engine only logs. T17's popup rewrite keeps this header chip. */
  let dryRun = $state(false);
  let recentCount = $state(0);
  let lastTab = $state<string | undefined>(undefined);
  let error = $state('');
  let menuOpen = $state(false);

  const model = $derived(buildPopupModel({ dupes: sets, pending, paused, recentCount, lastTab }, TAB_REGISTRY));

  async function refresh(): Promise<void> {
    const [d, s, r, c, g] = await Promise.all([
      send({ type: 'dupes.list' }), send({ type: 'safety.status' }), send({ type: 'recent.list' }), send({ type: 'config.status' }),
      send({ type: 'config.get' }),
    ]);
    const errs: string[] = [];
    if (d.ok) { sets = d.data.sets; pending = d.data.pending; } else errs.push(d.error);
    if (s.ok) { paused = s.data.paused; locked = s.data.locked ?? []; } else errs.push(s.error);
    if (r.ok) recentCount = r.data.length; else errs.push(r.error);
    if (c.ok) syncWarning = c.data?.warning ?? ''; else errs.push(c.error);
    if (g.ok) dryRun = g.data?.config.dryRun === true; else errs.push(g.error);
    error = errs[0] ?? '';
  }

  onMount(async () => {
    try {
      const v = (await browser.storage.local.get('popup.lastTab'))['popup.lastTab'];
      if (typeof v === 'string') lastTab = v;
    } catch { /* storage unavailable: use default tab */ }
    try {
      currentTabId = (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    } catch { /* no current tab (e.g. devtools): no lock button */ }
    await refresh();
  });

  async function selectTab(id: string): Promise<void> {
    lastTab = id;
    try { await browser.storage.local.set({ 'popup.lastTab': id }); } catch { /* best effort */ }
  }

  async function setPause(d: PauseDuration | 'resume'): Promise<void> {
    menuOpen = false;
    const r = d === 'resume' ? await send({ type: 'safety.resume' }) : await send({ type: 'safety.pause', d });
    if (!r.ok) error = r.error;
    await refresh();
  }

  const currentLocked = $derived(currentTabId !== undefined && locked.includes(currentTabId));

  async function toggleCurrentLock(): Promise<void> {
    if (currentTabId === undefined) return;
    const r = await send({ type: currentLocked ? 'tab.unlock' : 'tab.lock', tabId: currentTabId });
    if (!r.ok) error = r.error;
    await refresh();
  }

  async function openOptions(hash: string): Promise<void> {
    try {
      await browser.tabs.create({ url: browser.runtime.getURL('/options.html') + hash });
      window.close();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<main>
  <header>
    <h1>Tabchef</h1>
    {#if dryRun}<span class="chip" role="status" title="Dry run: Tabchef only logs what it would do">Dry run</span>{/if}
    <span class="total" aria-label="{model.header.total} items">{model.header.total}</span>
    {#if currentTabId !== undefined}
      <button type="button" class="lock" aria-pressed={currentLocked} onclick={toggleCurrentLock}>
        {currentLocked ? 'Unlock current tab' : 'Lock current tab'}
      </button>
    {/if}
    <div class="pause">
      <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
        {model.header.paused ? 'Paused' : 'Pause'}
      </button>
      {#if menuOpen}
        <div class="menu" role="menu">
          <button type="button" role="menuitem" onclick={() => setPause('15m')}>15 min</button>
          <button type="button" role="menuitem" onclick={() => setPause('1h')}>1 h</button>
          <button type="button" role="menuitem" onclick={() => setPause('restart')}>Until restart</button>
          <button type="button" role="menuitem" onclick={() => setPause('resume')}>Resume</button>
        </div>
      {/if}
    </div>
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if syncWarning}<p class="warn" role="status" title={syncWarning} data-testid="sync-warning">{syncWarning}</p>{/if}

  <div class="tabs" role="tablist">
    {#each model.tabs as t (t.id)}
      <button type="button" role="tab" aria-selected={t.id === model.activeTab} class:faded={t.faded} onclick={() => selectTab(t.id)}>
        {t.label} <span class="badge">{t.count}</span>
      </button>
    {/each}
  </div>

  <div class="body" role="tabpanel">
    {#if model.activeTab === 'duplicates'}
      <Duplicates data={{ sets, pending, locked }} onChange={refresh} />
    {/if}
  </div>

  <footer>
    <button type="button" onclick={() => openOptions('#/history')}>↶ Recently closed ({model.header.recentCount})</button>
    <button type="button" onclick={() => openOptions('#/rules')}>⚙ Rules</button>
  </footer>
</main>

<style>
  :global(:root) {
    --bg: #fff; --surface: #f6f6f8; --hover: #eef0f4; --border: #d4d7de; --text: #1c1e24; --muted: #6a6f7b;
    --accent: #3b6df0; --danger: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #1b1d22; --surface: #25282f; --hover: #2b2f37; --border: #3a3e48; --text: #e8eaef; --muted: #9aa0ad;
      --accent: #7a9bff; --danger: #ff8a80;
    }
  }
  :global(body) { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, sans-serif; }
  main { width: 380px; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 15px; margin: 0; flex: 1; }
  .total { color: var(--muted); }
  .chip { border: 1px solid var(--border); background: var(--hover); color: var(--muted); border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .pause { position: relative; }
  .menu { position: absolute; right: 0; top: 100%; z-index: 1; display: flex; flex-direction: column; min-width: 130px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px; }
  .menu button { text-align: left; border: 0; background: none; padding: 5px 8px; border-radius: 4px; }
  .menu button:hover { background: var(--hover); }
  button { font: inherit; color: inherit; cursor: pointer; }
  header > .pause > button, header > .lock, footer button { border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 3px 8px; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); }
  .tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; }
  .tabs button[aria-selected='true'] { border-bottom-color: var(--accent); }
  .tabs .faded { opacity: 0.35; }
  .badge { background: var(--hover); border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .body { max-height: 400px; overflow-y: auto; }
  footer { display: flex; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--border); }
  .error { color: var(--danger); margin: 6px 12px; font-size: 12px; }
  .warn { color: var(--danger); margin: 6px 12px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
