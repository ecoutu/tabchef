import { describe, expect, it } from 'vitest';
import raw from '../../../fixtures/auto-group-tabs.json?raw';
import { importAutoGroupTabs } from '../../../src/core/import/auto-group-tabs';
import { groupRuleToRule, sanitizeRuleId, userKey } from '../../../src/core/config/migrate';
import { defaultConfig } from '../../../src/core/config/defaults';
import { validateConfig } from '../../../src/core/config/schema';
import { compileProgram } from '../../../src/core/lang/compile';
import { evaluateTab } from '../../../src/core/lang/evaluate';
import { validateRule } from '../../../src/core/lang/schema';
import { applyCollapse, suggestCollapse, type CollapseSuggestion } from '../../../src/core/lang/collapse';
import type { Rule } from '../../../src/core/lang/types';
import type { Config, TabSnap } from '../../../src/core/types';

const NOW = 1_800_000_000_000;

/** The sanitized fixture, imported then migrated (as import.preview / import.apply do, D27). */
async function fixtureRules(): Promise<Rule[]> {
  const imp = await importAutoGroupTabs(JSON.parse(raw));
  const ids = new Set<string>();
  return imp.rules.map((g) => groupRuleToRule(g, sanitizeRuleId(g.id, ids)));
}

const config = (rules: Rule[], tables: Config['tables'] = {}): Config => ({
  ...defaultConfig(), recipes: [], rules, order: rules.map((r) => userKey(r.id)), tables,
});
const tab = (url: string): TabSnap => ({
  id: 1, windowId: 1, index: 0, url, title: 't', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false,
});
function outcome(c: Config, url: string): { title?: string; color?: string } {
  const { program, errors } = compileProgram(c, {});
  expect(errors).toEqual([]);
  const g = evaluateTab(program, { tab: tab(url) }, NOW).group;
  return { title: g?.title, color: g?.color };
}

const r = (id: string, url: string, title: string, color: string, more: object = {}): Rule => ({
  id, name: title, enabled: true, match: { url: [url] }, actions: [{ group: { title, color, strict: true, merge: true, ...more } }],
});

const REPOS = Array.from({ length: 10 }, (_, i) => `repo-${i + 1}`);
const PATTERN = `/^https:\\/\\/github\\.com\\/acme\\/(?<repo>${REPOS.join('|')}).*$/i`;

