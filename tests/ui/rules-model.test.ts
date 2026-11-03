import { describe, it, expect } from 'vitest';
import { reorderRules, addRule, updateRule, removeRule, previewMatches, patternError, configPatternErrors, errorsForPath, orderedUserRules, formRule, addNewRule, groupRuleChoices } from '../../src/ui/rules-model';
import { defaultConfig } from '../../src/core/config/defaults';
import { validateConfig } from '../../src/core/config/schema';
import type { Config, GroupRule, Rule, TabSnap } from '../../src/core/types';
import { withGroupRules } from '../helpers/config';

const rule = (id: string, url: string | string[] = 'a.com/*'): GroupRule => ({ id, name: id, enabled: true, match: { url }, group: { title: id, color: 'blue' } });
const cfg = (...ids: string[]): Config => withGroupRules(ids.map((i) => rule(i)));
const shownIds = (c: Config) => orderedUserRules(c).map((x) => x.id);
const tab = (id: number, url: string): TabSnap => ({ id, windowId: 1, index: id, url, title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false });

describe('rules-model', () => {
  it('reorderRules moves a rule by editing order only, keeps ids, does not mutate', () => {
    const c = cfg('a', 'b', 'c');
    const r = reorderRules(c, 0, 2);
    expect(r.order).toEqual(['user/b', 'user/c', 'user/a']);
    expect(shownIds(r)).toEqual(['b', 'c', 'a']);
    expect(r.rules).toBe(c.rules);
    expect(c.order).toEqual(['user/a', 'user/b', 'user/c']);
    expect(reorderRules(c, 1, 9)).toBe(c);
    expect(reorderRules(c, 1, 1)).toBe(c);
  });

  it('reorderRules keeps recipe keys in place and appends user rules missing from order', () => {
    const c = { ...cfg('a', 'b', 'c'), order: ['user/a', 'github-prs/pr', 'user/b'] };
    expect(shownIds(c)).toEqual(['a', 'b', 'c']);
    expect(reorderRules(c, 2, 0).order).toEqual(['user/c', 'github-prs/pr', 'user/a', 'user/b']);
    expect(validateConfig(reorderRules(c, 2, 0)).ok).toBe(true);
  });

  it('addRule produces a valid config with a generated id', () => {
    const r = addRule(defaultConfig());
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]!.id).toMatch(/\S/);
    expect(r.order).toEqual([`user/${r.rules[0]!.id}`]);
    expect(validateConfig(r).ok).toBe(true);
    const r2 = addRule(r, { name: 'X' });
    expect(r2.rules[1]!.name).toBe('X');
    expect(r2.rules[1]!.id).not.toBe(r2.rules[0]!.id);
    expect(validateConfig(r2).ok).toBe(true);
  });

  it('updateRule patches by id and removeRule deletes', () => {
    const c = cfg('a', 'b');
    expect(updateRule(c, 'b', { enabled: false }).rules[1]!.enabled).toBe(false);
    expect(formRule(updateRule(c, 'b', { strict: false, dedupe: 'ask' }).rules[1]!)).toMatchObject({ strict: false, dedupe: 'ask' });
    expect(formRule(updateRule(updateRule(c, 'b', { dedupe: 'ask' }), 'b', { dedupe: undefined }).rules[1]!)!.dedupe).toBeUndefined();
    expect(updateRule(c, 'zz', { enabled: false })).toBe(c);
    const removed = removeRule(c, 'a');
    expect(removed.rules.map((x) => x.id)).toEqual(['b']);
    expect(removed.order).toEqual(['user/b']);
  });

  it('rules the form cannot express are not editable through updateRule', () => {
    const c = { ...defaultConfig(), rules: [{ id: 'x', name: 'X', enabled: true, match: { title: '*a*' }, actions: [{ close: {} }] }], order: ['user/x'] } as Config;
    expect(formRule(c.rules[0]!)).toBeNull();
    expect(updateRule(c, 'x', { enabled: false })).toBe(c);
  });

  it('previewMatches returns only matching tabs', () => {
    const tabs = [tab(1, 'https://github.com/acme/x'), tab(2, 'https://github.com/other/y'), tab(3, 'https://github.com/acme/z')];
    expect(previewMatches(rule('r', 'github.com/acme/*'), tabs).map((t) => t.id)).toEqual([1, 3]);
    expect(previewMatches(rule('r', ['github.com/other/*', 'nomatch.test/*']), tabs).map((t) => t.id)).toEqual([2]);
  });

  it('previewMatches tolerates invalid patterns', () => {
    expect(previewMatches(rule('r', '/(/'), [tab(1, 'https://a.com/')])).toEqual([]);
  });

  it('patternError reports compile errors', () => {
    expect(patternError('/(/')).toMatch(/invalid regex/);
    expect(patternError('a.com/*')).toBeUndefined();
  });

  it('configPatternErrors covers rules and dedupe lists', () => {
    const c = cfg('a');
    expect(configPatternErrors(c)).toEqual([]);
    c.rules[0]!.match = { url: ['ok.com/*', '/(/'] };
    c.dedupe.allowDuplicates = ['/(/'];
    expect(configPatternErrors(c).map((e) => e.path)).toEqual(['/rules/0/match/url/1', '/dedupe/allowDuplicates/0']);
  });

  it('configPatternErrors checks the T18 override patterns', () => {
    const c = cfg('a');
    c.dedupe.fragmentOverrides = [{ pattern: 'a.com/*', keepFragment: true }, { pattern: '/(/', keepFragment: false }];
    c.dedupe.titleOverrides = [{ pattern: '', matchTitle: true }, { pattern: 'x'.repeat(501), matchTitle: true }];
    expect(configPatternErrors(c).map((e) => e.path)).toEqual(['/dedupe/fragmentOverrides/1/pattern', '/dedupe/titleOverrides/0/pattern', '/dedupe/titleOverrides/1/pattern']);
  });

  it('errorsForPath matches server errors by path prefix', () => {
    const errs = ['/rules/2/actions/0/group/color must be equal', '/dedupe/mode bad', 'duplicate rule id: x'];
    expect(errorsForPath(errs, '/rules/2/actions/0/group/color')).toEqual(['must be equal']);
    expect(errorsForPath(errs, '/rules/2')).toEqual(['actions/0/group/color must be equal']);
    expect(errorsForPath(errs, '/rules/1')).toEqual([]);
  });
});

