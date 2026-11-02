<script lang="ts">
  // The form view of one user rule (M2 T15): match.url, match title, the group action, the dedupe mode, the close
  // action, and dry run (enabled and name sit in the row's bar, Rules.svelte). It edits the same Rule as the YAML view
  // through RuleForm (src/ui/rules-model.ts); rules it cannot show never reach it (ruleForm returns null).
  import type { DedupeMode, GroupColor, TabSnap } from '../../core/types';
  import type { CloseMode, GroupAction, Rule } from '../../core/lang/types';
  import { actionPaths, errorsForPath, patternError, patternHints, previewMatches, type RuleForm } from '../../ui/rules-model';
  import { compileTextPattern } from '../../core/match/pattern';
  import { DURATION } from '../../core/lang/duration';
  import LinesField from './LinesField.svelte';

  let { rule, form, index, tabs, serverErrors, onPatch }: {
    rule: Rule; form: RuleForm; index: number; tabs: TabSnap[]; serverErrors: string[];
    onPatch: (p: Partial<RuleForm>) => void;
  } = $props();

  const COLORS: GroupColor[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  /** A new group / close action starts from these (close suggests rather than closes until the user picks auto). */
  const NEW_GROUP: GroupAction = { title: 'New group', color: 'blue' };
  const NEW_CLOSE = { after: '3s', mode: 'suggest' as CloseMode };

  const lines = $derived(Array.isArray(form.url) ? form.url : form.url === '' ? [] : [form.url]);
  const toUrl = (l: string[]): string | string[] => (l.length > 1 ? l : (l[0] ?? ''));
  const hints = $derived(lines.flatMap((p) => patternHints(p).map((h) => `${p}: ${h}`)));
  const count = $derived.by(() => {
    const n = previewMatches({ id: rule.id, name: '', enabled: true, match: { url: form.url }, group: { title: '', color: 'grey' } }, tabs).length;
    return `Matches ${n} open ${n === 1 ? 'tab' : 'tabs'}`;
  });
  const titleError = $derived.by(() => {
    if (form.title === '') return undefined;
    try { compileTextPattern(form.title); return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); }
  });
  const afterError = $derived(form.close?.after !== undefined && !DURATION.test(form.close.after) ? 'must be a duration like 500ms, 30s, 15m, 2h or 1d' : undefined);
  const noAction = $derived(!form.group && !form.dedupe && !form.close);

  const group = (p: Partial<GroupAction>): void => onPatch({ group: { ...(form.group ?? NEW_GROUP), ...p } });
  const close = (p: { after?: string; mode?: CloseMode }): void => onPatch({ close: { ...(form.close ?? NEW_CLOSE), ...p } });
  const matchPath = (k: 'url' | 'title'): string => (form.title !== '' && lines.length > 0 ? `match/all/${k === 'url' ? 0 : 1}/${k}` : `match/${k}`);
  /** Server errors under /rules/<index>/<sub>. */
  const sErr = (sub: string): string[] => errorsForPath(serverErrors, `/rules/${index}/${sub}`);
  const groupPath = $derived(actionPaths(rule).group);
  const closePath = $derived(`actions/${Math.max(0, rule.actions.findIndex((a) => 'close' in a))}/close`);
</script>

