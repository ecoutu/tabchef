import { describe, it, expect } from 'vitest';
import { validateConfig, configJsonSchema, ruleTitleProblems, repairConfig } from '../../../src/core/config/schema';
import { defaultConfig } from '../../../src/core/config/defaults';

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1', name: 'GH', enabled: true,
  match: { url: 'https://github.com/*' },
  group: { title: 'GitHub', color: 'blue' },
  ...over,
});
const cfg = (rules: unknown[]) => ({ ...defaultConfig(), groupRules: rules });

describe('config schema', () => {
  it('defaultConfig passes validation', () => {
    const r = validateConfig(defaultConfig());
    expect(r.ok).toBe(true);
  });
  it('has the specified dedupe defaults', () => {
    expect(defaultConfig().dedupe).toEqual({
      mode: 'always-switch', keep: 'existing', stripFragment: true, ignoreTrailingSlash: true,
      followFragment: true, includeIncognito: false, canonicalizers: ['githubPr'],
      stripParams: ['utm_*', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'],
      allowDuplicates: [], alwaysSwitchSites: [], scope: 'all-windows', urlTransforms: [],
    });
    expect(defaultConfig().version).toBe(1);
  });
  it('defaultConfig returns a fresh object each call', () => {
    expect(defaultConfig()).not.toBe(defaultConfig());
    expect(defaultConfig().dedupe.stripParams).not.toBe(defaultConfig().dedupe.stripParams);
  });
  it('accepts a rule without strict/merge', () => {
    expect(validateConfig(cfg([rule()])).ok).toBe(true);
  });
  it('accepts strict/merge booleans and optional fields', () => {
    const r = validateConfig(cfg([rule({ strict: false, merge: true, sortGroups: 'alphabetical', dedupe: 'off',
      match: { url: ['a', 'b'] }, group: { title: 'x', color: 'red', collapsed: true } })]));
    expect(r.ok).toBe(true);
  });
  it('rejects non-boolean strict', () => {
    expect(validateConfig(cfg([rule({ strict: 'yes' })])).ok).toBe(false);
  });
  it('rejects invalid color with path', () => {
    const r = validateConfig(cfg([rule({ group: { title: 'x', color: 'magenta' } })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('/groupRules/0/group/color');
  });
  it('rejects version 2', () => {
    expect(validateConfig({ ...defaultConfig(), version: 2 }).ok).toBe(false);
  });
  it('rejects non-object input', () => {
    expect(validateConfig(null).ok).toBe(false);
  });
  it('rejects duplicate rule ids', () => {
    const r = validateConfig(cfg([rule(), rule({ name: 'other' })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('duplicate rule id: r1');
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
});

describe('config schema: group titles (I1)', () => {
  it('rejects an empty group title', () => {
    const r = validateConfig(cfg([rule({ group: { title: '', color: 'blue' } })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('/groupRules/0/group/title '))).toBe(true);
  });
  it('rejects template variables the patterns do not capture', () => {
    const r = validateConfig(cfg([rule({ match: { url: ['github.com/:org/:repo/*', 'example.com/*'] }, group: { title: '{repo}', color: 'blue' } })]));
    expect(r).toEqual({ ok: false, errors: ['/groupRules/0/group/title uses {repo}, which pattern "example.com/*" does not capture'] });
  });
  it('accepts template variables captured by :params or regex named groups', () => {
    expect(validateConfig(cfg([rule({ match: { url: 'github.com/:org/:repo/*' }, group: { title: '{org}/{repo|upper}', color: 'blue' } })])).ok).toBe(true);
    expect(validateConfig(cfg([rule({ match: { url: '/github\\.com\\/(?<owner>[^/]+)/' }, group: { title: '{owner}', color: 'blue' } })])).ok).toBe(true);
  });
  it('ruleTitleProblems reports the same problems for a single rule', () => {
    expect(ruleTitleProblems({ ...rule(), group: { title: '', color: 'blue' } } as never)).toEqual(['must not be empty']);
    expect(ruleTitleProblems(rule() as never)).toEqual([]);
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
  it('repairConfig disables (does not drop) enabled rules with title problems and warns; other rules untouched', () => {
    const ok = rule({ id: 'ok', name: 'Fine' });
    const empty = rule({ id: 'e', name: 'Empty', group: { title: '', color: 'red' } });
    const input = cfg([ok, bad(), empty]);
    const r = repairConfig(input);
    expect(r.warnings).toEqual(['2 rule(s) disabled: GH repos, Empty — fix them on the Rules page.']);
    const out = r.config as { groupRules: { id: string; enabled: boolean }[] };
    expect(out.groupRules.map((x) => [x.id, x.enabled])).toEqual([['ok', true], ['gh', false], ['e', false]]);
    expect(validateConfig(r.config).ok).toBe(true);
    expect((input.groupRules[1] as { enabled: boolean }).enabled).toBe(true); // input not mutated
  });
  it('repairConfig leaves valid and malformed input alone', () => {
    expect(repairConfig(cfg([rule()]))).toEqual({ config: cfg([rule()]), warnings: [] });
    expect(repairConfig(null)).toEqual({ config: null, warnings: [] });
    expect(repairConfig({ groupRules: [null, { enabled: true }] }).warnings).toEqual([]);
  });
});