describe('unclaimedErrors', () => {
  it('keeps only errors no field shows', async () => {
    const { unclaimedErrors } = await import('../../src/ui/rules-model');
    expect(unclaimedErrors(['/rules/2/actions/0/group/color bad', '/rules/0/actions/1/dedupe/mode bad', '/ must have x', '/rules/1/id duplicate rule id: x', '/dedupe/mode bad']))
      .toEqual(['/ must have x', '/rules/1/id duplicate rule id: x']);
  });

  it('claims the T15 form fields too: dryRun, title / all[url, title] match, close', async () => {
    const { unclaimedErrors } = await import('../../src/ui/rules-model');
    expect(unclaimedErrors(['/rules/0/dryRun bad', '/rules/0/match/title bad', '/rules/0/match/all/0/url/1 bad', '/rules/0/match/all/1/title bad',
      '/rules/0/actions/1/close/after bad', '/rules/0/actions/1/close bad', '/rules/0/match/any/0/url bad'])).toEqual(['/rules/0/match/any/0/url bad']);
  });

  it('claims the T18 dedupe fields; urlTransforms (not editable on the form) stays unclaimed', async () => {
    const { unclaimedErrors } = await import('../../src/ui/rules-model');
    expect(unclaimedErrors(['/dedupe/matchTitle bad', '/dedupe/fragmentOverrides/0/pattern bad', '/dedupe/titleOverrides/1/matchTitle bad',
      '/dedupe/urlTransforms/0/pattern regex too long'])).toEqual(['/dedupe/urlTransforms/0/pattern regex too long']);
  });
});

