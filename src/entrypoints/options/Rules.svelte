<script lang="ts">
  // The Rules page (M2 T15, formerly GroupRules): user rules and the rules of enabled recipes in one priority order
  // (`order`), reordered by drag or Move up / Move down across both. A user rule is edited in the form (RuleFields)
  // or as YAML (RuleYaml), toggled per rule; one the form cannot show is a read-only summary with "Edit in YAML".
  // Recipe rules are locked rows: reorder, turn on/off (RecipeRef.disabledRules, R55; saved through the normal Save),
  // test and Customize (copy into a user rule), never edit.
  import type { Config, TabSnap } from '../../core/types';
  import type { Rule } from '../../core/lang/types';
  import {
    addRule, configPatternErrors, customizeRule, errorsForPath, patchRuleForm, removeRule, reorder, replaceRule, ruleForm, ruleIndex,
    ruleRows, ruleSummary, setRecipeRuleOn, type RuleForm, type RuleRow,
  } from '../../ui/rules-model';
  import { withRecipe } from '../../ui/recipes-model';
  import { builtinRecipes } from '../../recipes/load';
  import { send } from '../../ui/send';
  import { previewCounts } from '../../core/lang/preview';
  import { shadowText } from '../../core/lang/explain';
  import type { ShadowedRule } from '../../engine/messages';
  import RuleFields from './RuleFields.svelte';
  import RuleYaml from './RuleYaml.svelte';

  let { config, tabs, dirty, saving, serverErrors, onChange, onSave }: {
    config: Config; tabs: TabSnap[]; dirty: boolean; saving: boolean; serverErrors: string[];
    onChange: (c: Config) => void; onSave: () => void;
  } = $props();

  const builtins = builtinRecipes();
  const rows = $derived(ruleRows(config, builtins));
  const hasErrors = $derived(configPatternErrors(config).length > 0);
  let dragFrom = $state<string | null>(null);
  /** Rules shown as YAML (by id); every other user rule shows its form, or its summary when the form cannot. */
  let yaml = $state<Record<string, boolean>>({});
  /** Rule ids whose YAML text is invalid right now: Save waits for them. */
  let yamlInvalid = $state<Record<string, boolean>>({});
  const yamlBlocked = $derived(Object.values(yamlInvalid).some(Boolean));

  const move = (key: string, to: number): void => onChange(reorder(config, key, to, builtins));
  const patch = (id: string, p: Partial<RuleForm>): void => onChange(patchRuleForm(config, id, p));
  const setEnabled = (r: Rule, enabled: boolean): void => {
    const res = replaceRule(config, r.id, { ...r, enabled });
    if (res.ok) onChange(res.config);
  };
  function fromYaml(id: string, r: Rule): string | undefined {
    const res = replaceRule(config, id, r);
    if (!res.ok) return res.error;
    if (r.id !== id) { yaml[r.id] = true; delete yaml[id]; delete yamlInvalid[id]; }
    onChange(res.config);
    return undefined;
  }
  function showForm(id: string): void { delete yaml[id]; delete yamlInvalid[id]; }
  function remove(id: string): void { delete yaml[id]; delete yamlInvalid[id]; onChange(removeRule(config, id)); }

  /**
   * "Test against my open tabs" (M2 T13; YAML, read-only and recipe rows since T15, R53): the rule alone against the
   * open tabs, via preview.change {only}. `only` needs the rule's recipe enabled in the config sent. A result is
   * shown while the rule is unchanged since the test (`rule` is its JSON then).
   */
  let tested = $state<Record<string, { rule: string; text: string }>>({});
  async function test(row: RuleRow): Promise<void> {
    const rule = JSON.stringify(row.rule);
    const draft = $state.snapshot(config) as Config;
    // A recipe rule is tested as if on: its recipe enabled, the rule out of disabledRules (R55).
    const cfg = row.kind === 'recipe' ? setRecipeRuleOn(withRecipe(draft, row.recipeId, { enabled: true }), row.key, true) : draft;
    const res = await send({ type: 'preview.change', config: cfg, only: row.key });
    const n = res.ok ? previewCounts(res.data) : undefined;
    tested[row.key] = { rule, text: n ? `${n.moves} tabs would move · ${n.closes} would close` : `Could not test: ${res.ok ? '' : res.error}` };
  }
  const testText = (row: RuleRow): string | undefined => (tested[row.key]?.rule === JSON.stringify(row.rule) ? tested[row.key]!.text : undefined);

  /**
   * Shadowed-rule warnings (M2 T14, heuristic, "Likely"): rules.shadowed for the draft, re-asked on every edit. Only
   * the latest answer is kept; a failed request (e.g. an invalid draft) shows none.
   */
  let shadowed = $state<ShadowedRule[]>([]);
  let shadowSeq = 0;
  $effect(() => {
    const draft = $state.snapshot(config);
    const seq = ++shadowSeq;
    void (async () => {
      const res = await send({ type: 'rules.shadowed', config: draft });
      if (seq === shadowSeq) shadowed = res?.ok && Array.isArray(res.data) ? res.data : [];
    })();
  });
  const shadowOf = (key: string): ShadowedRule | undefined => shadowed.find((x) => x.key === key);
</script>