<LinesField label="URL patterns (one per line: glob, /regex/, or :param)" value={lines} rows={2}
  check={patternError} onChange={(l) => onPatch({ url: toUrl(l) })} extraErrors={sErr(matchPath('url'))} />
{#each hints as h (h)}<p class="hint" role="note">{h}</p>{/each}
<span class="count">{count}</span>

<label class="field">Title pattern (optional)
  <input value={form.title} placeholder="e.g. *Inbox*" oninput={(e) => onPatch({ title: e.currentTarget.value })} />
</label>
{#if titleError}<p class="err" role="alert">{form.title}: {titleError}</p>{/if}
{#each sErr(matchPath('title')) as m (m)}<p class="err" role="alert">title {m}</p>{/each}

<label class="inline"><input type="checkbox" checked={form.group !== null} onchange={(e) => onPatch({ group: e.currentTarget.checked ? (form.group ?? NEW_GROUP) : null })} /> Group tabs</label>
{#if form.group}
  <div class="grid">
    <label>Group title template
      <input value={form.group.title} oninput={(e) => group({ title: e.currentTarget.value })} />
    </label>
    {#each sErr(`${groupPath}/title`) as m (m)}<p class="err" role="alert">title {m}</p>{/each}
    <label>Color
      <select value={form.group.color} onchange={(e) => group({ color: e.currentTarget.value })}>
        {#each COLORS as c (c)}<option value={c}>{c}</option>{/each}
      </select>
    </label>
    {#each sErr(`${groupPath}/color`) as m (m)}<p class="err" role="alert">color {m}</p>{/each}
    <label>Group order
      <select value={form.group.sortGroups ?? 'creation'} onchange={(e) => group({ sortGroups: e.currentTarget.value as 'creation' | 'alphabetical' })}>
        <option value="creation">creation</option><option value="alphabetical">alphabetical</option>
      </select>
    </label>
  </div>
  <div class="checks">
    <label class="inline"><input type="checkbox" checked={form.group.collapsed ?? false} onchange={(e) => group({ collapsed: e.currentTarget.checked })} /> Collapsed</label>
    <label class="inline"><input type="checkbox" checked={form.group.strict ?? true} onchange={(e) => group({ strict: e.currentTarget.checked })} /> Strict (ungroup when URL stops matching)</label>
    <label class="inline"><input type="checkbox" checked={form.group.merge ?? false} onchange={(e) => group({ merge: e.currentTarget.checked })} /> Merge across windows</label>
  </div>
{/if}

<div class="grid">
  <label>Dedupe override
    <select value={form.dedupe ?? ''} onchange={(e) => { const v = e.currentTarget.value; onPatch({ dedupe: v === '' ? null : (v as DedupeMode) }); }}>
      <option value="">inherit global</option><option value="always-switch">always-switch</option><option value="ask">ask</option><option value="off">off</option>
    </select>
  </label>
</div>
{#each sErr(actionPaths(rule).dedupe) as m (m)}<p class="err" role="alert">dedupe {m}</p>{/each}

<label class="inline"><input type="checkbox" checked={form.close !== null} onchange={(e) => onPatch({ close: e.currentTarget.checked ? (form.close ?? NEW_CLOSE) : null })} /> Close tabs</label>
{#if form.close}
  <div class="grid">
    <label>Close after
      <input value={form.close.after ?? ''} placeholder="e.g. 3s" oninput={(e) => { const v = e.currentTarget.value.trim(); const rest = { ...form.close }; delete rest.after; onPatch({ close: v === '' ? rest : { ...rest, after: v } }); }} />
    </label>
    <label>Close mode
      <select value={form.close.mode ?? 'auto'} onchange={(e) => close({ mode: e.currentTarget.value as CloseMode })}>
        <option value="auto">close automatically</option><option value="suggest">suggest in the Finished list</option>
      </select>
    </label>
  </div>
  {#if afterError}<p class="err" role="alert">after {afterError}</p>{/if}
  {#each sErr(closePath) as m (m)}<p class="err" role="alert">close {m}</p>{/each}
{/if}
{#if noAction}<p class="err" role="alert">Pick at least one action (group, dedupe or close).</p>{/if}

<label class="inline"><input type="checkbox" checked={form.dryRun} onchange={(e) => onPatch({ dryRun: e.currentTarget.checked })} /> Dry run (log what it would do, change nothing)</label>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
  .grid label, .field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
  .checks { display: flex; gap: 14px; flex-wrap: wrap; }
  .inline { display: inline-flex; align-items: center; gap: 4px; }
  .count { color: var(--muted); font-size: 12px; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
  .hint { color: var(--muted); font-size: 12px; margin: 2px 0 0; }
</style>
