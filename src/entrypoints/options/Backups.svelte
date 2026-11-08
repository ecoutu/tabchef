<script lang="ts">
  import { onMount } from 'svelte';
  import { send } from '../../ui/send';
  import { repairConfig, validateConfig } from '../../core/config/schema';
  import { fillConfigDefaults, migrateConfig } from '../../core/config/migrate';
  import type { Config, ConfigV1 } from '../../core/types';
  import type { Backup } from '../../storage/config-store';
  import type { PreviewResult } from '../../core/lang/preview';
  import type { ProjectImportResult } from '../../core/projects/types';
  import { previewThenApply } from '../../ui/preview-flow';
  import PreviewDialog from './PreviewDialog.svelte';

  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const UNSAVED = 'You have unsaved changes on this page; they will be discarded.';

  /** `saved` is the stored config (export and import diff use it); `dirty` = the page holds unsaved edits. */
  let { saved, dirty, onApplied }: { saved: Config; dirty: boolean; onApplied: () => void } = $props();
  const warn = (text: string): string => (dirty ? `${text}\n\n${UNSAVED}` : text);

  let backups = $state<Backup[]>([]);
  let error = $state('');
  let notice = $state('');
  /** `projects`: the backup file's project list and its dry-run result (unset for a config-only file). */
  let pendingImport = $state<{ config: Config; changes: number; warnings: string[]; projects?: { raw: unknown[]; preview: ProjectImportResult } } | null>(null);
  /** The user chose to overwrite the stored projects the file also has (`skipped` by the dry run). */
  let overwrite = $state(false);

  const time = (at: number): string => new Date(at).toLocaleString();

  /** The open preview dialog (M1/R68: a restore or import with real effects is confirmed in it first, as Save is). */
  let dialog = $state<{ result: PreviewResult; answer: (apply: boolean) => void } | null>(null);
  const confirmPreview = (result: PreviewResult): Promise<boolean> => new Promise((resolve) => {
    dialog = { result, answer: (ok) => { dialog = null; resolve(ok); } };
  });

  /** The stored-config load path (as ConfigStore runs it): migrate, fill defaults, repair, validate. */
  function loadConfig(raw: unknown): { ok: true; config: Config; warnings: string[] } | { ok: false; error: string } {
    const m = migrateConfig(raw);
    if (!m.ok) return { ok: false, error: `Invalid config: ${m.errors.join('; ')}` };
    const repaired = repairConfig(fillConfigDefaults(m.config));
    const v = validateConfig(repaired.config);
    return v.ok ? { ok: true, config: v.config, warnings: repaired.warnings } : { ok: false, error: `Invalid config: ${v.errors.join('; ')}` };
  }

  async function load(): Promise<void> {
    const r = await send({ type: 'config.backups' });
    if (r.ok) backups = r.data.slice().sort((a, b) => b.at - a.at); else error = r.error;
  }

  async function restore(b: Backup): Promise<void> {
    if (!window.confirm(warn(`Restore the config from ${time(b.at)}? Your current config is backed up first.`))) return;
    // Preview the backup as the store will load it (M1/R68); a backup that does not load is reported by the restore.
    const loaded = loadConfig(b.config);
    error = '';
    const restoreIt = () => send({ type: 'config.restore', at: b.at });
    let r: Awaited<ReturnType<typeof restoreIt>>;
    if (loaded.ok) {
      const out = await previewThenApply(loaded.config, confirmPreview, restoreIt);
      if (out.status === 'cancelled') return;
      if (out.status === 'failed') { error = `Could not preview: ${out.error}`; return; }
      r = out.value;
    } else r = await restoreIt();
    error = r.ok ? '' : r.error;
    if (r.ok) {
      // The store repairs a backup as it loads one (repairConfig); show what that changed.
      const st = await send({ type: 'config.status' });
      const w = st.ok ? st.data?.warning : undefined;
      notice = `Restored ${time(b.at)}.${w ? ` ${w}` : ''}`;
      onApplied();
    }
    await load();
  }

  /**
   * The backup file: the config and the stored projects (`projects.export`). A config-only file (exported before
   * projects were included) still imports: pickFile reads both shapes. The config is not inlined at the top level, as
   * the config schema refuses unknown keys.
   */
  const BACKUP = 'backup';
  async function exportJson(): Promise<void> {
    error = '';
    const r = await send({ type: 'projects.export' });
    if (!r.ok) { error = `Could not export projects: ${r.error}`; return; }
    const file = { tabchef: BACKUP, version: 1, config: saved, projects: r.data };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tabchef-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  const ruleCount = (c: ConfigV1 | Config): number => (c.version === 1 ? c.groupRules : c.rules)?.length ?? 0;

  /** Rough change count: rules added/removed/changed plus whether dedupe settings changed. */
  function diffCount(a: Config, b: Config): number {
    const byId = new Map(a.rules.map((r) => [r.id, JSON.stringify(r)]));
    let n = 0;
    for (const r of b.rules) if (byId.get(r.id) !== JSON.stringify(r)) n++;
    const bIds = new Set(b.rules.map((r) => r.id));
    for (const id of byId.keys()) if (!bIds.has(id)) n++;
    // A pure reorder counts once; added/removed rules already account for their order keys.
    if (n === 0 && JSON.stringify(a.order) !== JSON.stringify(b.order)) n++;
    if (JSON.stringify(a.dedupe) !== JSON.stringify(b.dedupe)) n++;
    if (JSON.stringify([a.recipes, a.tables, a.dryRun]) !== JSON.stringify([b.recipes, b.tables, b.dryRun])) n++;
    return n;
  }

  async function pickFile(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = e.currentTarget.files?.[0];
    pendingImport = null; notice = ''; error = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { error = 'File too large (max 5 MB).'; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); } catch { error = 'Not valid JSON.'; return; }
    // A backup file wraps the config with the projects; any other file is a config (as exported before projects were).
    let rawConfig = parsed;
    let rawProjects: unknown[] | undefined;
    if (typeof parsed === 'object' && parsed !== null && (parsed as { tabchef?: unknown }).tabchef === BACKUP) {
      const b = parsed as { version?: unknown; config?: unknown; projects?: unknown };
      if (b.version !== 1) { error = `Unsupported backup version: ${JSON.stringify(b.version)}`; return; }
      if (!Array.isArray(b.projects)) { error = 'Invalid backup: projects must be a list'; return; }
      rawConfig = b.config;
      rawProjects = b.projects;
    }
    // Same load path as stored configs (an exported M1 file is migrated first): fill defaults, repair (disable/remove
    // what older versions allowed), validate.
    const v = loadConfig(rawConfig);
    if (!v.ok) { error = v.error; return; }
    let projects: { raw: unknown[]; preview: ProjectImportResult } | undefined;
    if (rawProjects) {
      // What the merge would do as things are stored now: new, already stored (asked), malformed (dropped).
      const r = await send({ type: 'projects.import', projects: rawProjects, overwrite: [], dryRun: true });
      if (!r.ok) { error = `Could not read the backup's projects: ${r.error}`; return; }
      projects = { raw: rawProjects, preview: r.data };
    }
    overwrite = false;
    pendingImport = { config: v.config, changes: diffCount(saved, v.config), warnings: v.warnings, ...(projects && { projects }) };
  }

  const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
  const titles = (ps: { title: string }[]): string => ps.map((p) => p.title).join(', ');

  /** The import confirmation: the config change and, for a backup file, what happens to the projects. */
  function importQuestion(p: NonNullable<typeof pendingImport>): string {
    const replace = `Replace your current config with the imported one (${p.changes} changes)`;
    if (!p.projects) return warn(`${replace}?`);
    const { added, skipped } = p.projects.preview;
    const lines = [
      p.changes > 0 ? `${replace}.` : 'Your config is unchanged.',
      `Add ${plural(added.length, 'new project')}.`,
      ...(skipped.length === 0 ? [] : overwrite
        ? [`Overwrite ${plural(skipped.length, 'project you already have', 'projects you already have')}: ${titles(skipped)}.`]
        : [`Leave ${plural(skipped.length, 'project you already have', 'projects you already have')} as ${skipped.length === 1 ? 'it is' : 'they are'}: ${titles(skipped)}.`]),
    ];
    const text = `Import this backup?\n\n${lines.join('\n')}`;
    return p.changes > 0 ? warn(text) : text;
  }

  async function applyImport(): Promise<void> {
    const p = pendingImport;
    if (!p) return;
    if (!window.confirm(importQuestion(p))) return;
    error = '';
    // A backup whose config is unchanged imports its projects alone: no config write, and the page keeps its edits.
    const setConfig = !p.projects || p.changes > 0;
    if (setConfig) {
      const config = p.config;
      const out = await previewThenApply(config, confirmPreview, () => send({ type: 'config.set', config }));
      if (out.status === 'cancelled') return;
      if (out.status === 'failed') { error = `Could not preview: ${out.error}`; return; }
      const r = out.value;
      if (!r.ok) { error = r.errors?.length ? `${r.error}: ${r.errors.join('; ')}` : r.error; return; }
    }
    let summary = '';
    if (p.projects) {
      const ids = overwrite ? p.projects.preview.skipped.map((x) => x.id) : [];
      const r = await send({ type: 'projects.import', projects: p.projects.raw, overwrite: ids });
      if (!r.ok) {
        error = setConfig ? `Config imported, but the projects were not: ${r.error}` : `Could not import the projects: ${r.error}`;
        pendingImport = null;
        if (setConfig) { onApplied(); await load(); }
        return;
      }
      const { added, overwritten, skipped } = r.data;
      summary = ` Projects: ${plural(added.length, 'project')} added, ${overwritten.length} overwritten, ${skipped.length} skipped.`;
    }
    notice = `Imported.${summary}`;
    pendingImport = null;
    error = '';
    if (setConfig) { onApplied(); await load(); }
  }

  onMount(load);
