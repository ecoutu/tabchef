import { describe, it, expect } from 'vitest';
import { validateConfig, configJsonSchema, ruleTitleProblems, repairConfig } from '../../../src/core/config/schema';
import { defaultConfig } from '../../../src/core/config/defaults';
import { groupRuleToRule } from '../../../src/core/config/migrate';
import { validateRule } from '../../../src/core/config/validate-config.generated.js';
import type { Config, GroupRule } from '../../../src/core/types';

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
      followFragment: true, includeIncognito: false, canonicalizers: ['githubPr'],
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
        { age: { gt: '1h', lt: '2d' } }, { pageText: ['done'] }] },
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