describe('rules-model: YAML (M2 T15)', () => {
  it('yamlToRule(ruleToYaml(r)) round-trips every built-in rule (param defaults substituted)', async () => {
    const { ruleToYaml, yamlToRule, ruleRows } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => ({ ...r, enabled: true })) };
    const rows = ruleRows(c, builtinRecipes()).filter((r) => r.kind === 'recipe');
    expect(rows.map((r) => r.key)).toEqual(['github-prs/group-by-repo', 'finished/oauth-callback', 'finished/meet-ended', 'finished/redirect', 'merged-prs/pr-state', 'merged-prs/auto-close-merged',
      ...['title', 'branch', 'either'].flatMap((v) => [`jira-ticket-${v}/ticket`, `jira-ticket-${v}/pr`])]);
    for (const row of rows) expect(yamlToRule(ruleToYaml(row.rule))).toEqual({ ok: true, rule: row.rule });
  });

  it('round-trips a user rule', async () => {
    const { ruleToYaml, yamlToRule } = await import('../../src/ui/rules-model');
    const r = cfg('a').rules[0]!;
    expect(yamlToRule(ruleToYaml(r))).toEqual({ ok: true, rule: r });
  });

  it('maps a schema error to its line: actions: [{ eval: x }] on line 4 → line 4', async () => {
    const { yamlToRule } = await import('../../src/ui/rules-model');
    const r = yamlToRule("id: x\nname: X\nenabled: true\nactions: [{ eval: x }]\nmatch: { url: 'a.com/*' }\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.line).toBe(4);
    expect(r.errors[0]!.message).toMatch(/eval/);
  });

  it('an unknown top-level key points at that key\'s line; a bad color at the color line', async () => {
    const { yamlToRule } = await import('../../src/ui/rules-model');
    const r = yamlToRule("id: x\nname: X\nenabled: true\nmatch:\n  url: a.com/*\nbogus: 1\nactions:\n  - group:\n      title: A\n      color: blue\n");
    expect(!r.ok && r.errors.map((e) => e.line)).toEqual([6]);
    const c = yamlToRule("id: x\nname: X\nenabled: true\nmatch:\n  url: a.com/*\nactions:\n  - group:\n      title: A\n      color: nope\n");
    expect(!c.ok && c.errors.map((e) => e.line)).toEqual([9]);
  });

  it('reports YAML syntax errors with their line, and a non-mapping document', async () => {
    const { yamlToRule } = await import('../../src/ui/rules-model');
    const r = yamlToRule('id: x\nname: [unclosed\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.line).toBeGreaterThanOrEqual(2);
    expect(yamlToRule('- a\n- b\n')).toEqual({ ok: false, errors: [{ line: 1, message: 'A rule must be a mapping (id, name, enabled, match, actions)' }] });
  });

  it('runs the post-checks (pattern compile) too', async () => {
    const { yamlToRule } = await import('../../src/ui/rules-model');
    const r = yamlToRule("id: x\nname: X\nenabled: true\nmatch:\n  url: '/(/'\nactions:\n  - group: { title: A, color: blue }\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ line: 5 });
  });
});

describe('rules-model: order across user and recipe rules (M2 T15)', () => {
  it('reorder moves a recipe key above a user key (operates on order)', async () => {
    const { reorder, ruleRows } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const base = { ...cfg('a', 'b'), recipes: defaultConfig().recipes.map((r) => ({ ...r, enabled: r.id === 'finished' || r.enabled })) };
    const keys = (c: Config) => ruleRows(c, builtinRecipes()).map((r) => r.key);
    expect(keys(base)).toEqual(['user/a', 'user/b', 'github-prs/group-by-repo', 'finished/oauth-callback', 'finished/meet-ended', 'finished/redirect']);
    const moved = reorder(base, 'finished/oauth-callback', 0, builtinRecipes());
    expect(keys(moved)).toEqual(['finished/oauth-callback', 'user/a', 'user/b', 'github-prs/group-by-repo', 'finished/meet-ended', 'finished/redirect']);
    expect(moved.order[0]).toBe('finished/oauth-callback');
    expect(moved.rules).toBe(base.rules);
    expect(validateConfig(moved).ok).toBe(true);
    expect(reorder(base, 'nope/x', 0, builtinRecipes())).toBe(base);
    expect(reorder(base, 'user/a', 0, builtinRecipes())).toBe(base);
  });

  it('reorder keeps order entries it does not show (disabled recipes) in place', async () => {
    const { reorder } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...cfg('a', 'b'), order: ['user/a', 'finished/redirect', 'user/b'] };
    expect(reorder(c, 'user/b', 0, builtinRecipes()).order.slice(0, 3)).toEqual(['user/b', 'finished/redirect', 'user/a']);
  });

  it('ruleRows lists recipe rules of enabled recipes with params substituted, locked', async () => {
    const { ruleRows } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true, params: { delay: '9s' } } : r)) };
    const row = ruleRows(c, builtinRecipes()).find((r) => r.key === 'finished/oauth-callback')!;
    expect(row).toMatchObject({ kind: 'recipe', recipeId: 'finished', recipeName: 'Finished' });
    expect(row.rule.actions).toEqual([{ close: { after: '9s', mode: 'auto' } }]);
    expect(Array.isArray((row.rule.match as { url: string[] }).url)).toBe(true);
  });

  it('customizeRule copies a recipe rule into a user rule placed just above it, with a non-colliding id', async () => {
    const { customizeRule, ruleRows } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => ({ ...r, enabled: true })) };
    const once = customizeRule(c, 'finished/meet-ended', builtinRecipes());
    const r = once.rules[0]!;
    expect(r.id).toBe('finished-meet-ended');
    expect(r).not.toHaveProperty('needs'); // user rules declare no needs (R44)
    expect(r.name).toBe('Close Meet tabs after the call ends (custom)');
    const keys = ruleRows(once, builtinRecipes()).map((x) => x.key);
    expect(keys.indexOf('user/finished-meet-ended')).toBe(keys.indexOf('finished/meet-ended') - 1);
    expect(validateConfig(once).ok).toBe(true);
    expect(customizeRule(c, 'user/zz', builtinRecipes())).toBe(c);
  });

  it('customizing again never adds a second copy: the existing one is found (also an older -N duplicate)', async () => {
    const { customizeRule, customizedCopy } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...defaultConfig(), recipes: defaultConfig().recipes.map((r) => ({ ...r, enabled: true })) };
    expect(customizedCopy(c, 'finished/meet-ended', builtinRecipes())).toBeUndefined();
    const once = customizeRule(c, 'finished/meet-ended', builtinRecipes());
    expect(customizeRule(once, 'finished/meet-ended', builtinRecipes())).toBe(once);
    expect(customizedCopy(once, 'finished/meet-ended')?.id).toBe('finished-meet-ended');
    const older = { ...c, rules: [{ ...once.rules[0]!, id: 'finished-meet-ended-2' }] };
    expect(customizedCopy(older, 'finished/meet-ended')?.id).toBe('finished-meet-ended-2');
    expect(customizedCopy(once, 'finished/oauth-callback')).toBeUndefined();
    expect(customizedCopy(once, 'user/finished-meet-ended')).toBeUndefined();
  });

  it('a user rule that only shares the copy id (another name) is not a copy: Customize still makes one', async () => {
    const { customizeRule, customizedCopy } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const mine: Rule = { id: 'github-prs-group-by-repo', name: 'My thing', enabled: true, match: { url: 'x.com/*' }, actions: [] };
    const c = { ...defaultConfig(), rules: [mine], order: ['user/github-prs-group-by-repo'] };
    expect(customizedCopy(c, 'github-prs/group-by-repo', builtinRecipes())).toBeUndefined();
    const next = customizeRule(c, 'github-prs/group-by-repo', builtinRecipes());
    expect(next.rules.map((r) => r.id)).toEqual(['github-prs-group-by-repo', 'github-prs-group-by-repo-2']);
    expect(customizedCopy(next, 'github-prs/group-by-repo', builtinRecipes())?.id).toBe('github-prs-group-by-repo-2');
  });
});

