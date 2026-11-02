<script lang="ts">
  // Recipes page (M2 T15, route #/recipes): one card per recipe with its needs, its status and the status of each of
  // its rules (R45: "Paused: needs access to <host>" from recipes.list), and a params form generated from ParamDef.
  //
  // Every change previews first (spec §6.10, R52: the dialog opens only for real effects). Enable follows R5: the
  // click handler calls requestNeeds FIRST, synchronously (it needs the user gesture), then preview.change for the
  // config with the recipe enabled, then on Apply recipes.enable {id, params, baseRev}. Denied recipe-level needs stop
  // there; denied rule-level needs (Finished / Meet) still enable, and that rule shows paused.
  import { onMount } from 'svelte';
  import type { Config } from '../../core/types';
  import type { ParamDef } from '../../core/lang/types';
  import type { RecipeListItem } from '../../engine/messages';
  import type { NeedStatus } from '../../engine/permissions';
  import type { PreviewResult } from '../../core/lang/preview';
  import { send } from '../../ui/send';
  import { onPermissionsChanged, requestNeeds } from '../../ui/permissions';
  import { previewThenApply } from '../../ui/preview-flow';
  import { completeParams, hostParams, paramErrors, requestedNeeds, withRecipe } from '../../ui/recipes-model';
  import { recipeBody } from '../../ui/rules-model';
  import { builtinRecipes } from '../../recipes/load';
  import LinesField from './LinesField.svelte';
  import PreviewDialog from './PreviewDialog.svelte';

  /** `saved` / `baseRev`: the stored config and its rev (App). `dirty`: unsaved rule edits, which a recipe change would conflict with. */
  let { saved, baseRev, dirty, onApplied }: { saved: Config; baseRev?: string; dirty: boolean; onApplied: () => void } = $props();

  let items = $state<RecipeListItem[]>([]);
  let listRev = $state<string | undefined>(undefined);
  let loadError = $state('');
  /** Params form values per recipe: always the complete object (setParams / enable replace it whole, T8). */
  let values = $state<Record<string, Record<string, unknown>>>({});
  let messages = $state<Record<string, { text: string; error: boolean }>>({});
  let busy = $state<string | null>(null);
  let preview = $state<{ result: PreviewResult; answer: (apply: boolean) => void } | null>(null);

  const builtins = builtinRecipes();
  const bodyOf = (id: string) => {
    const ref = saved.recipes.find((r) => r.id === id);
    return ref ? recipeBody(ref, builtins) : undefined;
  };

  async function load(): Promise<void> {
    const r = await send({ type: 'recipes.list' });
    if (!r.ok) { loadError = r.error; return; }
    if (!Array.isArray(r.data?.recipes)) return;
    loadError = '';
    items = r.data.recipes;
    listRev = r.data.rev;
    values = Object.fromEntries(items.map((i) => [i.id, completeParams(i.paramDefs, i.params)]));
  }

  $effect(() => { void saved; void load(); });
  onMount(() => {
    try { return onPermissionsChanged(() => { void load(); }); } catch { return undefined; }
  });

  const hostOf = (p: string): string => /^[^:]+:\/\/([^/:]+)/.exec(p)?.[1] ?? p;
  function needsText(item: RecipeListItem): string {
    const n = requestedNeeds(item);
    const parts = [];
    if (n.origins.length) parts.push(`Needs access to ${n.origins.map(hostOf).join(', ')}`);
    const perms = n.permissions.filter((p) => p !== 'scripting' || n.origins.length === 0);
    if (perms.length) parts.push(`Needs the ${perms.join(', ')} permission`);
    return parts.join('. ');
  }
  const recipeStatus = (i: RecipeListItem): string => (!i.enabled ? 'Off' : i.status.ok ? 'On' : (i.status.reason ?? 'Paused'));
  function ruleStatus(i: RecipeListItem, ruleId: string, enabledInBody: boolean): string {
    const off = saved.recipes.find((r) => r.id === i.id)?.disabledRules ?? []; // turned off in #/rules (R55)
    if (!i.enabled || !enabledInBody || off.includes(ruleId)) return 'Off';
    if (!i.status.ok) return i.status.reason ?? 'Paused';
    const st = i.rules[`${i.id}/${ruleId}`]?.status;
    return st && !st.ok ? (st.reason ?? 'Paused') : 'Active';
  }
  const deniedText = (s: NeedStatus): string => `Not enabled: ${(s.reason ?? 'missing permissions').replace(/^Paused: /, '')} (permission denied).`;
  const errorsOf = (i: RecipeListItem): Record<string, string> => paramErrors(i.paramDefs, values[i.id] ?? {}, hostParams(bodyOf(i.id)));
  const blocked = (i: RecipeListItem): boolean => dirty || busy !== null || Object.keys(errorsOf(i)).length > 0;
  const rev = (): string | undefined => baseRev ?? listRev;
  const say = (id: string, text: string, error = false): void => { messages[id] = { text, error }; };

  const confirmPreview = (result: PreviewResult): Promise<boolean> => new Promise((resolve) => {
    preview = { result, answer: (apply) => { preview = null; resolve(apply); } };
  });

  /** preview.change for `config` → [Apply] → `apply`; then reload (App reloads its config through onApplied). */
  async function change(id: string, config: Config, apply: () => ReturnType<typeof send>, done: string): Promise<void> {
    const out = await previewThenApply(config, confirmPreview, apply);
    busy = null;
    if (out.status === 'cancelled') return;
    if (out.status === 'failed') { say(id, `Could not preview: ${out.error}`, true); return; }
    const r = out.value;
    if (r.ok) say(id, done);
    else if (r.error === 'conflict') say(id, 'Settings changed elsewhere. Reloaded; try again.', true);
    else { say(id, r.errors?.length ? `${r.error}: ${r.errors.join('; ')}` : r.error, true); return; }
    await load();
    onApplied();
  }

  /** Enable (R5). requestNeeds is the first statement: nothing may be awaited before it (user gesture). */
  function enable(item: RecipeListItem): void {
    const granted = requestNeeds(requestedNeeds(item));
    void finishEnable(item, granted);
  }

  async function finishEnable(item: RecipeListItem, granted: Promise<boolean>): Promise<void> {
    const id = item.id;
    busy = id;
    messages[id] = { text: '', error: false };
    const params = $state.snapshot(values[id] ?? {});
    const ok = await granted.catch(() => false);
    // Recipe-level needs gate the enable (R5); denied rule-level needs only pause their rule.
    if (!ok && !item.status.ok) { busy = null; say(id, deniedText(item.status), true); return; }
    const cfg = withRecipe($state.snapshot(saved), id, { enabled: true, params });
    const baseRev = rev();
    await change(id, cfg, () => send({ type: 'recipes.enable', id, params, ...(baseRev !== undefined && { baseRev }) }), 'Enabled.');
  }

  async function disable(item: RecipeListItem): Promise<void> {
    const id = item.id;
    busy = id;
    const baseRev = rev();
    await change(id, withRecipe($state.snapshot(saved), id, { enabled: false }),
      () => send({ type: 'recipes.disable', id, ...(baseRev !== undefined && { baseRev }) }), 'Disabled.');
  }

  async function saveParams(item: RecipeListItem): Promise<void> {
    const id = item.id;
    busy = id;
    const params = $state.snapshot(values[id] ?? {});
    const baseRev = rev();
    await change(id, withRecipe($state.snapshot(saved), id, { params }),
      () => send({ type: 'recipes.setParams', id, params, ...(baseRev !== undefined && { baseRev }) }), 'Saved.');
  }

  const set = (id: string, name: string, v: unknown): void => { values[id] = { ...values[id], [name]: v }; };
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const kind = (d: ParamDef): 'enum' | 'boolean' | 'number' | 'list' | 'text' =>
    (d.enum ? 'enum' : d.type === 'boolean' ? 'boolean' : d.type === 'number' ? 'number' : d.type === 'string[]' ? 'list' : 'text');
