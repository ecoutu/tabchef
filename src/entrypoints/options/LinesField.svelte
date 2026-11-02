<script lang="ts">
  /** Textarea editing a list of strings, one per line. Keeps the raw text locally so typing newlines isn't swallowed. */
  import Help from './Help.svelte';

  let { label, value, rows = 2, check, onChange, extraErrors = [], commas = false, help, helpLabel }: {
    label: string; value: string[]; rows?: number;
    /** A help tip next to the label (outside it). `helpLabel`: its short name ("About <helpLabel>"), default `label`. */
    help?: string; helpLabel?: string;
    check?: (line: string) => string | undefined;
    onChange: (v: string[]) => void;
    extraErrors?: string[];
    /** Also split on commas. */
    commas?: boolean;
  } = $props();

  const uid = $props.id();
  const id = `lines-${uid}`;
  const parse = (t: string): string[] => t.split(commas ? /[\n,]/ : '\n').map((l) => l.trim()).filter((l) => l !== '');
  let text = $state('');
  let init = false;
  $effect(() => {
    // Resync from outside (e.g. restore/import) only when it differs from what the local text already means.
    const v = value;
    if (!init || v.join('\n') !== parse(text).join('\n')) { text = v.join('\n'); init = true; }
  });
  const lineErrors = $derived(check ? parse(text).flatMap((l) => { const m = check(l); return m ? [`${l}: ${m}`] : []; }) : []);
</script>

<div class="lf">
  <span class="head"><label for={id}>{label}</label>{#if help}<Help label={helpLabel ?? label} text={help} />{/if}</span>
  <textarea {id} {rows} value={text} oninput={(e) => { text = e.currentTarget.value; onChange(parse(text)); }}></textarea>
</div>
{#each lineErrors as m (m)}<p class="err" role="alert">{m}</p>{/each}
{#each extraErrors as m (m)}<p class="err" role="alert">{m}</p>{/each}

<style>
  .lf { display: flex; flex-direction: column; gap: 2px; }
  .head { display: inline-flex; align-items: center; gap: 6px; }
  .head label { font-size: 12px; color: var(--muted); }
  textarea { font: 12px/1.4 ui-monospace, monospace; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; resize: vertical; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
</style>