describe('rules-model: form and helpers (M2 T15)', () => {
  it('ruleForm covers url/title match, group, dedupe mode, close, enabled and dryRun; null for nested any', async () => {
    const { ruleForm } = await import('../../src/ui/rules-model');
    const r = { id: 'x', name: 'X', enabled: true, dryRun: true, match: { all: [{ url: 'a.com/*' }, { title: '*Inbox*' }] },
      actions: [{ group: { title: 'A', color: 'blue' } }, { close: { after: '5s', mode: 'suggest' } }] } as Rule;
    expect(ruleForm(r)).toEqual({ name: 'X', enabled: true, dryRun: true, url: 'a.com/*', title: '*Inbox*',
      group: { title: 'A', color: 'blue' }, dedupe: null, close: { after: '5s', mode: 'suggest' } });
    expect(ruleForm({ ...r, match: { any: [{ url: 'a' }, { url: 'b' }] } } as Rule)).toBeNull();
    expect(ruleForm({ ...r, actions: [{ group: { title: 'A', color: '{c}' } }] } as Rule)).toBeNull();
    expect(ruleForm({ ...r, trigger: { on: ['pageText'] } } as Rule)).toBeNull();
  });

  it('patchRuleForm rebuilds match and actions in place and leaves non-form rules alone', async () => {
    const { patchRuleForm, ruleForm } = await import('../../src/ui/rules-model');
    const c = cfg('a');
    const withTitle = patchRuleForm(c, 'a', { title: '*x*' });
    expect(withTitle.rules[0]!.match).toEqual({ all: [{ url: 'a.com/*' }, { title: '*x*' }] });
    const closing = patchRuleForm(withTitle, 'a', { close: { after: '3s' }, dryRun: true });
    expect(closing.rules[0]!.actions).toEqual([{ group: { title: 'a', color: 'blue' } }, { close: { after: '3s' } }]);
    expect(closing.rules[0]!.dryRun).toBe(true);
    const noGroup = patchRuleForm(closing, 'a', { group: null, title: '', dryRun: false });
    expect(noGroup.rules[0]).toEqual({ id: 'a', name: 'a', enabled: true, match: { url: 'a.com/*' }, actions: [{ close: { after: '3s' } }] });
    expect(ruleForm(noGroup.rules[0]!)!.group).toBeNull();
    const odd = { ...defaultConfig(), rules: [{ id: 'x', name: 'X', enabled: true, match: { any: [{ url: 'a' }] }, actions: [{ close: {} }] }], order: [] } as Config;
    expect(patchRuleForm(odd, 'x', { enabled: false })).toBe(odd);
  });

  it('replaceRule swaps a rule by id, renames its order key, and refuses an id that collides', async () => {
    const { replaceRule } = await import('../../src/ui/rules-model');
    const c = cfg('a', 'b');
    const r = replaceRule(c, 'a', { ...c.rules[0]!, id: 'z', name: 'Z' });
    expect(r.ok && r.config.rules.map((x) => x.id)).toEqual(['z', 'b']);
    expect(r.ok && r.config.order).toEqual(['user/z', 'user/b']);
    expect(replaceRule(c, 'a', { ...c.rules[0]!, id: 'b' })).toEqual({ ok: false, error: 'Another rule already has id "b"' });
  });

  it('ruleSummary describes a rule the form cannot show', async () => {
    const { ruleSummary } = await import('../../src/ui/rules-model');
    const r = { id: 'x', name: 'X', enabled: true, match: { any: [{ url: 'a.com/*' }, { title: '*b*' }] },
      actions: [{ close: { after: '2s', mode: 'suggest' } }, { showInView: { view: 'finished' } }] } as Rule;
    expect(ruleSummary(r)).toEqual(['Match: any of (url a.com/*; title *b*)', 'Close after 2s (suggest)', 'Show in view finished']);
  });

  it('ruleSummary describes M3 sources, field conditions and assignProject (M3-R20)', async () => {
    const { ruleSummary } = await import('../../src/ui/rules-model');
    const r = { id: 'x', name: 'X', enabled: true,
      source: { connection: 'github', query: 'github.pull_request', args: {}, fields: { mergedAt: 'mergedAt' } },
      match: { all: [{ url: 'a.com/*' }, { field: { field: 'source.mergedAt', op: '<', value: { ago: '24h' } } }, { field: { field: 'source.state', op: '==', value: 'merged' } }] },
      actions: [{ assignProject: { key: 'ABC-1', create: true } }] } as Rule;
    expect(ruleSummary(r)).toEqual([
      'Match: all of (url a.com/*; source.mergedAt < 24h ago; source.state == "merged")',
      'Source: github.pull_request via the github connection',
      'Assign to project ABC-1 (create it if missing)',
    ]);
    const fb = { ...r, match: { url: 'a.com/*' }, source: undefined, actions: [{ assignProject: { key: '{keyTitle}', fallbackKey: '{keyBranch}' } }] } as Rule;
    expect(ruleSummary(fb).at(-1)).toBe('Assign to project {keyTitle}, else {keyBranch}');
  });

  it('patternHints: exact-path patterns and open-ended host globs', async () => {
    const { patternHints } = await import('../../src/ui/rules-model');
    const EXACT = 'matches only exactly this path; add * to include deeper pages';
    expect(patternHints('https://github.com/:repo')).toEqual([EXACT]);
    expect(patternHints('github.com/acme/repo')).toEqual([EXACT]);
    expect(patternHints('github.com/acme/*')).toEqual([]);
    expect(patternHints('github.com/:owner/:repo*')).toEqual([]);
    expect(patternHints('/^https:\\/\\/a/')).toEqual([]);
    expect(patternHints('https://github.com*')).toEqual(['also matches look-alike hosts such as github.com.evil.com; use github.com/* to match only github.com']);
    expect(patternHints('*.github.com/*')).toEqual([]);
    expect(patternHints('*://*/*')).toEqual([]);
  });

  it('configPatternErrors also checks url and title patterns nested in all/any/not', async () => {
    const c = { ...defaultConfig(), rules: [{ id: 'x', name: 'X', enabled: true, match: { all: [{ url: 'a.com/*' }, { not: { title: '/(/' } }] }, actions: [{ close: {} }] }], order: [] } as Config;
    expect(configPatternErrors(c).map((e) => e.path)).toEqual(['/rules/0/match/all/1/not/title']);
  });
});

