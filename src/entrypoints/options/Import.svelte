<script lang="ts">
  import { send } from '../../ui/send';
  import type { ImportPreview, ImportSource } from '../../engine/messages';

  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const UNSAVED = 'You have unsaved changes on this page; they will be discarded.';

  /** `dirty` = the options page holds unsaved edits (an applied import reloads them away). */
  let { dirty, onApplied }: { dirty: boolean; onApplied: () => void } = $props();
  const warn = (text: string): string => (dirty ? `${text}\n\n${UNSAVED}` : text);

  let source = $state<ImportSource>('auto-group-tabs');
  let pasted = $state('');
  let data = $state<unknown>(undefined);
  let preview = $state<ImportPreview | null>(null);
  let rev = $state('');
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);

  function reset(): void { preview = null; data = undefined; error = ''; notice = ''; }

  async function load(text: string): Promise<void> {
    reset();
    if (new Blob([text]).size > MAX_IMPORT_BYTES) { error = 'Input too large (max 5 MB).'; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { error = 'Not valid JSON.'; return; }
    busy = true;
    const [p, c] = await Promise.all([send({ type: 'import.preview', source, data: parsed }), send({ type: 'config.get' })]);
    busy = false;
    if (!p.ok) { error = p.error; return; }
    if (!c.ok) { error = c.error; return; }
    data = parsed; rev = c.data.rev; preview = p.data;
  }

  async function pickFile(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { reset(); error = 'File too large (max 5 MB).'; return; }
    await load(await file.text());
  }

  const dedupeKeys = $derived(preview ? Object.keys(preview.dedupe) : []);
  const nothing = $derived(preview !== null && preview.rules.length === 0 && dedupeKeys.length === 0);

  async function apply(): Promise<void> {
    if (!preview) return;
    const what = `${preview.rules.length} ${preview.rules.length === 1 ? 'rule' : 'rules'}${dedupeKeys.length ? ` and ${dedupeKeys.length} duplicate ${dedupeKeys.length === 1 ? 'setting' : 'settings'}` : ''}`;
    const changes = preview.changes;
    const body = changes.length
      ? `Add ${what}? Imported rules go after your existing rules. These duplicate settings change:\n- ${changes.join('\n- ')}\nYour current config is backed up first.`
      : `Add ${what}? Imported rules go after your existing rules; nothing is overwritten. Your current config is backed up first.`;
    if (!window.confirm(warn(body))) return;
    const r = await send({ type: 'import.apply', source, data, baseRev: rev });
    if (r.ok) { notice = `Imported ${r.data.rules} ${r.data.rules === 1 ? 'rule' : 'rules'}.`; preview = null; data = undefined; pasted = ''; error = ''; onApplied(); }
    else if (r.error === 'conflict') error = 'Settings changed elsewhere. Choose the file again to re-preview.';
    else error = r.errors?.length ? `${r.error}: ${r.errors.join('; ')}` : r.error;
  }
</script>

<section>
  <h2>Import from another extension</h2>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok" role="status">{notice}</p>{/if}

  <label>Source
    <select bind:value={source} onchange={reset}>
      <option value="auto-group-tabs">Auto-Group Tabs</option>
      <option value="tab-deduper">Tab Deduper</option>
    </select>
  </label>
  <p class="hint">
    Paste or choose the extension's storage dump: <code>{'{"sync": {...}, "local": {...}}'}</code>
    (from its service-worker console: <code>chrome.storage.sync.get(null)</code> and <code>chrome.storage.local.get(null)</code>).
    Auto-Group Tabs' compressed rule list is decoded for you.
  </p>
  {#if source === 'tab-deduper'}
    <p class="hint">Tab Deduper never closed tabs automatically; Tabchef defaults to switching to the existing tab (always-switch). You can choose ask or off under Dedupe.</p>
  {/if}

  <div class="row">
    <label class="file">Choose file <input type="file" accept="application/json,.json" onchange={pickFile} /></label>
  </div>
  <label class="paste">Or paste JSON
    <textarea rows="5" bind:value={pasted} spellcheck="false"></textarea>
  </label>
  <div class="row">
    <button type="button" disabled={busy || pasted.trim() === ''} onclick={() => load(pasted)}>Preview</button>
  </div>

  {#if preview}
    {#if preview.warnings.length}
      <div class="warn" role="status"><strong>Warnings</strong>
        <ul>{#each preview.warnings as w, i (i)}<li>{w}</li>{/each}</ul>
      </div>
    {/if}
    {#if preview.rules.length}
      <table>
        <thead><tr><th>#</th><th>Title</th><th>Color</th><th>Patterns</th><th>Strict</th><th>Merge</th></tr></thead>
        <tbody>
          {#each preview.rules as r, i (r.id)}
            <tr>
              <td>{i + 1}</td><td>{r.group.title}</td><td>{r.group.color}</td>
              <td class="pat">{[r.match.url].flat().join(', ')}</td>
              <td>{r.strict ? 'yes' : 'no'}</td><td>{r.merge ? 'yes' : 'no'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if preview.changes.length}
      <p>Duplicate settings that will change:</p>
      <ul>{#each preview.changes as c, i (i)}<li>{c}</li>{/each}</ul>
    {/if}
    <div class="row">
      <button type="button" class="primary" disabled={nothing} onclick={apply}>Apply import</button>
      <button type="button" onclick={reset}>Cancel</button>
    </div>
  {/if}
</section>

<style>
  h2 { font-size: 15px; margin: 8px 0; }
  .hint { color: var(--muted); max-width: 640px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  .paste { display: block; }
  textarea { display: block; width: 100%; box-sizing: border-box; font-family: monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { text-align: left; border-bottom: 1px solid var(--border); padding: 4px 6px; vertical-align: top; }
  .pat { word-break: break-all; font-family: monospace; font-size: 12px; }
  .warn { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 6px 10px; margin: 8px 0; }
  .err { color: var(--danger); }
  .ok { color: var(--accent); }
</style>