describe('suggestCollapse: the sanitized Auto-Group Tabs fixture', () => {
  it('suggests exactly one collapse, replacing rules 1-10', async () => {
    const rules = await fixtureRules();
    const s = suggestCollapse(rules);
    expect(s).toHaveLength(1);
    expect(s[0]!.replaces).toEqual(rules.slice(0, 10).map((x) => x.id));
  });

  it('emits an ordered alternation regex, a {repo} title and a mapped color with the most common color as default', async () => {
    const s = suggestCollapse(await fixtureRules())[0]!;
    expect(s.rule.id).toBe('collapsed-repo');
    expect(s.rule.match).toEqual({ url: [PATTERN] });
    const g = (s.rule.actions[0] as { group: { title: string; color: string; strict?: boolean; merge?: boolean } }).group;
    expect(g.title).toBe('{repo|lower}');
    expect(g.color).toBe('{repo|lower|map:repoColors|default:cyan}');
    expect(g).toMatchObject({ strict: true, merge: true });
    expect(s.table).toEqual({
      name: 'repoColors',
      entries: {
        'repo-1': 'green', 'repo-2': 'green', 'repo-3': 'pink', 'repo-4': 'pink', 'repo-5': 'cyan',
        'repo-6': 'cyan', 'repo-7': 'cyan', 'repo-8': 'cyan', 'repo-9': 'grey', 'repo-10': 'grey',
      },
    });
    expect(validateRule(s.rule).ok).toBe(true);
  });

  it('notes the shadowing that collapsing preserves: repo-10 tabs currently go to repo-1', async () => {
    const s = suggestCollapse(await fixtureRules())[0]!;
    expect(s.notes).toEqual(['repo-10 tabs currently go to repo-1']);
  });

  it('applying it keeps every outcome: each repo, Github Acme and Github Other, in the same order', async () => {
    const rules = await fixtureRules();
    const s = suggestCollapse(rules)[0]!;
    const before = config(rules);
    const after = applyCollapse(rules, {}, [s]);
    const next = config(after.rules, after.tables);
    expect(validateConfig(next).ok).toBe(true);
    expect(after.rules.map((x) => x.name)).toEqual([s.rule.name, 'Github Acme', 'Github Other', 'GCP']);
    expect(after.rules.slice(1)).toEqual(rules.slice(10));
    const urls = [
      ...REPOS.map((x) => `https://github.com/acme/${x}/pull/1`),
      'https://github.com/acme/repo-10', 'https://github.com/acme/repo-1abc', 'https://GitHub.com/acme/repo-3/issues',
      'https://github.com/acme/other', 'https://github.com/acme', 'https://github.com/zzz/repo-1',
      'https://gist.github.com/acme/repo-1', 'http://github.com/acme/repo-1', 'https://console.cloud.google.com/x',
    ];
    for (const u of urls) expect({ u, ...outcome(next, u) }).toEqual({ u, ...outcome(before, u) });
    expect(outcome(next, 'https://github.com/acme/repo-10/x')).toEqual({ title: 'repo-1', color: 'green' });
    expect(outcome(next, 'https://github.com/acme/other')).toEqual({ title: 'Github Acme', color: 'purple' });
  });

  it('keeps upper-case URL variants on the same group as before', async () => {
    const rules = await fixtureRules();
    const after = applyCollapse(rules, {}, suggestCollapse(rules));
    const u = 'https://github.com/ACME/Repo-3/pulls';
    expect(outcome(config(after.rules, after.tables), u)).toEqual(outcome(config(rules), u));
    expect(outcome(config(rules), u)).toEqual({ title: 'repo-3', color: 'pink' });
  });
});

