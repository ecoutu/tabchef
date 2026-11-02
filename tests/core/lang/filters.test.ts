import { describe, it, expect } from 'vitest';
import { parseTemplate, renderTemplate, TemplateError } from '../../../src/core/match/template';
import { validateConfig, repairConfig } from '../../../src/core/config/schema';
import { defaultConfig } from '../../../src/core/config/defaults';

const colors = { colors: { api: 'green' } };

describe('template filters', () => {
  it('map + default', () => {
    expect(renderTemplate('{repo|map:colors|default:grey}', { repo: 'api' }, colors)).toBe('green');
    expect(renderTemplate('{repo|map:colors|default:grey}', { repo: 'zzz' }, colors)).toBe('grey');
    expect(renderTemplate('{repo|map:nope|default:grey}', { repo: 'api' }, colors)).toBe('grey');
    expect(renderTemplate('{repo|map:colors}', { repo: 'toString' }, colors)).toBe('');
  });
  it('replace is literal, all occurrences, chained left to right', () => {
    expect(renderTemplate('{t|replace:-: |upper}', { t: 'a-b' })).toBe('A B');
    expect(renderTemplate('{t|replace:.:}', { t: 'a.b.c' })).toBe('abc');
    expect(renderTemplate('{t|replace:.*:x}', { t: 'a.*b.*' })).toBe('axbx');
    expect(renderTemplate('{t|trim|lower}', { t: '  AB ' })).toBe('ab');
  });
  it('backslash escapes : | } and \\ in arguments', () => {
    expect(renderTemplate('{t|replace:\\::-}', { t: 'a:b' })).toBe('a-b');
    expect(renderTemplate('{t|replace:\\|:/}', { t: 'a|b' })).toBe('a/b');
    expect(renderTemplate('{t|replace:\\}:]}', { t: 'a}b' })).toBe('a]b');
    expect(renderTemplate('{t|replace:\\\\:/}', { t: 'a\\b' })).toBe('a/b');
    expect(renderTemplate('{t|default:x\\:y}', { t: '' })).toBe('x:y');
  });
  it('unknown filter or bad arity throws TemplateError at parse', () => {
    expect(() => parseTemplate('{a|foo}')).toThrow(new TemplateError('unknown filter: foo'));
    expect(() => parseTemplate('{a|replace:x}')).toThrow(TemplateError);
    expect(() => parseTemplate('{a|toString}')).toThrow('unknown filter: toString');
    expect(parseTemplate('{a|upper} x')).toHaveLength(2);
  });
  it('render never throws on a template with a bad filter: the filter is skipped', () => {
    expect(renderTemplate('{a|foo|upper}', { a: 'v' })).toBe('V');
    expect(renderTemplate('{a|replace:x}', { a: 'v' })).toBe('v');
  });
});

describe('template validation in config', () => {
  const rule = (title: string, color = 'grey') => ({
    id: 'r', name: 'r', enabled: true, match: { url: 'https://*.x.com/:repo' }, actions: [{ group: { title, color } }],
  });
  const cfg = (r: unknown, tables: unknown = {}) => ({ ...structuredClone(defaultConfig()), rules: [r], tables });
  it('rejects unknown filters and unknown tables', () => {
    expect(validateConfig(cfg(rule('{repo|foo}'))).ok).toBe(false);
    expect(validateConfig(cfg(rule('{repo}', '{repo|bar}'))).ok).toBe(false);
    expect(validateConfig(cfg(rule('{repo|map:t}'))).ok).toBe(false);
    expect(validateConfig(cfg(rule('{repo|map:t}'), { t: { a: 'b' } })).ok).toBe(true);
  });
  it('repairConfig disables an enabled rule with an unknown filter', () => {
    const { config } = repairConfig(cfg(rule('{repo|foo}')));
    expect((config as { rules: { enabled: boolean }[] }).rules[0]?.enabled).toBe(false);
  });
});
