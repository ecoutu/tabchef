<script lang="ts">
  // The form view of one user rule (M2 T15): match.url, match title, the group action, the dedupe mode, the close
  // action, and dry run (enabled and name sit in the row's bar, Rules.svelte). It edits the same Rule as the YAML view
  // through RuleForm (src/ui/rules-model.ts); rules it cannot show never reach it (ruleForm returns null).
  import type { DedupeMode, GroupColor, TabSnap } from '../../core/types';
  import type { CloseMode, GroupAction, Rule } from '../../core/lang/types';
  import { actionPaths, errorsForPath, patternError, patternHints, previewMatches, type RuleForm } from '../../ui/rules-model';
  import { compileTextPattern } from '../../core/match/pattern';
  import { DURATION } from '../../core/lang/duration';
  import Field from './Field.svelte';
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
  helpLabel="URL patterns" help="A tab whose URL matches any line belongs to this rule. * matches anything (github.com/*), /…/ is a regular expression, and :name captures one path segment for the group title, e.g. github.com/:owner/:repo*."
  check={patternError} onChange={(l) => onPatch({ url: toUrl(l) })} extraErrors={sErr(matchPath('url'))} />
{#each hints as h (h)}<p class="hint" role="note">{h}</p>{/each}
<span class="count">{count}</span>

<Field label="Title pattern (optional)" helpLabel="Title pattern" help="Optional. The tab's title must match this too, e.g. *Inbox* for any title containing Inbox. * matches anything.">
  <input value={form.title} placeholder="e.g. *Inbox*" oninput={(e) => onPatch({ title: e.currentTarget.value })} />
</Field>
{#if titleError}<p class="err" role="alert">{form.title}: {titleError}</p>{/if}
{#each sErr(matchPath('title')) as m (m)}<p class="err" role="alert">title {m}</p>{/each}

<Field label="Group tabs" help="Put tabs matching this rule into a tab group." inline>
  <input type="checkbox" checked={form.group !== null} onchange={(e) => onPatch({ group: e.currentTarget.checked ? (form.group ?? NEW_GROUP) : null })} />
</Field>
{#if form.group}
  <div class="grid">
    <Field label="Group title template" help={"The group's name. {name} inserts a value captured by the URL pattern: {repo} with github.com/:owner/:repo* gives one group per repository."}>
      <input value={form.group.title} oninput={(e) => group({ title: e.currentTarget.value })} />
    </Field>
    {#each sErr(`${groupPath}/title`) as m (m)}<p class="err" role="alert">title {m}</p>{/each}
    <Field label="Color" help="The tab group's color in the tab bar. Tabchef sets it back if the group's color is changed.">
      <select value={form.group.color} onchange={(e) => group({ color: e.currentTarget.value })}>
        {#each COLORS as c (c)}<option value={c}>{c}</option>{/each}
      </select>
    </Field>
    {#each sErr(`${groupPath}/color`) as m (m)}<p class="err" role="alert">color {m}</p>{/each}
    <Field label="Group order" help={"When this rule makes several groups (a title with {name}), order them in the tab bar by when each was created, or alphabetically by title."}>
      <select value={form.group.sortGroups ?? 'creation'} onchange={(e) => group({ sortGroups: e.currentTarget.value as 'creation' | 'alphabetical' })}>
        <option value="creation">creation</option><option value="alphabetical">alphabetical</option>
      </select>
    </Field>
  </div>
  <div class="checks">
    <Field label="Collapsed" help="Tabchef creates this rule's groups collapsed. Expanding one yourself is left alone." inline>
      <input type="checkbox" checked={form.group.collapsed ?? false} onchange={(e) => group({ collapsed: e.currentTarget.checked })} />
    </Field>
    <Field label="Strict (ungroup when URL stops matching)" helpLabel="Strict" help="On: when a grouped tab navigates to a URL this rule no longer matches, Tabchef takes it out of the group. Off: it stays in the group." inline>
      <input type="checkbox" checked={form.group.strict ?? true} onchange={(e) => group({ strict: e.currentTarget.checked })} />
    </Field>
    <Field label="Merge across windows" help="Keep one group for all windows: matching tabs in other windows move into the window that has the group." inline>
      <input type="checkbox" checked={form.group.merge ?? false} onchange={(e) => group({ merge: e.currentTarget.checked })} />
    </Field>
  </div>
{/if}

<div class="grid">
  <Field label="Dedupe override" help="How duplicates of this rule's tabs are handled. inherit global uses the Mode on the Duplicates page; the others replace it for these tabs only.">
    <select value={form.dedupe ?? ''} onchange={(e) => { const v = e.currentTarget.value; onPatch({ dedupe: v === '' ? null : (v as DedupeMode) }); }}>
      <option value="">inherit global</option><option value="always-switch">always-switch</option><option value="ask">ask</option><option value="off">off</option>
    </select>
  </Field>
</div>
{#each sErr(actionPaths(rule).dedupe) as m (m)}<p class="err" role="alert">dedupe {m}</p>{/each}

<Field label="Close tabs" help="Close tabs matching this rule, or only suggest closing them in the popup's Finished tab (see Close mode)." inline>
  <input type="checkbox" checked={form.close !== null} onchange={(e) => onPatch({ close: e.currentTarget.checked ? (form.close ?? NEW_CLOSE) : null })} />
</Field>
{#if form.close}
  <div class="grid">
    <Field label="Close after" help="How long after the page loads, e.g. 3s, 5m or 1h. Empty: as soon as the tab matches.">
      <input value={form.close.after ?? ''} placeholder="e.g. 3s" oninput={(e) => { const v = e.currentTarget.value.trim(); const rest = { ...form.close }; delete rest.after; onPatch({ close: v === '' ? rest : { ...rest, after: v } }); }} />
    </Field>
    <Field label="Close mode" help="close automatically: the tab closes after the delay, and you can undo it. suggest: it is only listed in the popup's Finished tab. Tabs you are using, pinned or locked tabs, and tabs with unsaved form edits are never closed automatically.">
      <select value={form.close.mode ?? 'auto'} onchange={(e) => close({ mode: e.currentTarget.value as CloseMode })}>
        <option value="auto">close automatically</option><option value="suggest">suggest in the Finished list</option>
      </select>
    </Field>
  </div>
  {#if afterError}<p class="err" role="alert">after {afterError}</p>{/if}
  {#each sErr(closePath) as m (m)}<p class="err" role="alert">close {m}</p>{/each}
{/if}
{#if noAction}<p class="err" role="alert">Pick at least one action (group, dedupe or close).</p>{/if}

<Field label="Dry run (log what it would do, change nothing)" helpLabel="Dry run" help="Try the rule out: History logs what it would group or close, but no tab is touched. Turn it off to let the rule act." inline>
  <input type="checkbox" checked={form.dryRun} onchange={(e) => onPatch({ dryRun: e.currentTarget.checked })} />
</Field>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
  .checks { display: flex; gap: 14px; flex-wrap: wrap; }
  .count { color: var(--muted); font-size: 12px; }
  .err { color: var(--danger); font-size: 12px; margin: 2px 0 0; }
  .hint { color: var(--muted); font-size: 12px; margin: 2px 0 0; }
</style>