</script>

<section class="page">
  <p class="help">Recipes are ready-made rules. Enabling one shows what it would do to your open tabs first.</p>
  {#if loadError}<p class="err" role="alert">{loadError}</p>{/if}
  {#if dirty}<p class="warn" role="note">You have unsaved rule edits. Save or discard your rule edits first.</p>{/if}
  {#if preview}
    <PreviewDialog result={preview.result} onApply={() => preview?.answer(true)} onCancel={() => preview?.answer(false)} />
  {/if}

  {#each items as item (item.id)}
    {@const body = bodyOf(item.id)}
    {@const errs = errorsOf(item)}
    <section class="card" aria-label={item.name}>
      <div class="head">
        <h2>{item.name}</h2>
        <span class="status" class:paused={item.enabled && !item.status.ok}>{recipeStatus(item)}</span>
      </div>
      <p>{item.description}</p>
      {#if needsText(item)}<p class="needs">{needsText(item)}</p>{/if}
      {#if body?.rules.length}
        <ul class="rules">
          {#each body.rules as r (r.id)}
            <li data-rule={`${item.id}/${r.id}`}>{r.name}: <span class:paused={ruleStatus(item, r.id, r.enabled).startsWith('Paused')}>{ruleStatus(item, r.id, r.enabled)}</span></li>
          {/each}
        </ul>
      {/if}

      {#if Object.keys(item.paramDefs).length}
        <div class="params">
          {#each Object.entries(item.paramDefs) as [name, def] (name)}
            {@const v = values[item.id]?.[name]}
            {#if kind(def) === 'list'}
              <LinesField label={def.label} value={strList(v)} rows={3} onChange={(l) => set(item.id, name, l)} />
            {:else if kind(def) === 'enum'}
              <label>{def.label}
                <select value={String(v)} onchange={(e) => { const s = e.currentTarget.value; set(item.id, name, def.enum?.find((o) => String(o) === s)); }}>
                  {#each def.enum ?? [] as opt (String(opt))}<option value={String(opt)}>{String(opt)}</option>{/each}
                </select>
              </label>
            {:else if kind(def) === 'boolean'}
              <label class="inline"><input type="checkbox" checked={v === true} onchange={(e) => set(item.id, name, e.currentTarget.checked)} /> {def.label}</label>
            {:else if kind(def) === 'number'}
              <label>{def.label}<input type="number" value={typeof v === 'number' ? v : ''} oninput={(e) => set(item.id, name, e.currentTarget.valueAsNumber)} /></label>
            {:else}
              <label>{def.label}<input value={typeof v === 'string' ? v : ''} oninput={(e) => set(item.id, name, e.currentTarget.value)} /></label>
            {/if}
            {#if errs[name]}<p class="err" role="alert">{def.label}: {errs[name]}</p>{/if}
          {/each}
        </div>
      {/if}

      <div class="actions">
        {#if item.enabled}
          <button type="button" disabled={blocked(item)} onclick={() => saveParams(item)}>Save settings</button>
          <button type="button" disabled={dirty || busy !== null} onclick={() => disable(item)}>Disable</button>
        {:else}
          <button type="button" class="primary" disabled={blocked(item)} onclick={() => enable(item)}>Enable</button>
        {/if}
        {#if messages[item.id]?.text}
          <span class={messages[item.id]!.error ? 'err' : 'ok'} role={messages[item.id]!.error ? 'alert' : 'status'}>{messages[item.id]!.text}</span>
        {/if}
      </div>
    </section>
  {:else}
    {#if !loadError}<p class="muted">Loading recipes…</p>{/if}
  {/each}
</section>

<style>
  .help, .muted { color: var(--muted); margin: 0 0 12px; }
  .card { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px; }
  .card p { margin: 0; }
  .head { display: flex; align-items: center; gap: 10px; }
  h2 { font-size: 15px; margin: 0; flex: 1; }
  .status { font-size: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 0 8px; }
  .paused { color: var(--danger); }
  .needs { color: var(--muted); font-size: 12px; }
  .rules { margin: 0; padding-left: 18px; font-size: 13px; }
  .params { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
  .params label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  .params label.inline { flex-direction: row; align-items: center; gap: 4px; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .err { color: var(--danger); font-size: 12px; }
  .ok { color: var(--accent); font-size: 12px; }
  .warn { color: var(--danger); margin: 0 0 8px; }
</style>