describe('rules-model: pre-filled rules (M2 T16)', () => {
  it('addNewRule: a valid rule first in priority, with a readable unique id; the input is not mutated', () => {
    const c = cfg('a');
    const n = addNewRule(c, { kind: 'group', pattern: 'github.com/acme/*', name: 'Group github.com/acme/*', group: { title: 'Acme', color: 'blue' } });
    const r = n.rules.at(-1)!;
    expect(r).toEqual({ id: 'group-github-com-acme', name: 'Group github.com/acme/*', enabled: true, match: { url: 'github.com/acme/*' }, actions: [{ group: { title: 'Acme', color: 'blue' } }] });
    expect(n.order[0]).toBe('user/group-github-com-acme');
    expect(validateConfig(n).ok).toBe(true);
    expect(c.rules).toHaveLength(1);
    const again = addNewRule(n, { kind: 'allowDup', pattern: 'github.com/acme/*', name: 'x' });
    expect(again.rules.at(-1)!.id).toBe('allowdup-github-com-acme');
    expect(again.rules.at(-1)!.actions).toEqual([{ dedupe: { mode: 'off' } }]);
    const close = addNewRule(n, { kind: 'close', pattern: '*.example.com/*', name: 'x', close: { after: '1h', mode: 'auto' } });
    expect(close.rules.at(-1)!.actions).toEqual([{ close: { after: '1h', mode: 'auto' } }]);
    expect(validateConfig(close).ok).toBe(true);
  });

  it('addNewRule into an existing group rule appends the pattern once, keeps order', () => {
    const c = cfg('a');
    const n = addNewRule(c, { kind: 'group', pattern: 'b.com/*', name: 'x', group: { existing: 'a' } });
    expect(n.rules).toHaveLength(1);
    expect(n.rules[0]!.match).toEqual({ url: ['a.com/*', 'b.com/*'] });
    expect(n.order).toEqual(c.order);
    expect(addNewRule(c, { kind: 'group', pattern: 'a.com/*', name: 'x', group: { existing: 'a' } })).toEqual(c);
  });

  it('groupRuleChoices lists form-editable user rules with a group action only', () => {
    const odd = { id: 'odd', name: 'Odd', enabled: true, match: { title: '*x*' }, actions: [{ showInView: { view: 'v' } }] } as Rule;
    const closer = { id: 'cl', name: 'Closer', enabled: true, match: { url: 'c.com/*' }, actions: [{ close: { mode: 'auto' } }] } as Rule;
    const c = { ...cfg('a'), rules: [...cfg('a').rules, odd, closer] };
    expect(groupRuleChoices(c)).toEqual([{ id: 'a', name: 'a', title: 'a' }]);
  });

  it('inactiveReason: a rule whose URL condition has no patterns can never match', async () => {
    const { inactiveReason } = await import('../../src/ui/rules-model');
    const r = (match: Rule['match']): Rule => ({ id: 'x', name: 'x', enabled: true, match, actions: [{ close: {} }] });
    expect(inactiveReason(r({ url: [] }))).toBe('no URL patterns');
    expect(inactiveReason(r({ url: '' }))).toBe('no URL patterns');
    expect(inactiveReason(r({ all: [{ url: 'meet.google.com/*' }, { url: [] }] }))).toBe('no URL patterns');
    expect(inactiveReason(r({ any: [{ url: [] }, { url: [] }] }))).toBe('no URL patterns');
    expect(inactiveReason(r({ any: [] }))).toBe('no conditions');
    expect(inactiveReason(r({ all: [{ url: 'meet.google.com/*' }, { pageText: [] }] }))).toBe('no patterns');
    expect(inactiveReason(r({ pageText: ['', ''] }))).toBe('no patterns');
    expect(inactiveReason(r({ pageText: '' }))).toBe('no patterns');
    expect(inactiveReason(r({ pageText: ['Call ended'] }))).toBeUndefined();
    expect(inactiveReason(r({ opener: { url: [] } }))).toBe('no URL patterns');
    expect(inactiveReason(r({ opener: { url: 'a.com/*' } }))).toBeUndefined();
    expect(inactiveReason(r({ any: [{ url: [] }, { pageText: [] }] }))).toBe('no patterns');
    expect(inactiveReason(r({ any: [{ url: [] }, { url: 'a.com/*' }] }))).toBeUndefined();
    expect(inactiveReason(r({ not: { url: [] } }))).toBeUndefined();
    expect(inactiveReason(r({ url: ['a.com/*'] }))).toBeUndefined();
  });

  it('ruleRuns: consecutive rows of one recipe form a run, split by any other row', async () => {
    const { ruleRuns } = await import('../../src/ui/rules-model');
    const u = (k: string) => ({ key: `user/${k}`, kind: 'user' as const, rule: { id: k } });
    const f = (k: string) => ({ key: `finished/${k}`, kind: 'recipe' as const, recipeId: 'finished' });
    const g = (k: string) => ({ key: `github-prs/${k}`, kind: 'recipe' as const, recipeId: 'github-prs' });
    const runs = ruleRuns([u('a'), f('o'), f('m'), g('r'), f('x'), u('b')] as never);
    expect([...runs.entries()]).toEqual([
      [1, { kind: 'recipe', id: 'finished', start: 1, keys: ['finished/o', 'finished/m'] }],
      [2, { kind: 'recipe', id: 'finished', start: 1, keys: ['finished/o', 'finished/m'] }],
      [3, { kind: 'recipe', id: 'github-prs', start: 3, keys: ['github-prs/r'] }],
      [4, { kind: 'recipe', id: 'finished', start: 4, keys: ['finished/x'] }],
    ]);
  });

  it('ruleRuns: consecutive user rows of one section form a run; a row with neither ends it', async () => {
    const { ruleRuns } = await import('../../src/ui/rules-model');
    const u = (k: string) => ({ key: `user/${k}`, kind: 'user' as const, rule: { id: k } });
    const f = (k: string) => ({ key: `finished/${k}`, kind: 'recipe' as const, recipeId: 'finished' });
    const sectionOf = (id: string) => (id === 'a' || id === 'b' ? 'work' : undefined);
    const runs = ruleRuns([u('a'), u('b'), f('x'), u('c')] as never, sectionOf);
    const work = { kind: 'section', id: 'work', start: 0, keys: ['user/a', 'user/b'] };
    expect([...runs.entries()]).toEqual([[0, work], [1, work], [2, { kind: 'recipe', id: 'finished', start: 2, keys: ['finished/x'] }]]);
    expect(runs.has(3)).toBe(false);
  });
});


