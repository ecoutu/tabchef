<script lang="ts">
  import type { Config, DedupeMode, DedupeSettings } from '../../core/types';
  import { configPatternErrors, errorsForPath, patternError } from '../../ui/rules-model';
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
</script>

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
  </div>
  {#each ['stripFragment', 'ignoreTrailingSlash', 'followFragment', 'includeIncognito'].flatMap(sErr) as m (m)}<p class="err" role="alert">{m}</p>{/each}

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
</style>
