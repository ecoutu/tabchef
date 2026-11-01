<script lang="ts">
  import type { Config, DedupeMode, GroupColor, GroupRule, TabSnap } from '../../core/types';
  import { addRule, configPatternErrors, errorsForPath, patternError, previewMatches, removeRule, reorderRules, updateRule } from '../../ui/rules-model';
  import LinesField from './LinesField.svelte';

  let { config, tabs, dirty, saving, serverErrors, onChange, onSave }: {
    config: Config; tabs: TabSnap[]; dirty: boolean; saving: boolean; serverErrors: string[];
    onChange: (c: Config) => void; onSave: () => void;
  } = $props();

  const COLORS: GroupColor[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const hasErrors = $derived(configPatternErrors(config).length > 0);
  let dragFrom = $state<number | null>(null);

  const lines = (r: GroupRule): string[] => (Array.isArray(r.match.url) ? r.match.url : r.match.url === '' ? [] : [r.match.url]);
  const toUrl = (l: string[]): string | string[] => (l.length > 1 ? l : (l[0] ?? ''));
  const count = (r: GroupRule): string => {
    const n = previewMatches(r, tabs).length;
    return `Matches ${n} open ${n === 1 ? 'tab' : 'tabs'}`;
  };
  const patch = (id: string, p: Partial<GroupRule>): void => onChange(updateRule(config, id, p));
  const move = (from: number, to: number): void => onChange(reorderRules(config, from, to));
  const sErr = (i: number, sub: string): string[] => errorsForPath(serverErrors, `/groupRules/${i}/${sub}`);
</script>

<section>
  <p class="help">Order is priority and tab-bar order: the first rule that matches a tab wins, and groups appear in the tab bar in this order. Drag the handle or use Move up / Move down.</p>

  {#each config.groupRules as r, i (r.id)}
    <div class="rule" class:dragging={dragFrom === i} role="group" aria-label={`Rule ${i + 1}: ${r.name}`}
      ondragover={(e) => { if (dragFrom !== null) e.preventDefault(); }}
      ondrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); dragFrom = null; }}>
      <div class="bar">
        <span class="handle" role="img" aria-label="Drag to reorder" title="Drag to reorder" draggable="true"
          ondragstart={(e) => { dragFrom = i; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); } }}
          ondragend={() => (dragFrom = null)}>⠿</span>
        <label class="inline"><input type="checkbox" checked={r.enabled} onchange={(e) => patch(r.id, { enabled: e.currentTarget.checked })} /> Enabled</label>
        <input class="name" aria-label="Rule name" value={r.name} oninput={(e) => patch(r.id, { name: e.currentTarget.value })} />
        <span class="count">{count(r)}</span>
        <button type="button" aria-label="Move up" disabled={i === 0} onclick={() => move(i, i - 1)}>↑</button>
        <button type="button" aria-label="Move down" disabled={i === config.groupRules.length - 1} onclick={() => move(i, i + 1)}>↓</button>
        <button type="button" class="danger" onclick={() => onChange(removeRule(config, r.id))}>Delete</button>
      </div>
      {#each sErr(i, 'name') as m (m)}<p class="err" role="alert">name {m}</p>{/each}

      <LinesField label="URL patterns (one per line: glob, /regex/, or :param)" value={lines(r)} rows={2}
        check={patternError} onChange={(l) => patch(r.id, { match: { ...r.match, url: toUrl(l) } })} extraErrors={sErr(i, 'match/url')} />

      <div class="grid">
        <label>Group title template
          <input value={r.group.title} oninput={(e) => patch(r.id, { group: { ...r.group, title: e.currentTarget.value } })} />
        </label>
        {#each sErr(i, 'group/title') as m (m)}<p class="err" role="alert">title {m}</p>{/each}
        <label>Color
          <select value={r.group.color} onchange={(e) => patch(r.id, { group: { ...r.group, color: e.currentTarget.value as GroupColor } })}>
            {#each COLORS as c (c)}<option value={c}>{c}</option>{/each}
          </select>
        </label>
        {#each sErr(i, 'group/color') as m (m)}<p class="err" role="alert">color {m}</p>{/each}
        <label>Group order
          <select value={r.sortGroups ?? 'creation'} onchange={(e) => patch(r.id, { sortGroups: e.currentTarget.value as 'creation' | 'alphabetical' })}>
            <option value="creation">creation</option><option value="alphabetical">alphabetical</option>
          </select>
        </label>
        <label>Dedupe override
          <select value={r.dedupe ?? ''} onchange={(e) => { const v = e.currentTarget.value; patch(r.id, { dedupe: v === '' ? undefined : (v as DedupeMode) }); }}>
            <option value="">inherit global</option><option value="always-switch">always-switch</option><option value="ask">ask</option><option value="off">off</option>
          </select>
        </label>
      </div>
      {#each sErr(i, 'dedupe') as m (m)}<p class="err" role="alert">dedupe {m}</p>{/each}
      <div class="checks">
        <label class="inline"><input type="checkbox" checked={r.group.collapsed ?? false} onchange={(e) => patch(r.id, { group: { ...r.group, collapsed: e.currentTarget.checked } })} /> Collapsed</label>
        <label class="inline"><input type="checkbox" checked={r.strict ?? true} onchange={(e) => patch(r.id, { strict: e.currentTarget.checked })} /> Strict (ungroup when URL stops matching)</label>
        <label class="inline"><input type="checkbox" checked={r.merge ?? false} onchange={(e) => patch(r.id, { merge: e.currentTarget.checked })} /> Merge across windows</label>
      </div>
    </div>
  {:else}
    <p class="empty">No group rules yet.</p>
  {/each}

  <div class="actions">
    <button type="button" onclick={() => onChange(addRule(config))}>Add rule</button>
    <button type="button" class="primary" disabled={!dirty || saving || hasErrors} onclick={onSave}>Save</button>
    {#if hasErrors}<span class="err">Fix pattern errors to save.</span>{/if}
  </div>
</section>

<style>
  .help { color: var(--muted); margin: 0 0 12px; }
  .rule { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 10px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; }
  .rule.dragging { opacity: 0.5; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .handle { cursor: grab; user-select: none; font-size: 18px; color: var(--muted); }
  .name { flex: 1; min-width: 140px; }
  .count { color: var(--muted); font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
  .grid label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  .checks { display: flex; gap: 14px; flex-wrap: wrap; }
  .inline { display: inline-flex; align-items: center; gap: 4px; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
  .empty { color: var(--muted); }
</style>