</script>

<section>
  {#if dialog}
    <PreviewDialog result={dialog.result} onApply={() => dialog?.answer(true)} onCancel={() => dialog?.answer(false)} />
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok" role="status">{notice}</p>{/if}

  <h2>Export / import</h2>
  <div class="row">
    <button type="button" onclick={exportJson}>Export config and projects as JSON</button>
    <label class="file">Import JSON <input type="file" accept="application/json,.json" onchange={pickFile} /></label>
  </div>
  <p class="help">
    The file holds your config and your stored projects, with their saved tab lists. Importing it replaces your config
    and adds its projects: a project you already have is overwritten only if you choose to, and none is deleted.
    Imported projects are kept, so the Projects page lists them as Saved (or Archived). Config-only files from older versions
    still import.
  </p>
  {#if pendingImport}
    <p>This import changes {pendingImport.changes} {pendingImport.changes === 1 ? 'item' : 'items'} compared with your current config.</p>
    {#each pendingImport.warnings as w (w)}<p class="warn" role="status">{w}</p>{/each}
    {#if pendingImport.projects}
      {@const pr = pendingImport.projects.preview}
      <p>Projects: {plural(pr.added.length, 'new project')}{pr.added.length ? ` (${titles(pr.added)})` : ''}.</p>
      {#if pr.skipped.length}
        <p>You already have {plural(pr.skipped.length, 'project')} of this file: {titles(pr.skipped)}. They stay as they are unless you overwrite them.</p>
        <label class="check"><input type="checkbox" bind:checked={overwrite} />
          Overwrite the {plural(pr.skipped.length, 'project you already have', 'projects you already have')} with the imported {pr.skipped.length === 1 ? 'copy' : 'copies'}</label>
      {/if}
      {#if pr.dropped.length}
        <p class="warn" role="status">{plural(pr.dropped.length, 'malformed project')} left out: {pr.dropped.join(', ')}</p>
      {/if}
    {/if}
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
        <span>{time(b.at)} · {ruleCount(b.config)} rules{b.config.version === 1 ? ' (v1, upgraded on restore)' : ''}</span>
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
  .help { color: var(--muted); max-width: 560px; }
  .check { display: flex; gap: 6px; align-items: center; }
  .err { color: var(--danger); }
  .ok { color: var(--accent); }
  .warn { color: var(--danger); }
</style>
