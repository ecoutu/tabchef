<script lang="ts">
  // A pre-filled rule from the context menu (M2 T16), `#/rules/new?url=<enc>&kind=group|close|allowDup`: a pattern
  // picker (suggestPatterns candidates + a free edit box, with the editor hints and a live "Matches N open tabs" count
  // from the same matcher as the Rules form), then a group target, close settings, or nothing (never dedupe). Save hands
  // the whole config to App.svelte, which runs the shared Save path: preview.change → [Apply] → config.set {baseRev}.
  import type { Config, GroupColor, TabSnap } from '../../core/types';
  import type { CloseMode } from '../../core/lang/types';
  import { suggestPatterns } from '../../core/lang/suggest';
  import { DURATION } from '../../core/lang/duration';
  import { addNewRule, groupRuleChoices, patternError, patternHints, previewMatches, type NewRuleSpec } from '../../ui/rules-model';

  let { url, kind, config, tabs, saving, onSave }: {
    url: string; kind: string; config: Config; tabs: TabSnap[]; saving: boolean; onSave: (c: Config) => void;
  } = $props();

  const COLORS: GroupColor[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  const HEADINGS: Record<string, string> = { group: 'Group pages like this', close: 'Auto-close pages like this', allowDup: 'Never dedupe this site' };
  const VERBS: Record<string, string> = { group: 'Group', close: 'Close', allowDup: 'Never dedupe' };

  // The page's inputs are fixed for its lifetime (App re-creates it when the hash changes).
  // svelte-ignore state_referenced_locally
  const candidates = suggestPatterns(url);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  // "Never dedupe this site" starts at the whole host; the others at the most specific candidate.
  // svelte-ignore state_referenced_locally
  const initial = kind === 'allowDup' ? candidates.filter((c) => !c.startsWith('*.')).at(-1) : candidates[0];

  let pattern = $state(initial ?? '');
  let name = $state<string | null>(null);
  let target = $state(''); // '' = new group, else the id of an existing group rule
  let title = $state(host || 'New group');
  let color = $state<GroupColor>('blue');
  let after = $state('3s');
  let mode = $state<CloseMode>('auto');

  const ruleName = $derived(name ?? `${VERBS[kind] ?? ''} ${pattern}`.trim());
  const choices = $derived(groupRuleChoices(config));
  const error = $derived(pattern.trim() === '' ? undefined : patternError(pattern.trim()));
  const hints = $derived(patternHints(pattern.trim()));
  const count = $derived.by(() => {
    const n = error || pattern.trim() === '' ? 0
      : previewMatches({ id: 'new', name: '', enabled: true, match: { url: pattern.trim() }, group: { title: '', color: 'grey' } }, tabs).length;
    return `Matches ${n} open ${n === 1 ? 'tab' : 'tabs'}`;
  });
  const afterError = $derived(after.trim() !== '' && !DURATION.test(after.trim()) ? 'must be a duration like 500ms, 30s, 15m, 2h or 1d' : undefined);
  const blocked = $derived(saving || pattern.trim() === '' || error !== undefined
    || (kind === 'close' && afterError !== undefined) || (kind === 'group' && target === '' && title.trim() === ''));

  function spec(): NewRuleSpec {
    const p = pattern.trim();
    if (kind === 'group') return { kind, pattern: p, name: ruleName, group: target !== '' ? { existing: target } : { title: title.trim(), color } };
    if (kind === 'close') return { kind, pattern: p, name: ruleName, close: { ...(after.trim() !== '' && { after: after.trim() }), mode } };
    return { kind: 'allowDup', pattern: p, name: ruleName };
  }
  const save = (): void => onSave(addNewRule($state.snapshot(config) as Config, spec()));
</script>

<section aria-label="New rule">
  {#if !Object.hasOwn(HEADINGS, kind)}
    <p class="err" role="alert">Unknown rule kind “{kind}”. <a href="#/rules">Back to rules</a></p>
  {:else}
    <h2>{HEADINGS[kind]}</h2>
    <p class="help">From <code>{url}</code></p>

    <fieldset>
      <legend>Pages like this</legend>
      {#each candidates as c (c)}
        <label class="inline"><input type="radio" name="pattern" value={c} checked={pattern === c} onchange={() => (pattern = c)} /> {c}</label>
      {/each}
      {#if candidates.length === 0}<p class="help">No suggestions for this address; type a pattern.</p>{/if}
      <label class="field">URL pattern
        <input aria-label="URL pattern" value={pattern} placeholder="e.g. github.com/acme/*" oninput={(e) => (pattern = e.currentTarget.value)} />
      </label>
      {#if error}<p class="err" role="alert">{pattern}: {error}</p>{/if}
      {#each hints as h (h)}<p class="hint" role="note">{h}</p>{/each}
      <span class="count" role="status">{count}</span>
    </fieldset>

    <label class="field">Rule name
      <input aria-label="Rule name" value={ruleName} oninput={(e) => (name = e.currentTarget.value)} />
    </label>

    {#if kind === 'group'}
      <div class="grid">
        <label>Group
          <select aria-label="Group" value={target} onchange={(e) => (target = e.currentTarget.value)}>
            <option value="">New group</option>
            {#each choices as c (c.id)}<option value={c.id}>{c.name} ({c.title})</option>{/each}
          </select>
        </label>
        {#if target === ''}
          <label>Group title
            <input aria-label="Group title" value={title} oninput={(e) => (title = e.currentTarget.value)} />
          </label>
          <label>Color
            <select aria-label="Color" value={color} onchange={(e) => (color = e.currentTarget.value as GroupColor)}>
              {#each COLORS as c (c)}<option value={c}>{c}</option>{/each}
            </select>
          </label>
        {/if}
      </div>
    {:else if kind === 'close'}
      <div class="grid">
        <label>Close after
          <input aria-label="Close after" value={after} placeholder="e.g. 3s" oninput={(e) => (after = e.currentTarget.value)} />
        </label>
        <label>Close mode
          <select aria-label="Close mode" value={mode} onchange={(e) => (mode = e.currentTarget.value as CloseMode)}>
            <option value="auto">close automatically</option><option value="suggest">suggest in the Finished list</option>
          </select>
        </label>
      </div>
      {#if afterError}<p class="err" role="alert">after {afterError}</p>{/if}
    {:else}
      <p class="help">Tabs matching this pattern are never closed as duplicates (dedupe off).</p>
    {/if}

    <div class="actions">
      <button type="button" class="primary" disabled={blocked} onclick={save}>Save</button>
      <a href="#/rules">Cancel</a>
    </div>
  {/if}
</section>

<style>
  h2 { font-size: 16px; margin: 0 0 4px; }
  section { display: flex; flex-direction: column; gap: 10px; }
  fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
  .grid label, .field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  .inline { display: inline-flex; align-items: center; gap: 4px; }
  .help { color: var(--muted); margin: 0; word-break: break-all; }
  .count { color: var(--muted); font-size: 12px; }
  .hint { color: var(--muted); font-size: 12px; margin: 0; }
  .err { color: var(--danger); font-size: 12px; margin: 0; }
  .actions { display: flex; gap: 12px; align-items: center; }
</style>
