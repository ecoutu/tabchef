<script lang="ts">
  import { onMount } from 'svelte';
  import type { Component } from 'svelte';
  import { browser } from 'wxt/browser';
  import { send } from '../../ui/send';
  import { isConfigChangedMessage } from '../../engine/messages';
  import { unclaimedErrors } from '../../ui/rules-model';
  import type { Config, TabSnap } from '../../core/types';
  import GroupRules from './GroupRules.svelte';
  import Dedupe from './Dedupe.svelte';
  import History from './History.svelte';
  import Backups from './Backups.svelte';
  import Import from './Import.svelte';
  import PreviewDialog from './PreviewDialog.svelte';
  import { previewThenApply } from '../../ui/preview-flow';
  import type { PreviewResult } from '../../core/lang/preview';

  /**
   * Route table. To add a page (e.g. '/import' in Task 17), add one entry here; the nav and hash routing pick it up.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ROUTES: { path: string; label: string; page: 'rules' | 'dedupe' | 'history' | 'backups' | 'import' | Component<any> }[] = [
    { path: '/rules', label: 'Group rules', page: 'rules' },
    { path: '/dedupe', label: 'Duplicates', page: 'dedupe' },
    { path: '/history', label: 'History', page: 'history' },
    { path: '/backups', label: 'Backups', page: 'backups' },
    { path: '/import', label: 'Import', page: 'import' },
    // ROUTE-INSERT-POINT
  ];

  const parseHash = (): string => {
    const h = window.location.hash.replace(/^#/, '');
    return ROUTES.some((r) => r.path === h) ? h : '/rules';
  };

  let route = $state(parseHash());
  let saved = $state<Config | null>(null);
  let draft = $state<Config | null>(null);
  let tabs = $state<TabSnap[]>([]);
  let loadError = $state('');
  let saveErrors = $state<string[]>([]);
  let saveMessage = $state('');
  let saving = $state(false);
  let baseRev = $state<string | undefined>(undefined);
  let conflict = $state(false);
  let syncWarning = $state('');
  /** "Could not preview: <error>": the change was not saved (T13 fix round 1). */
  let previewError = $state('');
  /** The open preview (M2 T13) and how to answer it (Apply → true, Cancel → false). */
  let preview = $state<{ result: PreviewResult; answer: (apply: boolean) => void } | null>(null);

  const dirty = $derived(saved !== null && draft !== null && JSON.stringify(saved) !== JSON.stringify(draft));
  const summary = $derived(unclaimedErrors(saveErrors));

  async function loadConfig(): Promise<void> {
    const r = await send({ type: 'config.get' });
    if (!r.ok) { loadError = r.error; return; }
    loadError = '';
    saved = r.data.config;
    baseRev = r.data.rev;
    draft = structuredClone($state.snapshot(r.data.config));
    saveErrors = [];
    conflict = false;
  }

  /** Keep my edits: adopt the stored config as the base so the next Save explicitly overwrites it. */
  async function keepMine(): Promise<void> {
    const r = await send({ type: 'config.get' });
    if (!r.ok) { loadError = r.error; return; }
    saved = r.data.config;
    baseRev = r.data.rev;
    conflict = false;
  }

  /** Sync problems (quota, failed writes, adopted remote settings) are shown, never silent. */
  async function loadStatus(): Promise<void> {
    const r = await send({ type: 'config.status' });
    if (r.ok) syncWarning = r.data?.warning ?? '';
  }

  async function loadTabs(): Promise<void> {
    const r = await send({ type: 'tabs.list' });
    if (r.ok) tabs = r.data;
  }

  const confirmPreview = (result: PreviewResult): Promise<boolean> => new Promise((resolve) => {
    preview = { result, answer: (apply) => { preview = null; resolve(apply); } };
  });

  /** Save → preview.change → [Apply] → config.set {baseRev}; a change with no effects saves straight away (R5, T13). */
  async function save(): Promise<void> {
    if (!draft) return;
    saving = true; saveErrors = []; saveMessage = ''; previewError = '';
    const toSave = structuredClone($state.snapshot(draft));
    // baseRev is read when Apply is clicked: a remote change meanwhile still conflicts.
    const out = await previewThenApply(toSave, confirmPreview,
      () => send({ type: 'config.set', config: toSave, ...(baseRev !== undefined ? { baseRev } : {}) }));
    // Cancelled, or the preview failed: nothing was saved and the edits stay.
    if (out.status !== 'applied') {
      saving = false;
      if (out.status === 'failed') previewError = `Could not preview: ${out.error}`;
      return;
    }
    const r = out.value;
    if (r.ok) {
      saved = toSave; saveMessage = 'Saved.';
      const g = await send({ type: 'config.get' });
      if (g.ok) baseRev = g.data.rev;
      saving = false;
      void loadStatus();
      return;
    }
    saving = false;
    if (r.error === 'conflict') { conflict = true; return; }
    saveErrors = r.errors?.length ? r.errors : [r.error];
  }

  function edit(c: Config): void { draft = c; saveMessage = ''; previewError = ''; }

  onMount(() => {
    void loadConfig();
    void loadTabs();
    void loadStatus();
    const onHash = (): void => { route = parseHash(); };
    const onUnload = (e: BeforeUnloadEvent): void => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    const onMsg = (m: unknown): void => {
      if (!isConfigChangedMessage(m)) return;
      void loadStatus();
      if (saving || m.rev === baseRev) return;
      if (dirty) conflict = true; else void loadConfig();
    };
    browser.runtime.onMessage.addListener(onMsg);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('beforeunload', onUnload);
    return () => { browser.runtime.onMessage.removeListener(onMsg); window.removeEventListener('hashchange', onHash); window.removeEventListener('beforeunload', onUnload); };
  });

  const current = $derived(ROUTES.find((r) => r.path === route)!);
