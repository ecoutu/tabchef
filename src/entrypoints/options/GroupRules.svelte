<script lang="ts">
  import type { Config, DedupeMode, GroupColor, GroupRule, TabSnap } from '../../core/types';
  import type { Rule } from '../../core/lang/types';
  import {
    actionPaths, addRule, configPatternErrors, errorsForPath, formRule, orderedUserRules, patternError, previewMatches, removeRule,
    reorderRules, ruleIndex, updateRule,
  } from '../../ui/rules-model';
  import LinesField from './LinesField.svelte';
  import { send } from '../../ui/send';
  import { previewCounts } from '../../core/lang/preview';

  let { config, tabs, dirty, saving, serverErrors, onChange, onSave }: {
    config: Config; tabs: TabSnap[]; dirty: boolean; saving: boolean; serverErrors: string[];
    onChange: (c: Config) => void; onSave: () => void;
  } = $props();

  const COLORS: GroupColor[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const hasErrors = $derived(configPatternErrors(config).length > 0);
  let dragFrom = $state<number | null>(null);
  const shown = $derived(orderedUserRules(config).map((rule) => ({ rule, form: formRule(rule) })));

  const lines = (r: GroupRule): string[] => (Array.isArray(r.match.url) ? r.match.url : r.match.url === '' ? [] : [r.match.url]);
  const toUrl = (l: string[]): string | string[] => (l.length > 1 ? l : (l[0] ?? ''));
  const count = (r: GroupRule): string => {
    const n = previewMatches(r, tabs).length;
    return `Matches ${n} open ${n === 1 ? 'tab' : 'tabs'}`;
  };
  /**
   * "Test against my open tabs" (M2 T13): the rule alone against the open tabs, via preview.change {only}. A result is
   * shown while the rule is unchanged since the test (`rule` is its JSON then). The YAML editor gets the same in T15.
   */
  let tested = $state<Record<string, { rule: string; text: string }>>({});
  async function test(r: Rule): Promise<void> {
    const rule = JSON.stringify(r);
    const res = await send({ type: 'preview.change', config: $state.snapshot(config), only: `user/${r.id}` });
    const n = res.ok ? previewCounts(res.data) : undefined;
    tested[r.id] = { rule, text: n ? `${n.moves} tabs would move · ${n.closes} would close` : `Could not test: ${res.ok ? '' : res.error}` };
  }
  const testText = (r: Rule): string | undefined => (tested[r.id]?.rule === JSON.stringify(r) ? tested[r.id]!.text : undefined);
  const patch = (id: string, p: Partial<GroupRule>): void => onChange(updateRule(config, id, p));
  const move = (from: number, to: number): void => onChange(reorderRules(config, from, to));
  /** Server errors for a form field: `sub` is an M1 field path (name, match/url, group/title, group/color, dedupe). */
  const sErr = (r: Rule, sub: string): string[] => {
    const p = actionPaths(r);
    const path = sub === 'dedupe' ? p.dedupe : sub.startsWith('group/') ? `${p.group}/${sub.slice(6)}` : sub;
    return errorsForPath(serverErrors, `/rules/${ruleIndex(config, r.id)}/${path}`);
  };
</script>

<section>
  <p class="help">Order is priority and tab-bar order: the first rule that matches a tab wins, and groups appear in the tab bar in this order. Drag the handle or use Move up / Move down.</p>

  {#each shown as { rule: v2, form }, i (v2.id)}
    {@const r = form ?? { id: v2.id, name: v2.name, enabled: v2.enabled, match: { url: '' }, group: { title: '', color: 'grey' } } as GroupRule}
    <div class="rule" class:dragging={dragFrom === i} role="group" aria-label={`Rule ${i + 1}: ${r.name}`}
      ondragover={(e) => { if (dragFrom !== null) e.preventDefault(); }}
      ondrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); dragFrom = null; }}>
      <div class="bar">
        <span class="handle" role="img" aria-label="Drag to reorder" title="Drag to reorder" draggable="true"
          ondragstart={(e) => { dragFrom = i; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); } }}
          ondragend={() => (dragFrom = null)}>⠿</span>
        {#if form}
          <label class="inline"><input type="checkbox" checked={r.enabled} onchange={(e) => patch(r.id, { enabled: e.currentTarget.checked })} /> Enabled</label>
          <input class="name" aria-label="Rule name" value={r.name} oninput={(e) => patch(r.id, { name: e.currentTarget.value })} />
          <span class="count">{count(r)}</span>
          <button type="button" onclick={() => test(v2)}>Test against my open tabs</button>
          {#if testText(v2)}<span class="count" role="status">{testText(v2)}</span>{/if}
        {:else}
          <span class="name">{v2.name}</span><span class="count">{v2.enabled ? 'Enabled' : 'Disabled'}</span>
        {/if}
        <button type="button" aria-label="Move up" disabled={i === 0} onclick={() => move(i, i - 1)}>↑</button>
        <button type="button" aria-label="Move down" disabled={i === shown.length - 1} onclick={() => move(i, i + 1)}>↓</button>
        <button type="button" class="danger" onclick={() => onChange(removeRule(config, r.id))}>Delete</button>
      </div>
      {#if !form}
        <p class="help">This rule uses features this form cannot edit yet; it is shown read-only.</p>
        <pre class="readonly">{JSON.stringify(v2, null, 2)}</pre>
        {#each errorsForPath(serverErrors, `/rules/${ruleIndex(config, v2.id)}`) as m (m)}<p class="err" role="alert">{m}</p>{/each}
      {:else}
      {#each sErr(v2, 'name') as m (m)}<p class="err" role="alert">name {m}</p>{/each}

      <LinesField label="URL patterns (one per line: glob, /regex/, or :param)" value={lines(r)} rows={2}
        check={patternError} onChange={(l) => patch(r.id, { match: { ...r.match, url: toUrl(l) } })} extraErrors={sErr(v2, 'match/url')} />

      <div class="grid">
        <label>Group title template
          <input value={r.group.title} oninput={(e) => patch(r.id, { group: { ...r.group, title: e.currentTarget.value } })} />
        </label>
        {#each sErr(v2, 'group/title') as m (m)}<p class="err" role="alert">title {m}</p>{/each}
        <label>Color
          <select value={r.group.color} onchange={(e) => patch(r.id, { group: { ...r.group, color: e.currentTarget.value as GroupColor } })}>
            {#each COLORS as c (c)}<option value={c}>{c}</option>{/each}
          </select>
        </label>
        {#each sErr(v2, 'group/color') as m (m)}<p class="err" role="alert">color {m}</p>{/each}
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
      {#each sErr(v2, 'dedupe') as m (m)}<p class="err" role="alert">dedupe {m}</p>{/each}
      <div class="checks">
        <label class="inline"><input type="checkbox" checked={r.group.collapsed ?? false} onchange={(e) => patch(r.id, { group: { ...r.group, collapsed: e.currentTarget.checked } })} /> Collapsed</label>
        <label class="inline"><input type="checkbox" checked={r.strict ?? true} onchange={(e) => patch(r.id, { strict: e.currentTarget.checked })} /> Strict (ungroup when URL stops matching)</label>
        <label class="inline"><input type="checkbox" checked={r.merge ?? false} onchange={(e) => patch(r.id, { merge: e.currentTarget.checked })} /> Merge across windows</label>
      </div>
      {/if}
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
  .readonly { margin: 0; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); }
</style>
