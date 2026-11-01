import { describe, it, expect } from 'vitest';
import { validateConfig, configJsonSchema } from '../../../src/core/config/schema';
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
      allowDuplicates: [], scope: 'all-windows', urlTransforms: [],
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