describe('rules-model: moving a run as one block (M4 rule sections T2)', () => {
  /** User rules u1, u2 plus Finished's three rules; every other recipe off. */
  const withOnlyFinished = (c: Config): Config => ({ ...c, recipes: c.recipes.map((r) => ({ ...r, enabled: r.id === 'finished' })) });
  const base = () => ({ ...withOnlyFinished(cfg('u1', 'u2')), order: ['user/u1', 'finished/oauth-callback', 'finished/meet-ended', 'user/u2'] });

  it('moveBlock moves the shown rows as one block before a key, keeping their order', async () => {
    const { moveBlock, ruleRows } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const keys = (c: Config) => ruleRows(c, builtinRecipes()).map((r) => r.key);
    const c = base();
    expect(keys(c)).toEqual(['user/u1', 'finished/oauth-callback', 'finished/meet-ended', 'user/u2', 'finished/redirect']);
    const moved = moveBlock(c, ['finished/oauth-callback', 'finished/meet-ended'], 'user/u1', builtinRecipes());
    expect(keys(moved)).toEqual(['finished/oauth-callback', 'finished/meet-ended', 'user/u1', 'user/u2', 'finished/redirect']);
    expect(moved.order).toEqual(['finished/oauth-callback', 'finished/meet-ended', 'user/u1', 'user/u2']); // default tail trimmed
    expect(moved.rules).toBe(c.rules);
    expect(validateConfig(moved).ok).toBe(true);
    expect(c.order).toEqual(['user/u1', 'finished/oauth-callback', 'finished/meet-ended', 'user/u2']);
  });

  it('moveBlock keeps the slots of order entries it does not show (a disabled recipe) in place', async () => {
    const { moveBlock } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...base(), order: ['user/u1', 'github-prs/group-by-repo', 'finished/oauth-callback', 'finished/meet-ended', 'user/u2'] };
    const moved = moveBlock(c, ['finished/oauth-callback', 'finished/meet-ended'], 'user/u1', builtinRecipes());
    expect(moved.order).toEqual(['finished/oauth-callback', 'github-prs/group-by-repo', 'finished/meet-ended', 'user/u1', 'user/u2']);
    expect(moved.order.indexOf('github-prs/group-by-repo')).toBe(1);
  });

  it('moveBlock gathers a split block; no move, a target inside the block or an unknown target returns c', async () => {
    const { moveBlock, ruleRows } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const keys = (c: Config) => ruleRows(c, builtinRecipes()).map((r) => r.key);
    const c = { ...withOnlyFinished(cfg('u1')), order: ['finished/oauth-callback', 'user/u1', 'finished/meet-ended', 'finished/redirect'] };
    const block = ['finished/oauth-callback', 'finished/meet-ended', 'finished/redirect'];
    expect(keys(moveBlock(c, block, null, builtinRecipes()))).toEqual(['user/u1', ...block]);
    expect(keys(moveBlock(c, ['finished/redirect', 'finished/oauth-callback'], 'user/u1', builtinRecipes()))).toEqual([
      'finished/oauth-callback', 'finished/redirect', 'user/u1', 'finished/meet-ended',
    ]); // display order, not argument order
    expect(moveBlock(c, block, 'finished/meet-ended', builtinRecipes())).toBe(c);
    expect(moveBlock(c, ['user/u1'], 'finished/meet-ended', builtinRecipes())).toBe(c);
    expect(moveBlock(c, block, 'nope/x', builtinRecipes())).toBe(c);
    expect(moveBlock(c, ['nope/x'], null, builtinRecipes())).toBe(c);
  });

  it('neighborUnit: the beforeKey that moves a unit past one adjacent unit (a whole run or one row)', async () => {
    const { neighborUnit, ruleRows, ruleRuns } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...base(), order: ['user/u1', 'finished/oauth-callback', 'finished/meet-ended', 'finished/redirect', 'user/u2'] };
    const rows = ruleRows(c, builtinRecipes());
    const runs = ruleRuns(rows);
    expect(neighborUnit(rows, runs, 1, 'down')).toBeNull(); // the run past u2: to the end
    expect(neighborUnit(rows, runs, 1, 'up')).toBe('user/u1');
    expect(neighborUnit(rows, runs, 4, 'up')).toBe('finished/oauth-callback'); // u2 past the whole run
    expect(neighborUnit(rows, runs, 0, 'down')).toBe('user/u2'); // u1 past the whole run
    expect(neighborUnit(rows, runs, 0, 'up')).toBe('user/u1'); // already first: its own key (moveBlock: no change)
  });
});