describe('suggestCollapse: detection', () => {
  const run = (n: number, more: (i: number) => object = () => ({})) =>
    Array.from({ length: n }, (_, i) => r(`r${i}`, `https://h.example/org/app${i}*`, `app${i}`, 'blue', more(i)));

  it('a run of 2 gives no suggestion', () => {
    expect(suggestCollapse(run(2))).toEqual([]);
  });

  it('differing merge values give no suggestion', () => {
    expect(suggestCollapse(run(3, (i) => ({ merge: i !== 1 })))).toEqual([]);
  });

  it('differing strict or collapsed values give no suggestion', () => {
    expect(suggestCollapse(run(3, (i) => ({ strict: i === 0 })))).toEqual([]);
    expect(suggestCollapse(run(3, (i) => ({ collapsed: i === 2 })))).toEqual([]);
  });

  it('runs must be contiguous', () => {
    const rules = run(4);
    rules.splice(2, 0, r('mid', 'https://other.example/*', 'Other', 'red'));
    expect(suggestCollapse(rules)).toEqual([]);
  });

  it('titles must equal the varying segment', () => {
    const rules = run(3);
    (rules[1]!.actions[0] as { group: { title: string } }).group.title = 'App 1';
    expect(suggestCollapse(rules)).toEqual([]);
  });

  it('needs one url pattern and a single group action per rule', () => {
    const two = run(3);
    two[0]!.match = { url: ['https://h.example/org/app0*', 'https://x.example/*'] };
    expect(suggestCollapse(two)).toEqual([]);
    const dedupe = run(3);
    dedupe[1]!.actions.push({ dedupe: { mode: 'off' } });
    expect(suggestCollapse(dedupe)).toEqual([]);
  });

  it('patterns must differ in exactly one path segment', () => {
    const rules = [
      r('a', 'https://h.example/a/x*', 'x', 'blue'),
      r('b', 'https://h.example/b/y*', 'y', 'blue'),
      r('c', 'https://h.example/c/z*', 'z', 'blue'),
    ];
    expect(suggestCollapse(rules)).toEqual([]);
  });

  it('a middle segment varies too; the literal tail after it is kept', () => {
    const rules = ['web', 'api', 'cli'].map((x) => r(x, `https://h.example/org/${x}/issues*`, x, x === 'cli' ? 'red' : 'blue'));
    const s = suggestCollapse(rules);
    expect(s).toHaveLength(1);
    expect(s[0]!.rule.match).toEqual({ url: ['/^https:\\/\\/h\\.example\\/org\\/(?<org>web|api|cli)\\/issues.*$/i'] });
    expect(s[0]!.rule.id).toBe('collapsed-org');
    expect(s[0]!.notes).toEqual([]);
  });

  it('escapes regex metacharacters in segments', () => {
    const segs = ['a.b', 'a_b', 'a~b'];
    const s = suggestCollapse(segs.map((x, i) => r(`r${i}`, `https://h.example/p/${x}*`, x, 'blue')));
    expect(s).toHaveLength(1);
    const src = (s[0]!.rule.match as { url: string[] }).url[0]!;
    expect(src).toContain('(?<p>a\\.b|a_b|a~b)');
    const after = applyCollapse(s[0]!.replaces.map((id, i) => r(id, `https://h.example/p/${segs[i]}*`, segs[i]!, 'blue')), {}, s);
    expect(outcome(config(after.rules, after.tables), 'https://h.example/p/aXb')).toEqual({ title: undefined, color: undefined });
    expect(outcome(config(after.rules, after.tables), 'https://h.example/p/a.b/1')).toEqual({ title: 'a.b', color: 'blue' });
  });

  it('a regex over 500 characters gives no suggestion', () => {
    const long = Array.from({ length: 40 }, (_, i) => r(`r${i}`, `https://h.example/org/project-number-${i}*`, `project-number-${i}`, 'blue'));
    expect(suggestCollapse(long)).toEqual([]);
  });

  it('skips regex patterns, templated titles and non-literal globs', () => {
    expect(suggestCollapse([0, 1, 2].map((i) => r(`r${i}`, `/^https:\\/\\/h\\/a${i}/`, `a${i}`, 'blue')))).toEqual([]);
    expect(suggestCollapse([0, 1, 2].map((i) => r(`r${i}`, `https://h.example/*/a${i}*`, `a${i}`, 'blue')))).toEqual([]);
    expect(suggestCollapse([0, 1, 2].map((i) => r(`r${i}`, `https://h.example/:x/a${i}*`, `a${i}`, 'blue')))).toEqual([]);
  });

  it('avoids collisions with existing rule ids and tables', () => {
    const rules = [r('collapsed-app', 'https://z.example/*', 'Z', 'red'), ...run(3)];
    const s = suggestCollapse(rules, { tables: ['appColors'] });
    expect(s).toHaveLength(1);
    expect(s[0]!.rule.id).toBe('collapsed-app-2');
    expect(s[0]!.table.name).toBe('appColors2');
    expect(validateRule(s[0]!.rule).ok).toBe(true);
  });

  it('two separate runs get two suggestions with distinct ids and tables; applying a subset keeps the rest', () => {
    const a = ['a1', 'a2', 'a3'].map((x) => r(x, `https://h.example/one/${x}*`, x, 'blue'));
    const b = ['b1', 'b2', 'b3'].map((x) => r(x, `https://h.example/two/${x}*`, x, 'red'));
    const rules = [...a, r('mid', 'https://m.example/*', 'M', 'grey'), ...b];
    const s: CollapseSuggestion[] = suggestCollapse(rules);
    expect(s.map((x) => x.replaces)).toEqual([['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']]);
    expect(new Set(s.map((x) => x.rule.id)).size).toBe(2);
    expect(new Set(s.map((x) => x.table.name)).size).toBe(2);
    const only2 = applyCollapse(rules, { keep: { x: 'y' } }, [s[1]!]);
    expect(only2.rules.map((x) => x.id)).toEqual(['a1', 'a2', 'a3', 'mid', s[1]!.rule.id]);
    expect(only2.tables).toEqual({ keep: { x: 'y' }, [s[1]!.table.name]: s[1]!.table.entries });
  });
});