<section>
  <p class="help">Order is priority and tab-bar order: the first rule that matches a tab wins, and groups appear in the tab bar in this order. Drag the handle or use Move up / Move down. Recipe rules are locked: move them, turn them on or off, or Customize to edit a copy.</p>

  {#each rows as row, i (row.key)}
    {@const form = row.kind === 'user' ? ruleForm(row.rule) : null}
    {@const asYaml = row.kind === 'user' && (yaml[row.rule.id] ?? false)}
    <div class="rule" class:dragging={dragFrom === row.key} class:locked={row.kind === 'recipe'} role="group" aria-label={`Rule ${i + 1}: ${row.rule.name}`}
      ondragover={(e) => { if (dragFrom !== null) e.preventDefault(); }}
      ondrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); dragFrom = null; }}>
      <div class="bar">
        <span class="handle" role="img" aria-label="Drag to reorder" title="Drag to reorder" draggable="true"
          ondragstart={(e) => { dragFrom = row.key; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.key); } }}
          ondragend={() => (dragFrom = null)}>⠿</span>
        {#if row.kind === 'user'}
          <label class="inline"><input type="checkbox" checked={row.rule.enabled} onchange={(e) => setEnabled(row.rule, e.currentTarget.checked)} /> Enabled</label>
          {#if form && !asYaml}
            <input class="name" aria-label="Rule name" value={form.name} oninput={(e) => patch(row.rule.id, { name: e.currentTarget.value })} />
          {:else}
            <span class="name">{row.rule.name}</span>
          {/if}
        {:else}
          <span class="chip" title="Recipe rules can be moved, turned on or off, tested and customized, not edited">🔒 Locked · {row.recipeName}</span>
          <label class="inline" title={row.rule.enabled ? 'Turn this recipe rule on or off' : 'Off in its recipe; use Customize to run a copy'}>
            <input type="checkbox" checked={row.on} disabled={!row.rule.enabled} onchange={(e) => onChange(setRecipeRuleOn(config, row.key, e.currentTarget.checked))} /> On
          </label>
          <span class="name">{row.rule.name}</span>
        {/if}
        <button type="button" class="test" disabled={!row.rule.enabled && row.kind === 'recipe'} onclick={() => test(row)}>Test against my open tabs</button>
        {#if testText(row)}<span class="count" role="status">{testText(row)}</span>{/if}
        {#if row.kind === 'user'}
          {#if asYaml}
            {#if form}<button type="button" onclick={() => showForm(row.rule.id)}>Form</button>{/if}
          {:else}
            <button type="button" onclick={() => (yaml[row.rule.id] = true)}>{form ? 'YAML' : 'Edit in YAML'}</button>
          {/if}
        {:else}
          <button type="button" class="customize" disabled={row.error !== undefined} onclick={() => onChange(customizeRule(config, row.key, builtins))}>Customize</button>
        {/if}
        <button type="button" aria-label="Move up" disabled={i === 0} onclick={() => move(row.key, i - 1)}>↑</button>
        <button type="button" aria-label="Move down" disabled={i === rows.length - 1} onclick={() => move(row.key, i + 1)}>↓</button>
        {#if row.kind === 'user'}<button type="button" class="danger" onclick={() => remove(row.rule.id)}>Delete</button>{/if}
      </div>
      {#if shadowOf(row.key)}
        <p class="warn" role="note"><span class="chip">Likely</span> {shadowText(shadowOf(row.key)!.name)}</p>
      {/if}

      {#if row.kind === 'recipe'}
        {#if row.error}<p class="err" role="alert">{row.error}</p>{/if}
        <ul class="summary">{#each ruleSummary(row.rule) as l (l)}<li>{l}</li>{/each}</ul>
      {:else if asYaml}
        <RuleYaml rule={row.rule} onChange={(r) => fromYaml(row.rule.id, r)} onValidity={(ok) => (yamlInvalid[row.rule.id] = !ok)} />
        {#each errorsForPath(serverErrors, `/rules/${ruleIndex(config, row.rule.id)}`) as m (m)}<p class="err" role="alert">{m}</p>{/each}
      {:else if form}
        <RuleFields rule={row.rule} {form} index={ruleIndex(config, row.rule.id)} {tabs} {serverErrors} onPatch={(p) => patch(row.rule.id, p)} />
        {#each errorsForPath(serverErrors, `/rules/${ruleIndex(config, row.rule.id)}/name`) as m (m)}<p class="err" role="alert">name {m}</p>{/each}
      {:else}
        <ul class="summary">{#each ruleSummary(row.rule) as l (l)}<li>{l}</li>{/each}</ul>
        <p class="help">The form cannot show every part of this rule. Use "Edit in YAML" to change it.</p>
        {#each errorsForPath(serverErrors, `/rules/${ruleIndex(config, row.rule.id)}`) as m (m)}<p class="err" role="alert">{m}</p>{/each}
      {/if}
    </div>
  {:else}
    <p class="empty">No rules yet.</p>
  {/each}

  <div class="actions">
    <button type="button" onclick={() => onChange(addRule(config))}>Add rule</button>
    <button type="button" class="primary" disabled={!dirty || saving || hasErrors || yamlBlocked} onclick={onSave}>Save</button>
    {#if hasErrors}<span class="err">Fix pattern errors to save.</span>{/if}
    {#if yamlBlocked}<span class="err">Fix YAML errors to save.</span>{/if}
  </div>
</section>

<style>
  .help { color: var(--muted); margin: 0 0 12px; }
  .rule { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 10px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; }
  .rule.locked { background: var(--bg); border-style: dashed; }
  .rule.dragging { opacity: 0.5; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .handle { cursor: grab; user-select: none; font-size: 18px; color: var(--muted); }
  .name { flex: 1; min-width: 140px; }
  .count { color: var(--muted); font-size: 12px; }
  .inline { display: inline-flex; align-items: center; gap: 4px; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
  .warn { color: var(--muted); font-size: 12px; margin: 0; }
  .chip { display: inline-block; border: 1px solid var(--border); background: var(--hover); border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .empty { color: var(--muted); }
  .summary { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
</style>
