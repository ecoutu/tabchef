<script lang="ts">
  import type { Config, DedupeMode, DedupeSettings } from '../../core/types';
  import { configPatternErrors, errorsForPath, patternError, patternHints } from '../../ui/rules-model';
  import LinesField from './LinesField.svelte';
  import Permissions from './Permissions.svelte';

  let { config, dirty, saving, serverErrors, onChange, onSave }: {
    config: Config; dirty: boolean; saving: boolean; serverErrors: string[];
    onChange: (c: Config) => void; onSave: () => void;
  } = $props();

  const d = $derived(config.dedupe);
  const hasErrors = $derived(configPatternErrors(config).length > 0);
  const patch = (p: Partial<DedupeSettings>): void => onChange({ ...config, dedupe: { ...config.dedupe, ...p } });
  const sErr = (field: string): string[] => errorsForPath(serverErrors, `/dedupe/${field}`);

  // Per-site overrides (T18): one row per entry, a URL pattern plus a two-way choice. `on` is keepFragment / matchTitle.
  type OvField = 'fragmentOverrides' | 'titleOverrides';
  const rows = (f: OvField): { pattern: string; on: boolean }[] =>
    f === 'fragmentOverrides' ? d.fragmentOverrides.map((e) => ({ pattern: e.pattern, on: e.keepFragment })) : d.titleOverrides.map((e) => ({ pattern: e.pattern, on: e.matchTitle }));
  const setRows = (f: OvField, r: { pattern: string; on: boolean }[]): void =>
    patch(f === 'fragmentOverrides' ? { fragmentOverrides: r.map((x) => ({ pattern: x.pattern, keepFragment: x.on })) } : { titleOverrides: r.map((x) => ({ pattern: x.pattern, matchTitle: x.on })) });
  const editRow = (f: OvField, i: number, p: Partial<{ pattern: string; on: boolean }>): void => setRows(f, rows(f).map((x, j) => (j === i ? { ...x, ...p } : x)));
  const rowError = (p: string): string | undefined => (p === '' ? 'must not be empty' : patternError(p));
</script>

