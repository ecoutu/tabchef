<script lang="ts">
  // The YAML view of one rule (M2 T15). It edits the same Rule object as the form: every valid edit goes out through
  // onChange; while the text is invalid, the errors are listed by line and the last valid rule stays in the config.
  import type { Rule } from '../../core/lang/types';
  import { patternHints, ruleToYaml, ruleUrlPatterns, yamlToRule } from '../../ui/rules-model';

  let { rule, onChange, onValidity }: {
    rule: Rule;
    /** Applies the rule; returns an error when it cannot (e.g. its id collides with another rule). */
    onChange: (r: Rule) => string | undefined;
    /** Whether the text is valid and applied (Rules blocks Save while any YAML view is invalid). */
    onValidity?: (ok: boolean) => void;
  } = $props();

  let text = $state('');
  let errors = $state<{ line?: number; message: string }[]>([]);
  /** JSON of the rule the text last produced or showed: an outside change differs from it and resyncs the text. */
  let shown = '';
  $effect(() => {
    const json = JSON.stringify(rule);
    if (json !== shown) { shown = json; text = ruleToYaml($state.snapshot(rule) as Rule); errors = []; }
  });

  function edit(t: string): void {
    text = t;
    const r = yamlToRule(t);
    if (!r.ok) { errors = r.errors; onValidity?.(false); return; }
    const err = onChange(r.rule);
    if (err) { errors = [{ message: err }]; onValidity?.(false); return; }
    shown = JSON.stringify(r.rule);
    errors = [];
    onValidity?.(true);
  }

  const hints = $derived(ruleUrlPatterns(rule).flatMap((p) => patternHints(p).map((h) => `${p}: ${h}`)));
  const rows = $derived(Math.min(24, Math.max(6, text.split('\n').length + 1)));
</script>

<label class="yaml">
  <span>YAML</span>
  <textarea aria-label="Rule YAML" spellcheck="false" {rows} value={text} oninput={(e) => edit(e.currentTarget.value)}></textarea>
</label>
{#each errors as e, i (i)}<p class="err" role="alert">{e.line !== undefined ? `Line ${e.line}: ` : ''}{e.message}</p>{/each}
{#if errors.length}<p class="note">Until the YAML is valid, the last valid version is kept.</p>{/if}
{#each hints as h (h)}<p class="hint" role="note">{h}</p>{/each}

<style>
  .yaml { display: flex; flex-direction: column; gap: 2px; }
  .yaml span { font-size: 12px; color: var(--muted); }
  textarea { font: 12px/1.45 ui-monospace, monospace; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px; resize: vertical; tab-size: 2; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
  .note, .hint { color: var(--muted); font-size: 12px; margin: 2px 0 0; }
</style>
