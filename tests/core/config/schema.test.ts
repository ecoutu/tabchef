import { describe, it, expect } from 'vitest';
import { validateConfig, configJsonSchema, ruleTitleProblems, repairConfig } from '../../../src/core/config/schema';
import { defaultConfig } from '../../../src/core/config/defaults';
import { fillConfigDefaults, groupRuleToRule } from '../../../src/core/config/migrate';
import { validateRule } from '../../../src/core/config/validate-config.generated.js';
import type { Config, GroupRule } from '../../../src/core/types';
import { MAX_REGEX_LEN } from '../../../src/core/match/pattern';

const rule = (over: Record<string, unknown> = {}): GroupRule => ({
  id: 'r1', name: 'GH', enabled: true,
  match: { url: 'https://github.com/*' },
  group: { title: 'GitHub', color: 'blue' },
  ...over,
}) as GroupRule;
/** v2 config holding raw v2 rules (anything, for negative tests). */
const cfgRaw = (rules: unknown[]) => ({ ...defaultConfig(), rules, order: [] });
const cfg = (rules: GroupRule[]): Config => ({ ...defaultConfig(), rules: rules.map((r) => groupRuleToRule(r)), order: rules.map((r) => `user/${r.id}`) });
const v2 = (over: Record<string, unknown> = {}) => ({ id: 'r1', name: 'R', enabled: true, match: { url: 'a.com/*' }, actions: [{ group: { title: 'A', color: 'blue' } }], ...over });