{#snippet overrides(f: OvField, noun: string, label: string, onLabel: string, offLabel: string)}
  <fieldset class="ov">
    <legend>{label}</legend>
    {#each rows(f) as r, i (i)}
      {@const n = i + 1}
      <div class="ov-row">
        <input aria-label={`${noun} ${n} pattern`} value={r.pattern} placeholder="e.g. app.example.com/*"
          oninput={(e) => editRow(f, i, { pattern: e.currentTarget.value.trim() })} />
        <select aria-label={`${noun} ${n} action`} value={r.on ? onLabel : offLabel}
          onchange={(e) => editRow(f, i, { on: e.currentTarget.value === onLabel })}>
          <option value={onLabel}>{onLabel}</option><option value={offLabel}>{offLabel}</option>
        </select>
        <button type="button" aria-label={`Remove ${noun.toLowerCase()} ${n}`} onclick={() => setRows(f, rows(f).filter((_, j) => j !== i))}>Remove</button>
      </div>
      {#if rowError(r.pattern)}<p class="err" role="alert">{r.pattern || `${noun} ${n}`}: {rowError(r.pattern)}</p>{/if}
      {#each patternHints(r.pattern) as h (h)}<p class="hint" role="note">{r.pattern}: {h}</p>{/each}
    {/each}
    <button type="button" onclick={() => setRows(f, [...rows(f), { pattern: '', on: true }])}>Add {noun.toLowerCase()}</button>
    {#each sErr(f) as m (m)}<p class="err" role="alert">{m}</p>{/each}
  </fieldset>
{/snippet}

<section>
  <p class="help">Duplicates are detected by a normalized URL. The new tab is always the one that closes; the existing tab is kept and focused.</p>

  <div class="grid">
    <label>Mode
      <select value={d.mode} onchange={(e) => patch({ mode: e.currentTarget.value as DedupeMode })}>
        <option value="always-switch">always-switch</option><option value="ask">ask</option><option value="off">off</option>
      </select>
    </label>
    {#each sErr('mode') as m (m)}<p class="err" role="alert">mode {m}</p>{/each}
    <label>Scope
      <select value={d.scope} onchange={(e) => patch({ scope: e.currentTarget.value as DedupeSettings['scope'] })}>
        <option value="all-windows">all windows</option><option value="same-window">same window</option>
      </select>
    </label>
    {#each sErr('scope') as m (m)}<p class="err" role="alert">scope {m}</p>{/each}
  </div>

  <div class="checks">
    <label class="inline"><input type="checkbox" checked={d.stripFragment} onchange={(e) => patch({ stripFragment: e.currentTarget.checked })} /> Ignore #fragment</label>
    <label class="inline"><input type="checkbox" checked={d.ignoreTrailingSlash} onchange={(e) => patch({ ignoreTrailingSlash: e.currentTarget.checked })} /> Ignore trailing slash</label>
    <label class="inline"><input type="checkbox" checked={d.followFragment} onchange={(e) => patch({ followFragment: e.currentTarget.checked })} /> Kept tab follows the new #fragment</label>
    <label class="inline"><input type="checkbox" checked={d.includeIncognito} onchange={(e) => patch({ includeIncognito: e.currentTarget.checked })} /> Include incognito windows</label>
    <label class="inline"><input type="checkbox" checked={d.matchTitle} onchange={(e) => patch({ matchTitle: e.currentTarget.checked })} /> Duplicates must also have the same page title</label>
  </div>
  {#each ['stripFragment', 'ignoreTrailingSlash', 'followFragment', 'includeIncognito', 'matchTitle'].flatMap(sErr) as m (m)}<p class="err" role="alert">{m}</p>{/each}

  {@render overrides('fragmentOverrides', 'Fragment override', 'Per-site #fragment handling (first matching pattern wins over "Ignore #fragment"; a rule\'s own dedupe setting wins over both)', 'keep', 'strip')}
  {@render overrides('titleOverrides', 'Title override', 'Per-site title matching (first matching pattern wins over rules and the setting above)', 'compare', 'ignore')}

  <LinesField label="Strip query parameters (comma or newline separated; * wildcard)" value={d.stripParams} commas
    onChange={(v) => patch({ stripParams: v })} extraErrors={sErr('stripParams')} />
  <LinesField label="Allow duplicates for these URL patterns (one per line)" value={d.allowDuplicates} check={patternError}
    onChange={(v) => patch({ allowDuplicates: v })} extraErrors={sErr('allowDuplicates')} />
  <LinesField label="Always switch for these sites in ask mode (one pattern per line)" value={d.alwaysSwitchSites} check={patternError}
    onChange={(v) => patch({ alwaysSwitchSites: v })} extraErrors={sErr('alwaysSwitchSites')} />

  <div class="readonly">
    <h3>Not editable here</h3>
    <p>Canonicalizers: {d.canonicalizers.length ? d.canonicalizers.join(', ') : 'none'}</p>
    <p>URL transforms: {d.urlTransforms.length ? `${d.urlTransforms.length} (${d.urlTransforms.map((t) => `${t.pattern} → ${t.replacement}`).join('; ')})` : 'none'}</p>
    <p class="help">Edit these via JSON import (Backups page).</p>
  </div>

  <div class="actions">
    <button type="button" class="primary" disabled={!dirty || saving || hasErrors} onclick={onSave}>Save</button>
    {#if hasErrors}<span class="err">Fix pattern errors to save.</span>{/if}
  </div>

  <Permissions />
</section>

<style>
  section { display: flex; flex-direction: column; gap: 10px; max-width: 640px; }
  .help { color: var(--muted); margin: 0; }
  .grid { display: flex; gap: 12px; flex-wrap: wrap; }
  .grid label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  .checks { display: flex; flex-direction: column; gap: 4px; }
  .inline { display: inline-flex; align-items: center; gap: 6px; }
  .readonly { border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; }
  .readonly h3 { margin: 0 0 4px; font-size: 13px; }
  .readonly p { margin: 2px 0; }
  .actions { display: flex; gap: 8px; align-items: center; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
  .hint { color: var(--muted); font-size: 12px; margin: 2px 0 0; }
  .ov { border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; }
  .ov legend { font-size: 12px; color: var(--muted); }
  .ov-row { display: flex; gap: 6px; align-items: center; }
  .ov-row input { flex: 1; min-width: 0; font: 12px/1.4 ui-monospace, monospace; }
  .ov > button { align-self: flex-start; }
</style>
