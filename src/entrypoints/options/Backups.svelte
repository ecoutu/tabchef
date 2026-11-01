<script lang="ts">
  import { onMount } from 'svelte';
  import { send } from '../../ui/send';
  import { validateConfig } from '../../core/config/schema';
  import type { Config } from '../../core/types';
  import type { Backup } from '../../storage/config-store';

  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const UNSAVED = 'You have unsaved changes on this page; they will be discarded.';

  /** `saved` is the stored config (export and import diff use it); `dirty` = the page holds unsaved edits. */
  let { saved, dirty, onApplied }: { saved: Config; dirty: boolean; onApplied: () => void } = $props();
  const warn = (text: string): string => (dirty ? `${text}\n\n${UNSAVED}` : text);

  let backups = $state<Backup[]>([]);
  let error = $state('');
  let notice = $state('');
  let pendingImport = $state<{ config: Config; changes: number } | null>(null);

  const time = (at: number): string => new Date(at).toLocaleString();

  async function load(): Promise<void> {
    const r = await send({ type: 'config.backups' });
    if (r.ok) backups = r.data.slice().sort((a, b) => b.at - a.at); else error = r.error;
  }

  async function restore(b: Backup): Promise<void> {
    if (!window.confirm(warn(`Restore the config from ${time(b.at)}? Your current config is backed up first.`))) return;
    const r = await send({ type: 'config.restore', at: b.at });
    error = r.ok ? '' : r.error;
    if (r.ok) { notice = `Restored ${time(b.at)}.`; onApplied(); }
    await load();
  }

  function exportJson(): void {
    const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tabchef-config.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Rough change count: rules added/removed/changed plus whether dedupe settings changed. */
  function diffCount(a: Config, b: Config): number {
    const byId = new Map(a.groupRules.map((r) => [r.id, JSON.stringify(r)]));
    let n = 0;
    for (const r of b.groupRules) if (byId.get(r.id) !== JSON.stringify(r)) n++;
    const bIds = new Set(b.groupRules.map((r) => r.id));
    for (const id of byId.keys()) if (!bIds.has(id)) n++;
    if (JSON.stringify(a.dedupe) !== JSON.stringify(b.dedupe)) n++;
    return n;
  }

  async function pickFile(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = e.currentTarget.files?.[0];
    pendingImport = null; notice = ''; error = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { error = 'File too large (max 5 MB).'; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); } catch { error = 'Not valid JSON.'; return; }
    const v = validateConfig(parsed);
    if (!v.ok) { error = `Invalid config: ${v.errors.join('; ')}`; return; }
    pendingImport = { config: v.config, changes: diffCount(saved, v.config) };
  }

  async function applyImport(): Promise<void> {
    if (!pendingImport) return;
    if (!window.confirm(warn(`Replace your current config with the imported one (${pendingImport.changes} changes)?`))) return;
    const r = await send({ type: 'config.set', config: pendingImport.config });
    if (r.ok) { notice = 'Imported.'; pendingImport = null; error = ''; onApplied(); await load(); }
    else error = r.errors?.length ? `${r.error}: ${r.errors.join('; ')}` : r.error;
  }

  onMount(load);
</script>

<section>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok" role="status">{notice}</p>{/if}

  <h2>Export / import</h2>
  <div class="row">
    <button type="button" onclick={exportJson}>Export current config as JSON</button>
    <label class="file">Import JSON <input type="file" accept="application/json,.json" onchange={pickFile} /></label>
  </div>
  {#if pendingImport}
    <p>This import changes {pendingImport.changes} {pendingImport.changes === 1 ? 'item' : 'items'} compared with your current config.</p>
    <div class="row">
      <button type="button" class="primary" onclick={applyImport}>Apply import</button>
      <button type="button" onclick={() => (pendingImport = null)}>Cancel</button>
    </div>
  {/if}

  <h2>Backups</h2>
  {#if backups.length === 0}<p class="empty">No backups yet.</p>{/if}
  <ul>
    {#each backups as b (b.at)}
      <li>
        <span>{time(b.at)} · {b.config.groupRules.length} rules</span>
        <button type="button" aria-label={`Restore backup from ${time(b.at)}`} onclick={() => restore(b)}>Restore</button>
      </li>
    {/each}
  </ul>
</section>

<style>
  h2 { font-size: 15px; margin: 16px 0 6px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; max-width: 560px; }
  li { display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 6px 8px; }
  .empty { color: var(--muted); }
  .err { color: var(--danger); }
  .ok { color: var(--accent); }
</style>
