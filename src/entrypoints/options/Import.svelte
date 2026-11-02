<script lang="ts">
  import { send } from '../../ui/send';
  import type { ImportPreview, ImportSource } from '../../engine/messages';
  import type { Rule } from '../../core/lang/types';
  import type { PreviewResult } from '../../core/lang/preview';
  import { previewThenApply } from '../../ui/preview-flow';
  import PreviewDialog from './PreviewDialog.svelte';

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
  /** Collapse suggestions (M2 T19) by index: 'use' sends it with import.apply, 'keep' hides the card. Never automatic. */
  let choice = $state<Record<number, 'use' | 'keep'>>({});

  /** The open preview dialog (M1/R68: an import with real effects is confirmed in it first, as Save is). */
  let dialog = $state<{ result: PreviewResult; answer: (apply: boolean) => void } | null>(null);
  const confirmPreview = (result: PreviewResult): Promise<boolean> => new Promise((resolve) => {
    dialog = { result, answer: (ok) => { dialog = null; resolve(ok); } };
  });

  function reset(): void { preview = null; data = undefined; error = ''; notice = ''; choice = {}; }

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
  const suggestions = $derived(preview?.collapse ?? []);
  const chosen = $derived(suggestions.flatMap((_, i) => (choice[i] === 'use' ? [i] : [])));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const groupOf = (r: Rule) => r.actions.flatMap((a) => ('group' in a ? [a.group] : []))[0];

  async function apply(): Promise<void> {
    if (!preview) return;
    const count = preview.rules.length - chosen.reduce((n, i) => n + (suggestions[i]?.replaces.length ?? 0) - 1, 0);
    const what = `${plural(count, 'rule', 'rules')}${dedupeKeys.length ? ` and ${dedupeKeys.length} duplicate ${dedupeKeys.length === 1 ? 'setting' : 'settings'}` : ''}`;
    const changes = preview.changes;
    const collapsed = chosen.map((i) => `1 templated rule replaces ${suggestions[i]?.replaces.length ?? 0} similar rules.`).join(' ');
    const body = (collapsed ? `${collapsed}\n` : '') + (changes.length
      ? `Add ${what}? Imported rules go after your existing rules. These duplicate settings change:\n- ${changes.join('\n- ')}\nYour current config is backed up first.`
      : `Add ${what}? Imported rules go after your existing rules; nothing is overwritten. Your current config is backed up first.`);
    if (!window.confirm(warn(body))) return;
    const collapse = chosen.length > 0 ? { collapse: chosen } : {};
    // The config import.apply would store (server-derived, same collapse), previewed like a Save (M1/R68).
    error = '';
    const next = await send({ type: 'import.preview', source, data, ...collapse });
    if (!next.ok) { error = `Could not preview: ${next.error}`; return; }
    const out = await previewThenApply(next.data.config, confirmPreview, () => send({ type: 'import.apply', source, data, baseRev: rev, ...collapse }));
    if (out.status === 'cancelled') return;
    if (out.status === 'failed') { error = `Could not preview: ${out.error}`; return; }
    const r = out.value;
    if (r.ok) { notice = `Imported ${r.data.rules} ${r.data.rules === 1 ? 'rule' : 'rules'}.`; preview = null; data = undefined; pasted = ''; error = ''; onApplied(); }
    else if (r.error === 'conflict') error = 'Settings changed elsewhere. Choose the file again to re-preview.';
    else error = r.errors?.length ? `${r.error}: ${r.errors.join('; ')}` : r.error;
  }
</script>

<section>
  {#if dialog}
    <PreviewDialog result={dialog.result} onApply={() => dialog?.answer(true)} onCancel={() => dialog?.answer(false)} />
  {/if}
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
    <p class="hint">Tab Deduper never closed tabs automatically; Tabchef defaults to switching to the existing tab (always-switch). You can choose ask or off on the Duplicates page.</p>
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
    {#each suggestions as s, i (s.rule.id)}
      {#if choice[i] !== 'keep'}
        {@const g = groupOf(s.rule)}
        <div class="card" role="group" aria-label="Collapse suggestion">
          {#if choice[i] === 'use'}
            <p><strong>Will replace {plural(s.replaces.length, 'rule', 'rules')} with 1 templated rule.</strong></p>
          {:else}
            <p><strong>Replace {s.replaces.length} similar rules with 1 templated rule?</strong></p>
          {/if}
          <dl>
            <dt>Pattern</dt><dd class="pat">{[s.rule.match && 'url' in s.rule.match ? s.rule.match.url : []].flat().join(', ')}</dd>
            <dt>Title</dt><dd class="pat">{g?.title}</dd>
            <dt>Color</dt><dd class="pat">{g?.color}</dd>
            <dt>Table {s.table.name}</dt>
            <dd class="pat">{Object.entries(s.table.entries).map(([k, v]) => `${k}: ${v}`).join(', ')}</dd>
          </dl>
          {#if s.notes.length}
            <p class="hint">Unchanged by this rule (it keeps the original order):</p>
            <ul>{#each s.notes as n, j (j)}<li>{n}</li>{/each}</ul>
          {/if}
          <div class="row">
            {#if choice[i] !== 'use'}<button type="button" onclick={() => (choice = { ...choice, [i]: 'use' })}>Use templated rule</button>{/if}
            <button type="button" onclick={() => (choice = { ...choice, [i]: 'keep' })}>Keep as is</button>
          </div>
        </div>
      {/if}
    {/each}
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
  .card { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 6px 10px; margin: 8px 0; }
  .card dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 4px 0; }
  .card dd { margin: 0; }
  .err { color: var(--danger); }
  .ok { color: var(--accent); }
</style>
