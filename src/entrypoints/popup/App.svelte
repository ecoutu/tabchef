<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { send } from '../../ui/send';
  import { buildPopupModel, parsePopupPrefs, POPUP_PREFS_KEY, type PopupPrefs } from '../../ui/popup-model';
  import type { ViewData, ViewSummary } from '../../engine/views';
  import { CLOSE_SUGGESTIONS_KEY } from '../../engine/close-executor';
  import type { PauseDuration } from '../../engine/safety';
  import Duplicates from './tabs/Duplicates.svelte';
  import ListView from './tabs/ListView.svelte';

  /** Recipe-declared views (M2 T17): one popup tab each, the rest under More ▾. */
  let views = $state<ViewSummary[]>([]);
  /** The open view's data, and which view it belongs to (a stale answer for another view is not shown). */
  let data = $state<{ viewId: string; data: ViewData } | undefined>(undefined);
  /** Tab order and visible count (R20): storage.local `popup.prefs`, defaults when missing or unreadable. */
  let prefs = $state<PopupPrefs>({});
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
  let moreOpen = $state(false);

  const model = $derived(buildPopupModel({ views, paused, recentCount, lastTab, ...prefs }));
  const activeView = $derived(views.find((v) => v.id === model.activeTab));
  const activeInMore = $derived(model.more.some((m) => m.id === model.activeTab));

  async function loadData(viewId: string): Promise<void> {
    if (!viewId) { data = undefined; return; }
    const r = await send({ type: 'view.data', viewId });
    if (r.ok) data = { viewId, data: r.data };
    else error = r.error;
  }

  async function refresh(): Promise<void> {
    const [v, s, r, c, g] = await Promise.all([
      send({ type: 'views.list' }), send({ type: 'safety.status' }), send({ type: 'recent.list' }), send({ type: 'config.status' }),
      send({ type: 'config.get' }),
    ]);
    const errs: string[] = [];
    if (v.ok) views = v.data; else errs.push(v.error);
    if (s.ok) { paused = s.data.paused; locked = s.data.locked ?? []; } else errs.push(s.error);
    if (r.ok) recentCount = r.data.length; else errs.push(r.error);
    if (c.ok) syncWarning = c.data?.warning ?? ''; else errs.push(c.error);
    if (g.ok) dryRun = g.data?.config.dryRun === true; else errs.push(g.error);
    error = errs[0] ?? '';
    await loadData(model.activeTab);
  }

  /** The Finished view reads CloseExecutor's persisted suggestions: refresh when they change (T9→T17). */
  const onStorage = (changes: Record<string, unknown>, area: string) => {
    if (area === 'session' && CLOSE_SUGGESTIONS_KEY in changes) void refresh();
  };

  onMount(async () => {
    browser.storage.onChanged.addListener(onStorage);
    try {
      const got = await browser.storage.local.get(['popup.lastTab', POPUP_PREFS_KEY]);
      const v = got['popup.lastTab'];
      if (typeof v === 'string') lastTab = v;
      prefs = parsePopupPrefs(got[POPUP_PREFS_KEY]);
    } catch { /* storage unavailable: default tab, order and visible count */ }
    try {
      currentTabId = (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    } catch { /* no current tab (e.g. devtools): no lock button */ }
    await refresh();
  });
  onDestroy(() => { browser.storage.onChanged.removeListener(onStorage); });

  async function selectTab(id: string): Promise<void> {
    lastTab = id;
    moreOpen = false;
    try { await browser.storage.local.set({ 'popup.lastTab': id }); } catch { /* best effort */ }
    await loadData(id);
  }

  /** Moves an overflow view into the last visible slot (it stays open); the order is stored in popup.prefs. */
  async function showInBar(id: string): Promise<void> {
    const visible = model.tabs.map((t) => t.id);
    const rest = [...visible.slice(-1), ...model.more.map((m) => m.id).filter((x) => x !== id)];
    prefs = { ...prefs, tabOrder: [...visible.slice(0, -1), id, ...rest] };
    try { await browser.storage.local.set({ [POPUP_PREFS_KEY]: $state.snapshot(prefs) }); } catch { /* best effort */ }
    await selectTab(id);
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

  <div class="tabs">
    <div class="tablist" role="tablist">
      {#each model.tabs as t (t.id)}
        <button type="button" role="tab" aria-selected={t.id === model.activeTab} class:faded={t.faded} title={t.paused ?? t.notice}
          onclick={() => selectTab(t.id)}>
          {t.label} <span class="badge">{t.count}</span>
        </button>
      {/each}
    </div>
    {#if model.more.length > 0}
      <div class="more">
        <button type="button" class="more-btn" class:active={activeInMore} aria-haspopup="menu" aria-expanded={moreOpen}
          onclick={() => (moreOpen = !moreOpen)}>More ▾</button>
        {#if moreOpen}
          <div class="menu" role="menu">
            {#each model.more as m (m.id)}
              <div class="more-item">
                <button type="button" role="menuitem" aria-current={m.id === model.activeTab} onclick={() => selectTab(m.id)}>
                  {m.label} <span class="badge">{m.count}</span>
                </button>
                <button type="button" role="menuitem" class="pin" aria-label={`Show ${m.label} in tab bar`} title="Show in tab bar"
                  onclick={() => showInBar(m.id)}>⇤</button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="body" role="tabpanel">
    {#if activeView && data?.viewId === activeView.id}
      {#if data.data.kind === 'duplicates'}
        <Duplicates data={{ sets: data.data.sets, pending: data.data.pending, locked }} onChange={refresh} />
      {:else}
        <ListView view={activeView} rows={data.data.rows} onChange={refresh} />
      {/if}
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
  .tablist { display: flex; flex: 1; min-width: 0; overflow: hidden; }
  .tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; white-space: nowrap; }
  .tabs button[aria-selected='true'], .tabs .more-btn.active { border-bottom-color: var(--accent); }
  .more { position: relative; }
  .more .menu { min-width: 180px; }
  .more-item { display: flex; }
  .more-item button[role='menuitem'] { flex: 1; border-bottom: 0; }
  .more-item .pin { flex: none; color: var(--muted); }
  .tabs .faded { opacity: 0.35; }
  .badge { background: var(--hover); border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .body { max-height: 400px; overflow-y: auto; }
  footer { display: flex; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--border); }
  .error { color: var(--danger); margin: 6px 12px; font-size: 12px; }
  .warn { color: var(--danger); margin: 6px 12px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