describe('config schema', () => {
  it('defaultConfig passes validation', () => {
    expect(validateConfig(defaultConfig()).ok).toBe(true);
  });
  it('has the specified dedupe defaults', () => {
    expect(defaultConfig().dedupe).toEqual({
      mode: 'always-switch', keep: 'existing', stripFragment: true, ignoreTrailingSlash: true,
      followFragment: true, includeIncognito: false, canonicalizers: [],
      stripParams: ['utm_*', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      allowDuplicates: [], alwaysSwitchSites: [], scope: 'all-windows', urlTransforms: [],
      fragmentOverrides: [], matchTitle: false, titleOverrides: [],
    });
    expect(defaultConfig().version).toBe(2);
  });
  it('defaultConfig returns a fresh object each call', () => {
    expect(defaultConfig()).not.toBe(defaultConfig());
    expect(defaultConfig().dedupe.stripParams).not.toBe(defaultConfig().dedupe.stripParams);
  });
  it('accepts a migrated rule without strict/merge', () => {
    expect(validateConfig(cfg([rule()])).ok).toBe(true);
  });
  it('accepts strict/merge booleans and optional fields', () => {
    const r = validateConfig(cfg([rule({ strict: false, merge: true, sortGroups: 'alphabetical', dedupe: 'off',
      match: { url: ['a', 'b'] }, group: { title: 'x', color: 'red', collapsed: true } })]));
    expect(r.ok).toBe(true);
  });
  it('accepts the full M2 condition and action language', () => {
    const r = validateConfig(cfgRaw([v2({
      dryRun: true, trigger: { on: ['created', 'schedule'], every: '15m' },
      match: { all: [{ url: ['a.com/*'] }, { not: { pinned: true } }, { any: [{ title: '*x*' }, { opener: { group: 'G' } }, { audible: false }] },
        { pageText: ['done'] }, { age: { gt: '1h', lt: '7d' } }] },
      extract: { repo: { from: 'url', regex: '/(?<r>[^/]+)$', group: 'r' }, h: { selector: 'h1', attr: 'title' } },
      actions: [{ group: { title: '{repo}', color: 'blue', anchors: ['https://a.com/'] } }, { dedupe: { mode: 'ask', followFragment: false, keepFragment: true, matchTitle: true } },
        { close: { after: '30s', mode: 'suggest' } }, { showInView: { view: 'finished' } }],
    })]));
    expect(r).toEqual({ ok: true, config: expect.anything() });
  });
  it('rejects discard and notify actions (R26)', () => {
    expect(validateConfig(cfgRaw([v2({ actions: [{ discard: {} }] })])).ok).toBe(false);
    expect(validateConfig(cfgRaw([v2({ actions: [{ notify: { text: 'x' } }] })])).ok).toBe(false);
  });
  it('rejects ids outside the v2 id pattern', () => {
    expect(validateConfig(cfgRaw([v2({ id: 'Has Space' })])).ok).toBe(false);
    expect(validateConfig(cfgRaw([v2({ id: 'a/b' })])).ok).toBe(false);
  });
  it('rejects malformed durations and uncompilable patterns in enabled rules, with JSON-pointer paths', () => {
    const r = validateConfig(cfgRaw([v2({ match: { all: [{ url: '/(/' }, { age: { gt: 'soon' } }] }, actions: [{ close: { after: '5 minutes' } }] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith('/rules/0/match/all/0/url '))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('/rules/0/match/all/1/age/gt '))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('/rules/0/actions/0/close/after '))).toBe(true);
    }
  });
  it('durations accept ms, s, m, h and d, and reject anything else', () => {
    const close = (after: string) => validateConfig(cfgRaw([v2({ actions: [{ close: { after } }] })]));
    for (const d of ['500ms', '30s', '15m', '2h', '1d']) expect(close(d).ok).toBe(true);
    for (const d of ['5', '1.5s', '10mss', '3w', 'ms', '-1s']) expect(close(d)).toEqual({ ok: false, errors: ['/rules/0/actions/0/close/after must be a duration like 500ms, 30s, 15m, 2h or 1d'] });
    expect(validateConfig(cfgRaw([v2({ trigger: { on: ['schedule'], every: '250ms' } })])).ok).toBe(true);
  });
  it('caps title and extract regexes at the shared 500-character limit', () => {
    const body = 'a'.repeat(MAX_REGEX_LEN);
    const title = (t: string) => validateConfig(cfgRaw([v2({ match: { title: t } })]));
    expect(title(`/${'a'.repeat(MAX_REGEX_LEN - 2)}/`).ok).toBe(true);
    expect(title(`/${body}/`)).toEqual({ ok: false, errors: ['/rules/0/match/title regex too long (max 500 characters)'] });
    const extract = (regex: string) => validateConfig(cfgRaw([v2({ extract: { x: { from: 'url', regex } } })]));
    expect(extract(body).ok).toBe(true);
    expect(extract('a'.repeat(10_000))).toEqual({ ok: false, errors: ['/rules/0/extract/x/regex regex too long (max 500 characters)'] });
  });
  it('rejects an invalid extract regex', () => {
    const r = validateConfig(cfgRaw([v2({ extract: { x: { from: 'title', regex: '(' } } })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('/rules/0/extract/x/regex '))).toBe(true);
  });
  it('rejects non-boolean strict', () => {
    expect(validateConfig(cfgRaw([v2({ actions: [{ group: { title: 'A', color: 'blue', strict: 'yes' } }] })])).ok).toBe(false);
  });
  it('rejects invalid color with path', () => {
    const r = validateConfig(cfg([rule({ group: { title: 'x', color: 'magenta' } })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('/rules/0/actions/0/group/color');
  });
  it('error messages name the offending additional property', () => {
    const r = validateConfig(cfgRaw([v2({ bogus: 1 })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('bogus');
  });
  it('rejects version 1 (migrate first) and non-object input', () => {
    expect(validateConfig({ ...defaultConfig(), version: 1 }).ok).toBe(false);
    expect(validateConfig(null).ok).toBe(false);
  });
  it('rejects duplicate rule ids', () => {
    const r = validateConfig(cfgRaw([v2(), v2({ name: 'other' })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('/rules/1/id duplicate rule id: r1');
  });
  it('rejects malformed order keys', () => {
    expect(validateConfig({ ...defaultConfig(), order: ['nokey'] }).ok).toBe(false);
    expect(validateConfig({ ...defaultConfig(), order: ['user/a', 'github-prs/pr'] }).ok).toBe(true);
    expect(validateConfig({ ...defaultConfig(), order: ['user/a', 'user/a'] })).toEqual({ ok: false, errors: ['/order/1 duplicate key: user/a'] });
    expect(validateConfig(cfgRaw([v2({ trigger: { on: ['created', 'created'] } })]))).toEqual({ ok: false, errors: ['/rules/0/trigger/on/1 duplicate trigger: created'] });
  });
  it('rejects invalid urlTransform pattern', () => {
    const c = defaultConfig();
    c.dedupe.urlTransforms = [{ pattern: '(', replacement: '' }];
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('invalid urlTransform pattern: (');
  });
  it('rejects invalid urlTransform flags', () => {
    const c = defaultConfig();
    c.dedupe.urlTransforms = [{ pattern: 'a', replacement: '', flags: 'zz' }];
    expect(validateConfig(c).ok).toBe(false);
  });
  it('accepts valid urlTransform with flags', () => {
    const c = defaultConfig();
    c.dedupe.urlTransforms = [{ pattern: '^http:', replacement: 'https:', flags: 'i' }];
    expect(validateConfig(c).ok).toBe(true);
  });
  it('caps dedupe urlTransforms regexes at MAX_REGEX_LEN (T18)', () => {
    const c = defaultConfig();
    c.dedupe.urlTransforms = [{ pattern: 'a'.repeat(500), replacement: '' }];
    expect(validateConfig(c).ok).toBe(true);
    c.dedupe.urlTransforms = [{ pattern: 'a'.repeat(501), replacement: '' }];
    expect(validateConfig(c)).toEqual({ ok: false, errors: ['/dedupe/urlTransforms/0/pattern regex too long (max 500 characters)'] });
  });
  it('checks fragmentOverrides / titleOverrides patterns (compile, 500-char cap) with JSON paths (T18)', () => {
    const c = defaultConfig();
    c.dedupe.fragmentOverrides = [{ pattern: 'app.example.com/#/*', keepFragment: true }, { pattern: '/(/', keepFragment: false }];
    c.dedupe.titleOverrides = [{ pattern: `a.com/${'x'.repeat(500)}`, matchTitle: true }];
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([expect.stringMatching(/^\/dedupe\/fragmentOverrides\/1\/pattern /), '/dedupe/titleOverrides/0/pattern pattern too long']);
    }
  });
  it('a stored config without the M2 dedupe fields loads (fillConfigDefaults + schema)', () => {
    const d = { ...defaultConfig().dedupe } as Record<string, unknown>;
    delete d.fragmentOverrides; delete d.matchTitle; delete d.titleOverrides;
    const filled = fillConfigDefaults({ ...defaultConfig(), dedupe: d }) as Config;
    expect(filled.dedupe).toMatchObject({ fragmentOverrides: [], matchTitle: false, titleOverrides: [] });
    expect(validateConfig(filled).ok).toBe(true);
  });
  it('repairConfig removes over-long or broken dedupe regexes/patterns from stored data instead of failing the whole config', () => {
    const input = {
      ...defaultConfig(),
      dedupe: {
        ...defaultConfig().dedupe,
        urlTransforms: [{ pattern: 'ok', replacement: '' }, { pattern: 'a'.repeat(600), replacement: '' }, { pattern: '(', replacement: '' }],
        fragmentOverrides: [{ pattern: 'a.com/*', keepFragment: true }, { pattern: 'x'.repeat(600), keepFragment: true }],
        titleOverrides: [{ pattern: '/(/', matchTitle: true }, { pattern: 'b.com/*', matchTitle: false }],
      },
    };
    const r = repairConfig(input);
    expect(validateConfig(r.config).ok).toBe(true);
    const out = (r.config as Config).dedupe;
    expect(out.urlTransforms).toEqual([{ pattern: 'ok', replacement: '' }]);
    expect(out.fragmentOverrides).toEqual([{ pattern: 'a.com/*', keepFragment: true }]);
    expect(out.titleOverrides).toEqual([{ pattern: 'b.com/*', matchTitle: false }]);
    expect(r.warnings).toEqual([expect.stringMatching(/^4 dedupe setting\(s\) removed: urlTransforms\/1 .*urlTransforms.*fragmentOverrides.*titleOverrides/)]);
    expect(input.dedupe.urlTransforms).toHaveLength(3); // input not mutated
  });
  it('exports the JSON schema', () => {
    expect(configJsonSchema).toHaveProperty('properties.version');
  });
  it('exports a standalone rule validator', () => {
    expect(validateRule(v2())).toBe(true);
    expect(validateRule(v2({ actions: [] }))).toBe(false);
  });
});

describe('config schema: group titles (I1)', () => {
  it('rejects an empty group title', () => {
    const r = validateConfig(cfg([rule({ group: { title: '', color: 'blue' } })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('/rules/0/actions/0/group/title '))).toBe(true);
  });
  it('rejects template variables the patterns do not capture', () => {
    const r = validateConfig(cfg([rule({ match: { url: ['github.com/:org/:repo/*', 'example.com/*'] }, group: { title: '{repo}', color: 'blue' } })]));
    expect(r).toEqual({ ok: false, errors: ['/rules/0/actions/0/group/title uses {repo}, which pattern "example.com/*" does not capture'] });
  });
  it('accepts template variables captured by :params or regex named groups', () => {
    expect(validateConfig(cfg([rule({ match: { url: 'github.com/:org/:repo/*' }, group: { title: '{org}/{repo|upper}', color: 'blue' } })])).ok).toBe(true);
    expect(validateConfig(cfg([rule({ match: { url: '/github\\.com\\/(?<owner>[^/]+)/' }, group: { title: '{owner}', color: 'blue' } })])).ok).toBe(true);
  });
  it('accepts template variables named by extract', () => {
    expect(validateConfig(cfgRaw([v2({ extract: { proj: { from: 'title', regex: '^(\\w+)' } }, actions: [{ group: { title: '{proj}', color: 'blue' } }] })])).ok).toBe(true);
  });
  it('ruleTitleProblems reports the same problems for a single rule', () => {
    expect(ruleTitleProblems(groupRuleToRule({ ...rule(), group: { title: '', color: 'blue' } }))).toEqual(['must not be empty']);
    expect(ruleTitleProblems(groupRuleToRule(rule()))).toEqual([]);
  });
  it('accepts template variables named by a title regex group (T3 captures)', () => {
    const match = { all: [{ url: 'a.com/*' }, { title: '/^(?<num>\\d+)/' }] };
    expect(validateConfig(cfgRaw([v2({ match, actions: [{ group: { title: '#{num}', color: 'blue' } }] })])).ok).toBe(true);
  });
  it('rejects a color {var} that nothing provides, accepts a captured one', () => {
    const bad = validateConfig(cfgRaw([v2({ actions: [{ group: { title: 'A', color: '{repo|default:grey}' } }] })]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toEqual(['/rules/0/actions/0/group/color uses {repo}, which pattern "a.com/*" does not capture']);
    expect(validateConfig(cfgRaw([v2({ match: { url: 'a.com/:repo/*' }, actions: [{ group: { title: 'A', color: '{repo|default:grey}' } }] })])).ok).toBe(true);
  });
});

describe('config schema: repairing stored configs (CR#1)', () => {
  const bad = (over: Record<string, unknown> = {}) =>
    rule({ id: 'gh', name: 'GH repos', match: { url: ['github.com/:org/:repo/*', 'example.com/*'] }, group: { title: 'GH {repo}', color: 'blue' }, ...over });
  it('a disabled rule with an empty title or an uncaptured {var} is valid stored data', () => {
    expect(validateConfig(cfg([bad({ enabled: false })])).ok).toBe(true);
    expect(validateConfig(cfg([rule({ enabled: false, group: { title: '', color: 'blue' } })])).ok).toBe(true);
  });
  it('enabled rules with those problems are still rejected (saves, imports)', () => {
    expect(validateConfig(cfg([bad()])).ok).toBe(false);
  });
  it('repairConfig disables (does not drop) enabled rules with title or pattern problems and warns; other rules untouched', () => {
    const ok = rule({ id: 'ok', name: 'Fine' });
    const empty = rule({ id: 'e', name: 'Empty', group: { title: '', color: 'red' } });
    const badPattern = rule({ id: 'p', name: 'Pat', match: { url: '/(/' } });
    const input = cfg([ok, bad(), empty, badPattern]);
    const r = repairConfig(input);
    expect(r.warnings).toEqual(['3 rule(s) disabled: GH repos, Empty, Pat — fix them on the Rules page.']);
    const out = r.config as Config;
    expect(out.rules.map((x) => [x.id, x.enabled])).toEqual([['ok', true], ['gh', false], ['e', false], ['p', false]]);
    expect(validateConfig(r.config).ok).toBe(true);
    expect(input.rules[1]!.enabled).toBe(true); // input not mutated
  });
  it('repairConfig leaves valid and malformed input alone', () => {
    expect(repairConfig(cfg([rule()]))).toEqual({ config: cfg([rule()]), warnings: [] });
    expect(repairConfig(null)).toEqual({ config: null, warnings: [] });
    expect(repairConfig({ rules: [null, { enabled: true }] }).warnings).toEqual([]);
  });
});

describe('config schema: stored user recipe bodies (R41)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    recipe: 'mine', version: 1, name: 'Mine', description: 'My recipe', rules: [v2({ id: 'x' })], ...over,
  });
  const ref = (id: string, b: unknown, enabled = true) => ({ id, enabled, params: {}, source: 'user' as const, body: { ...(b as object), recipe: id } });
  const stored = (recipes: unknown[]) => ({ ...cfg([rule({ id: 'ok', name: 'Fine' })]), recipes });

  it('a body that fails the recipe schema (over-long string, unknown field) loads: that recipe is disabled with its error, the rest untouched', () => {
    const input = stored([
      ref('long', body({ description: 'x'.repeat(5000) })),
      ref('extra', body({ eval: 'x' })),
      ref('good', body()),
      { id: 'duplicates', enabled: true, params: {}, source: 'builtin' },
    ]);
    const r = repairConfig(input);
    expect(validateConfig(r.config).ok).toBe(true);
    const out = r.config as Config;
    expect(out.recipes.map((x) => [x.id, x.enabled])).toEqual([['long', false], ['extra', false], ['good', true], ['duplicates', true]]);
    expect(out.recipes[0]!.body).toEqual((input.recipes[0] as { body: unknown }).body); // kept, not dropped
    expect(out.rules).toEqual(input.rules);
    expect(r.warnings).toEqual([expect.stringMatching(/2 recipe\(s\) disabled: long \(\/description .*2048.*\), extra \(\/ .*eval.*\)/)]);
    expect((input.recipes[0] as { enabled: boolean }).enabled).toBe(true); // input not mutated
  });
  it('a body that fails the TS post-checks (regex that does not compile) is disabled too', () => {
    const r = repairConfig(stored([ref('re', body({ rules: [v2({ extract: { n: { from: 'url', regex: '((' } } })] }))]));
    expect((r.config as Config).recipes[0]!.enabled).toBe(false);
    expect(r.warnings.join()).toMatch(/re \(\/rules\/0\/extract\/n\/regex invalid regex/);
  });
  it('a valid body stays enabled with no warning', () => {
    const input = stored([ref('good', body())]);
    expect(repairConfig(input)).toEqual({ config: input, warnings: [] });
  });
  it('stored config keeps recipes[].body loose: an invalid body never fails the config schema', () => {
    expect(validateConfig(stored([ref('long', body({ description: 'x'.repeat(5000) }), false)])).ok).toBe(true);
  });
  it('validateConfig (saves, imports) rejects an enabled recipe whose body is invalid', () => {
    const r = validateConfig(stored([ref('extra', body({ eval: 'x' }))]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([expect.stringMatching(/^\/recipes\/0\/body .*eval/)]);
  });
});

describe('RecipeRef.ruleEnabled (R56)', () => {
  it('an old config without the field validates; the field is a map of rule id → boolean', () => {
    expect(validateConfig(defaultConfig()).ok).toBe(true);
    const c = defaultConfig();
    c.recipes = c.recipes.map((r) => (r.id === 'finished' ? { ...r, ruleEnabled: { 'meet-ended': false } } : r));
    expect(validateConfig(c).ok).toBe(true);
    expect(validateConfig({ ...c, recipes: c.recipes.map((r) => ({ ...r, ruleEnabled: { 'Bad Id!': true } })) }).ok).toBe(false);
    expect(validateConfig({ ...c, recipes: c.recipes.map((r) => ({ ...r, ruleEnabled: { ok: 'yes' } })) }).ok).toBe(false);
    expect(validateConfig({ ...c, recipes: c.recipes.map((r) => ({ ...r, disabledRules: ['x'] })) }).ok).toBe(false); // R55 field removed
  });
});

describe('age conditions are accepted (M3-R6, was R66)', () => {
  const AGE_RULE = { all: [{ url: 'example.com/*' }, { not: { age: { lt: '1h' } } }] };
  it('validateConfig accepts an enabled rule using age anywhere in the tree', () => {
    expect(validateConfig(cfgRaw([v2({ match: AGE_RULE, actions: [{ close: { after: '3s' } }] })])).ok).toBe(true);
    expect(validateConfig(cfgRaw([v2({ match: { opener: { age: { gt: '1m' } } } })])).ok).toBe(true);
    expect(validateConfig(cfgRaw([v2({ match: { any: [{ age: { gt: '1m' } }] } })])).ok).toBe(true);
  });
  it('bad age durations are still rejected', () => {
    const r = validateConfig(cfgRaw([v2({ match: { not: { age: { lt: '1 hour' } } } })]));
    expect(r).toEqual({ ok: false, errors: [expect.stringMatching(/^\/rules\/0\/match\/not\/age\/lt must be a duration/)] });
  });
  it('repairConfig keeps an enabled age rule enabled, and leaves an M2-disabled one disabled', () => {
    const r = repairConfig(cfgRaw([v2({ match: AGE_RULE }), v2({ id: 'old', name: 'Old', enabled: false, match: AGE_RULE })]));
    const rules = (r.config as { rules: { id: string; enabled: boolean }[] }).rules;
    expect(rules.map((x) => [x.id, x.enabled])).toEqual([['r1', true], ['old', false]]);
    expect(r.warnings).toEqual([]);
  });
});

describe('nested-quantifier regexes in stored config (R67)', () => {
  it('validateConfig rejects them in rule title / url / extract regexes', () => {
    for (const over of [
      { match: { title: '/(a+)+$/' } }, { match: { url: '/(a+)+$/' } },
      { extract: { n: { from: 'title', regex: '(a+)+$' } }, match: { url: 'a.com/*' } },
    ]) {
      const r = validateConfig(cfgRaw([v2(over)]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join()).toMatch(/regex may be too slow/);
    }
  });
  it('repairConfig disables such a rule and drops such dedupe entries, with warnings, and the result validates', () => {
    const input = {
      ...cfgRaw([v2({ match: { title: '/(a+)+$/' } }), v2({ id: 'ok', name: 'OK' })]),
      dedupe: {
        ...defaultConfig().dedupe,
        urlTransforms: [{ pattern: '(x+)+y', replacement: '' }, { pattern: 'ok', replacement: '' }],
        fragmentOverrides: [{ pattern: '/(a|aa)+/', keepFragment: true }],
        titleOverrides: [{ pattern: 'b.com/*', matchTitle: true }],
      },
    };
    const r = repairConfig(input);
    const out = r.config as Config;
    expect(out.rules.map((x) => [x.id, x.enabled])).toEqual([['r1', false], ['ok', true]]);
    expect(out.dedupe.urlTransforms).toEqual([{ pattern: 'ok', replacement: '' }]);
    expect(out.dedupe.fragmentOverrides).toEqual([]);
    expect(out.dedupe.titleOverrides).toEqual([{ pattern: 'b.com/*', matchTitle: true }]);
    expect(r.warnings).toEqual([expect.stringContaining('1 rule(s) disabled'), expect.stringMatching(/2 dedupe setting\(s\) removed: .*too slow/)]);
    expect(validateConfig(r.config).ok).toBe(true);
  });
});

describe('pageText needles and extract names are capped in TS (I2)', () => {
  it('validateConfig rejects an enabled rule with a pageText needle over 500 chars or an extract name over 64', () => {
    const r1 = validateConfig(cfgRaw([v2({ match: { all: [{ url: 'a.com/*' }, { pageText: ['ok', 'x'.repeat(501)] }] } })]));
    expect(r1).toEqual({ ok: false, errors: ['/rules/0/match/all/1/pageText/1 must be at most 500 characters'] });
    const r2 = validateConfig(cfgRaw([v2({ match: { not: { pageText: 'x'.repeat(501) } } })]));
    expect(r2).toEqual({ ok: false, errors: ['/rules/0/match/not/pageText must be at most 500 characters'] });
    const name = 'n'.repeat(65);
    const r3 = validateConfig(cfgRaw([v2({ extract: { [name]: { selector: 'h1' } } })]));
    expect(r3).toEqual({ ok: false, errors: [`/rules/0/extract/${name} extract name too long (max 64 characters)`] });
    expect(validateConfig(cfgRaw([v2({ match: { pageText: 'x'.repeat(500) }, extract: { ['n'.repeat(64)]: { selector: 'h1' } } })])).ok).toBe(true);
  });
  it('repairConfig disables a stored rule over the caps instead of failing the config', () => {
    const r = repairConfig(cfgRaw([v2({ match: { pageText: 'x'.repeat(501) } })]));
    expect((r.config as Config).rules[0]!.enabled).toBe(false);
    expect(validateConfig(r.config).ok).toBe(true);
  });
});


// Regression guard (M3-R33): held before connections existed. Connection metadata and tokens must never fit in Config, so
// they cannot reach storage.sync; config.schema.json's top-level additionalProperties:false enforces it.
describe('connections stay out of Config (regression guard)', () => {
  it('rejects a top-level connections key', () => {
    const c = { ...defaultConfig(), connections: [{ id: 'github', token: 'ghu_ABCDEFGHIJKLMN' }] };
    expect(validateConfig(c).ok).toBe(false);
  });
});

describe('config schema: rule sections (M4 rule sections T3)', () => {
  const three = () => ({ ...defaultConfig(), rules: ['a', 'b', 'c'].map((id) => v2({ id })), order: ['user/a', 'user/b', 'user/c'] });

  it('a config without sections validates and round-trips unchanged (older synced configs)', () => {
    const c = three();
    const r = validateConfig(c);
    expect(r.ok).toBe(true);
    expect(r.ok && r.config).toEqual(c);
    expect('sections' in (repairConfig(c).config as object)).toBe(false);
    expect(repairConfig(c).warnings).toEqual([]);
  });

  it('accepts sections of rule ids; rejects unknown fields, bad ids, an empty name, a duplicate section id or a rule claimed twice', () => {
    const c = (sections: unknown) => ({ ...three(), sections });
    expect(validateConfig(c([{ id: 'work', name: 'Work', rules: ['a', 'b'] }])).ok).toBe(true);
    expect(validateConfig(c([{ id: 'work', name: 'Work', rules: [], extra: 1 }])).ok).toBe(false);
    expect(validateConfig(c([{ id: 'Work!', name: 'Work', rules: [] }])).ok).toBe(false);
    expect(validateConfig(c([{ id: 'work', name: '', rules: [] }])).ok).toBe(false);
    expect(validateConfig(c([{ id: 'work', name: 'x'.repeat(81), rules: [] }])).ok).toBe(false);
    const dupId = validateConfig(c([{ id: 'work', name: 'A', rules: [] }, { id: 'work', name: 'B', rules: [] }]));
    expect(!dupId.ok && dupId.errors).toEqual(['/sections/1/id duplicate section id: work']);
    const twice = validateConfig(c([{ id: 'work', name: 'A', rules: ['a'] }, { id: 'home', name: 'B', rules: ['a'] }]));
    expect(!twice.ok && twice.errors).toEqual(['/sections/1/rules/0 rule a is already in section work']);
  });

  it('repairConfig drops unknown rule ids, keeps the first claim, drops empty-named sections, and warns', () => {
    const input = {
      ...three(),
      sections: [
        { id: 'work', name: 'Work', rules: ['a', 'ghost', 'b'] },
        { id: 'home', name: 'Home', rules: ['a', 'c'] },
        { id: 'blank', name: '', rules: [] },
        { id: 'work', name: 'Again', rules: [] },
      ],
    };
    const r = repairConfig(input);
    expect((r.config as Config).sections).toEqual([{ id: 'work', name: 'Work', rules: ['a', 'b'] }, { id: 'home', name: 'Home', rules: ['c'] }]);
    expect(r.warnings).toEqual(['Rule sections repaired: unknown rule ghost dropped from Work; rule a kept only in Work; section blank dropped (no name); duplicate section work dropped.']);
    expect(validateConfig(r.config).ok).toBe(true);
  });
});