describe('rules-model: sections (M4 rule sections T3)', () => {
  it('sectionOf maps rule ids to their section', async () => {
    const { sectionOf } = await import('../../src/ui/rules-model');
    const of = sectionOf({ ...cfg('a', 'b'), sections: [{ id: 'work', name: 'Work', rules: ['a'] }] });
    expect(of('a')).toBe('work');
    expect(of('b')).toBeUndefined();
    expect(sectionOf(cfg('a'))('a')).toBeUndefined();
  });

  it('addSection makes an id from the name, suffixed like sanitizeRuleId; renameSection only renames', async () => {
    const { addSection, renameSection } = await import('../../src/ui/rules-model');
    const one = addSection(cfg('a'), 'Work');
    expect(one.sections).toEqual([{ id: 'work', name: 'Work', rules: [] }]);
    const two = addSection(one, 'Work');
    expect(two.sections!.map((s) => s.id)).toEqual(['work', 'work-2']);
    expect(validateConfig(two).ok).toBe(true);
    expect(renameSection(two, 'work-2', 'Home').sections![1]).toEqual({ id: 'work-2', name: 'Home', rules: [] });
    expect(renameSection(two, 'nope', 'X')).toBe(two);
  });

  it('assignSection joins a rule and moves it to the end of the section block; null leaves it in place', async () => {
    const { assignSection, ruleRows } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const c = { ...cfg('a', 'x', 'b', 'c'), order: ['user/a', 'user/x', 'user/b', 'user/c'], sections: [{ id: 'work', name: 'Work', rules: ['a', 'b'] }] };
    const keys = (k: Config) => ruleRows(k, builtinRecipes()).map((r) => r.key).filter((r) => r.startsWith('user/'));
    const joined = assignSection(c, 'c', 'work', builtinRecipes());
    expect(keys(joined)).toEqual(['user/a', 'user/b', 'user/c', 'user/x']);
    expect(joined.sections).toEqual([{ id: 'work', name: 'Work', rules: ['a', 'b', 'c'] }]);
    const left = assignSection(joined, 'b', null, builtinRecipes());
    expect(left.sections).toEqual([{ id: 'work', name: 'Work', rules: ['a', 'c'] }]);
    expect(left.order).toBe(joined.order);
    const moved = assignSection(joined, 'x', 'home', builtinRecipes());
    expect(moved).toBe(joined); // unknown section
  });

  it('deleteSection keeps order byte-identical; removeRule and replaceRule keep membership in step', async () => {
    const { deleteSection, removeRule, replaceRule } = await import('../../src/ui/rules-model');
    const c = { ...cfg('a', 'b'), sections: [{ id: 'work', name: 'Work', rules: ['a', 'b'] }] };
    const d = deleteSection(c, 'work');
    expect(d.order).toBe(c.order);
    expect(d.sections).toEqual([]);
    expect(removeRule(c, 'a').sections).toEqual([{ id: 'work', name: 'Work', rules: ['b'] }]);
    const res = replaceRule(c, 'b', { ...c.rules[1]!, id: 'b2' });
    expect(res.ok && res.config.sections).toEqual([{ id: 'work', name: 'Work', rules: ['a', 'b2'] }]);
  });

  it('customizeRule leaves the new copy without a section', async () => {
    const { customizeRule, sectionOf } = await import('../../src/ui/rules-model');
    const { builtinRecipes } = await import('../../src/recipes/load');
    const base = { ...cfg('a'), recipes: defaultConfig().recipes.map((r) => ({ ...r, enabled: r.id === 'finished' })), sections: [{ id: 'work', name: 'Work', rules: ['a'] }] };
    const out = customizeRule(base, 'finished/oauth-callback', builtinRecipes());
    expect(out.rules).toHaveLength(2);
    expect(sectionOf(out)(out.rules[1]!.id)).toBeUndefined();
  });
});
