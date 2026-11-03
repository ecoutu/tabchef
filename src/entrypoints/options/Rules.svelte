<script lang="ts">
  // The Rules page (M2 T15, formerly GroupRules): user rules and the rules of enabled recipes in one priority order
  // (`order`), reordered by drag or Move up / Move down across both. A user rule is edited in the form (RuleFields)
  // or as YAML (RuleYaml), toggled per rule; one the form cannot show is a read-only summary with "Edit in YAML".
  // Recipe rules are locked rows: reorder, turn on/off (RecipeRef.ruleEnabled overrides, R56; saved through Save),
  // test and Customize (copy into a user rule), never edit. Consecutive rules of one recipe sit under one collapsible
  // header (collapsed while it holds 2+ rules); a rule that can never match (an empty URL list param) says so.
  import { tick } from 'svelte';
  import type { Config, TabSnap } from '../../core/types';
  import type { Rule } from '../../core/lang/types';
  import {
    addRule, configPatternErrors, customizeRule, customizedCopy, errorsForPath, inactiveReason, patchRuleForm, recipeRuns, removeRule, reorder,
    replaceRule, ruleForm, ruleIndex, ruleRows, ruleSummary, setRecipeRuleOn, type RecipeRun, type RuleForm, type RuleRow,
  } from '../../ui/rules-model';
  import { withRecipe } from '../../ui/recipes-model';
  import { builtinRecipes } from '../../recipes/load';
  import { send } from '../../ui/send';
  import { previewCounts } from '../../core/lang/preview';
  import { shadowText } from '../../core/lang/explain';
  import type { ShadowedRule } from '../../engine/messages';
  import RuleFields from './RuleFields.svelte';
  import RuleYaml from './RuleYaml.svelte';
  import Field from './Field.svelte';

  let { config, tabs, dirty, saving, serverErrors, onChange, onSave }: {
    config: Config; tabs: TabSnap[]; dirty: boolean; saving: boolean; serverErrors: string[];
    onChange: (c: Config) => void; onSave: () => void;
  } = $props();

  const builtins = builtinRecipes();
  const rows = $derived(ruleRows(config, builtins));
  const runs = $derived(recipeRuns(rows));
  /**
   * Recipes whose runs the user expanded, by recipe id: every run (fragment) of a recipe shares one state, so a
   * reorder or Customize that splits or re-heads a run keeps it open. A run of one rule is always shown.
   */
  let openRuns = $state<Record<string, boolean>>({});
  const membersOf = (run: RecipeRun): RuleRow[] => rows.slice(run.start, run.start + run.keys.length);
  /** A member has a param error or a shadowed ("Likely") warning: the run is shown open, so it is not hidden. */
  const runNeedsAttention = (run: RecipeRun): boolean => membersOf(run).some((r) => (r.kind === 'recipe' && r.error !== undefined) || shadowOf(r.key) !== undefined);
  const runOpen = (run: RecipeRun): boolean => run.keys.length < 2 || openRuns[run.recipeId] === true || runNeedsAttention(run);
  /** The header text of a run: its recipe, how many rules, how many on, how many can never match or have errors. */
  function runSummary(run: RecipeRun): string {
    const members = membersOf(run).filter((r) => r.kind === 'recipe');
    const on = members.filter((r) => r.on).length;
    const inactive = members.filter((r) => r.on && inactiveReason(r.rule)).length;
    const errors = members.filter((r) => r.error !== undefined).length;
    return `🔒 ${members[0]?.recipeName ?? run.recipeId} · ${members.length} rules · ${on} on${inactive ? ` · ${inactive} inactive` : ''}${errors ? ` · ${errors} with errors` : ''}`;
  }
  /** "Rule N" labels count only the rows shown, so a collapsed run leaves no gap in the numbering. */
  const shownNumber = $derived.by(() => {
    const out: Record<string, number> = {};
    let n = 0;
    rows.forEach((r, i) => { const run = runs.get(i); if (!run || runOpen(run)) out[r.key] = ++n; });
    return out;
  });
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
  /** Scrolls the rule row `key` into view and focuses its name field (or the row itself when it has none). */
  function focusRule(key: string): void {
    const el = document.querySelector<HTMLElement>(`.rule[data-key="${CSS.escape(key)}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center' });
    (el.querySelector<HTMLElement>('input.name') ?? el).focus();
  }
  /** Customize (one copy per recipe rule), then take the user to the new copy. */
  async function customize(key: string): Promise<void> {
    onChange(customizeRule(config, key, builtins));
    await tick();
    const copy = customizedCopy(config, key, builtins);
    if (copy) focusRule(`user/${copy.id}`);
  }
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
    // A recipe rule is tested as if on: its recipe enabled and the rule turned on (R56 override when off).
    const cfg = row.kind === 'recipe' ? setRecipeRuleOn(withRecipe(draft, row.recipeId, { enabled: true }, builtins), row.key, true, builtins) : draft;
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
    {@const run = runs.get(i)}
    {#if run && run.start === i && run.keys.length > 1}
      <div class="run">
        <button type="button" class="run-toggle" aria-expanded={runOpen(run)} disabled={runNeedsAttention(run)}
          title={runNeedsAttention(run) ? 'Kept open while a rule here has an error or warning' : undefined}
          onclick={() => (openRuns[run.recipeId] = !runOpen(run))}>
          <span aria-hidden="true">{runOpen(run) ? '▾' : '▸'}</span> {runSummary(run)}
        </button>
        <a href="#/recipes">Recipe settings</a>
      </div>
    {/if}
    {#if !run || runOpen(run)}
    <div class="rule" data-key={row.key} tabindex="-1" class:dragging={dragFrom === row.key} class:locked={row.kind === 'recipe'} role="group" aria-label={`Rule ${shownNumber[row.key]}: ${row.rule.name}`}
      ondragover={(e) => { if (dragFrom !== null) e.preventDefault(); }}
      ondrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); dragFrom = null; }}>
      <div class="bar">
        <span class="handle" role="img" aria-label="Drag to reorder" title="Drag to reorder" draggable="true"
          ondragstart={(e) => { dragFrom = row.key; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.key); } }}
          ondragend={() => (dragFrom = null)}>⠿</span>
        {#if row.kind === 'user'}
          <Field label="Enabled" inline help="Off: the rule is kept but does nothing until you turn it back on. Saved with Save.">
            <input type="checkbox" checked={row.rule.enabled} onchange={(e) => setEnabled(row.rule, e.currentTarget.checked)} />
          </Field>
          {#if form && !asYaml}
            <input class="name" aria-label="Rule name" value={form.name} oninput={(e) => patch(row.rule.id, { name: e.currentTarget.value })} />
          {:else}
            <span class="name">{row.rule.name}</span>
          {/if}
        {:else}
          <span class="chip" title="Recipe rules can be moved, turned on or off, tested and customized, not edited">🔒 Locked · {row.recipeName}</span>
          <Field label="On" helpLabel="On (this recipe rule)" inline help="Turn this recipe rule on or off without turning off its recipe. Saved with Save.">
            <input type="checkbox" checked={row.on} onchange={(e) => onChange(setRecipeRuleOn(config, row.key, e.currentTarget.checked, builtins))} />
          </Field>
          <span class="name">{row.rule.name}</span>
          {#if inactiveReason(row.rule)}
            <span class="chip inactive" title="This rule can never match until its recipe settings give it patterns">Inactive · {inactiveReason(row.rule)}</span>
            <a href="#/recipes">Add them in Recipes</a>
          {/if}
        {/if}
        <button type="button" class="test" onclick={() => test(row)}>Test against my open tabs</button>
        {#if testText(row)}<span class="count" role="status">{testText(row)}</span>{/if}
        {#if row.kind === 'user'}
          {#if asYaml}
            {#if form}<button type="button" onclick={() => showForm(row.rule.id)}>Form</button>{/if}
          {:else}
            <button type="button" onclick={() => (yaml[row.rule.id] = true)}>{form ? 'YAML' : 'Edit in YAML'}</button>
          {/if}
        {:else}
          {@const copy = customizedCopy(config, row.key, builtins)}
          {#if copy}
            <button type="button" class="customize" title="This rule already has a customized copy: go to it" onclick={() => focusRule(`user/${copy.id}`)}>Edit copy</button>
          {:else}
            <button type="button" class="customize" disabled={row.error !== undefined} onclick={() => customize(row.key)}>Customize</button>
          {/if}
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
    {/if}
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
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
  .warn { color: var(--muted); font-size: 12px; margin: 0; }
  .chip { display: inline-block; border: 1px solid var(--border); background: var(--hover); border-radius: 8px; padding: 0 6px; font-size: 11px; }
  .empty { color: var(--muted); }
  .run { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; font-size: 13px; }
  .run-toggle { background: none; border: 1px dashed var(--border); border-radius: 8px; padding: 6px 10px; color: var(--text); cursor: pointer; text-align: left; flex: 1; }
  .run-toggle:hover:not(:disabled) { background: var(--hover); }
  .run-toggle:disabled { cursor: default; }
  .run a, .bar a { font-size: 12px; }
  .chip.inactive { color: var(--muted); border-style: dashed; }
  .summary { margin: 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
</style>