</script>

<main>
  <header>
    <h1>Tabchef</h1>
    {#if dirty}<span class="dirty" role="status">Unsaved changes</span>{/if}
  </header>
  <nav aria-label="Sections">
    {#each ROUTES as r (r.path)}
      <a href={`#${r.path}`} aria-current={r.path === route ? 'page' : undefined}>{r.label}</a>
    {/each}
  </nav>

  {#if loadError}<p class="err" role="alert">{loadError}</p>{/if}
  {#if syncWarning}<div class="banner warn" role="alert" data-testid="sync-warning">{syncWarning}</div>{/if}
  {#if conflict}
    <div class="banner" role="alert">
      <span>Settings changed elsewhere.</span>
      <button type="button" onclick={loadConfig}>Reload (discard my edits)</button>
      <button type="button" onclick={keepMine}>Keep my edits</button>
    </div>
  {/if}
  {#if saveMessage}<p class="ok" role="status">{saveMessage}</p>{/if}
  {#if previewError}<p class="err" role="alert">{previewError}</p>{/if}
  {#if preview}
    <PreviewDialog result={preview.result} onApply={() => preview?.answer(true)} onCancel={() => preview?.answer(false)} />
  {/if}
  {#if summary.length}
    <div class="err" role="alert"><strong>Could not save:</strong>
      <ul>{#each summary as m (m)}<li>{m}</li>{/each}</ul>
    </div>
  {/if}

  <div class="page">
    {#if current.page === 'history'}
      <History />
    {:else if current.page === 'backups'}
      {#if saved}<Backups saved={saved!} {dirty} onApplied={loadConfig} />{/if}
    {:else if current.page === 'import'}
      {#if saved}<Import {dirty} onApplied={loadConfig} />{/if}
    {:else if draft && current.page === 'rules'}
      <GroupRules config={draft} {tabs} {dirty} {saving} serverErrors={saveErrors} onChange={edit} onSave={save} />
    {:else if draft && current.page === 'dedupe'}
      <Dedupe config={draft} {dirty} {saving} serverErrors={saveErrors} onChange={edit} onSave={save} />
    {:else if draft}
      {@const Page = current.page as Component<{ config: Config }>}
      <Page config={draft} />
    {/if}
  </div>
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
  :global(body) { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  :global(button), :global(input), :global(select), :global(textarea) { font: inherit; color: inherit; }
  :global(button) { cursor: pointer; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 3px 10px; }
  :global(button:hover:not(:disabled)) { background: var(--hover); }
  :global(button:disabled) { opacity: 0.5; cursor: not-allowed; }
  :global(button.primary) { background: var(--accent); border-color: var(--accent); color: #fff; }
  :global(button.danger) { color: var(--danger); }
  :global(input:not([type='checkbox']):not([type='file'])), :global(select) { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; }
  :global(button:focus-visible), :global(a:focus-visible), :global(input:focus-visible), :global(select:focus-visible), :global(textarea:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
  main { max-width: 860px; margin: 0 auto; padding: 16px; }
  header { display: flex; align-items: center; gap: 12px; }
  h1 { font-size: 20px; margin: 0; }
  .dirty { color: var(--accent); font-size: 12px; border: 1px solid var(--accent); border-radius: 10px; padding: 0 8px; }
  nav { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 12px 0; }
  nav a { padding: 8px 12px; color: var(--muted); text-decoration: none; border-bottom: 2px solid transparent; }
  nav a[aria-current='page'] { color: var(--text); border-bottom-color: var(--accent); }
  .banner { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border: 1px solid var(--accent); border-radius: 8px; padding: 6px 10px; margin-bottom: 8px; }
  .banner.warn { border-color: var(--danger); }
  .err { color: var(--danger); }
  .ok { color: var(--accent); }
</style>
