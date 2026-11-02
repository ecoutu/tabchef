import { describe, it, expect } from 'vitest';
import { manifestConfig } from '../../../wxt.config';
import {
  matchPatternProblem, recipeJsonSchema, ruleJsonSchema, validateRecipe, validateRule,
} from '../../../src/core/lang/schema';
import type { Recipe, Rule } from '../../../src/core/lang/types';

const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r', name: 'R', enabled: true, match: { url: 'github.com/*' }, actions: [{ group: { title: 'GH', color: 'blue' } }], ...over,
});
const recipe = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipe: 'demo', version: 1, name: 'Demo', description: 'A demo', rules: [rule()], ...over,
});
type Err = { path: string; message: string };
const errorsOf = (r: ReturnType<typeof validateRecipe> | ReturnType<typeof validateRule>): Err[] => (r.ok ? [] : r.errors);
const at = (r: ReturnType<typeof validateRecipe> | ReturnType<typeof validateRule>, path: string) => errorsOf(r).filter((e) => e.path === path);

describe('validateRecipe: schema (Review Focus #3)', () => {
  it('accepts a minimal recipe and returns it', () => {
    const r = validateRecipe(recipe());
    expect(r).toEqual({ ok: true, recipe: recipe() as unknown as Recipe });
  });
  it('a Cond with two keys is an error at its path', () => {
    const r = validateRecipe(recipe({ rules: [rule({ match: { url: 'a', title: 'b' } })] }));
    expect(at(r, '/rules/0/match').length).toBeGreaterThan(0);
  });
  it('an unknown action key is an error naming the key', () => {
    const r = validateRecipe(recipe({ rules: [rule({ actions: [{ eval: 'x' }] })] }));
    expect(at(r, '/rules/0/actions/0').some((e) => /eval/.test(e.message))).toBe(true);
  });
  it('no discard or notify actions (R26)', () => {
    for (const a of [{ discard: {} }, { notify: { text: 'x' } }]) {
      const r = validateRecipe(recipe({ rules: [rule({ actions: [a] })] }));
      expect(r.ok).toBe(false);
    }
  });
  it('a regex that does not compile is an error at its path', () => {
    const r = validateRecipe(recipe({ rules: [rule({ extract: { n: { from: 'url', regex: '((' } } })] }));
    expect(at(r, '/rules/0/extract/n/regex').map((e) => e.message)).toEqual([expect.stringMatching(/invalid regex/)]);
  });
  it('a 10 KB regex is a maxLength error', () => {
    const r = validateRecipe(recipe({ rules: [rule({ extract: { n: { from: 'url', regex: 'a'.repeat(10_240) } } })] }));
    expect(at(r, '/rules/0/extract/n/regex').some((e) => /must NOT have more than 500 characters/.test(e.message))).toBe(true);
  });
  it('a 10 KB title regex pattern is rejected', () => {
    const r = validateRecipe(recipe({ rules: [rule({ match: { title: `/${'a'.repeat(10_240)}/` } })] }));
    expect(at(r, '/rules/0/match/title').length).toBeGreaterThan(0);
  });
  it('strings are at most 2,048 characters', () => {
    const r = validateRecipe(recipe({ description: 'x'.repeat(2049) }));
    expect(at(r, '/description').some((e) => /2048/.test(e.message))).toBe(true);
    expect(validateRecipe(recipe({ description: 'x'.repeat(2048) })).ok).toBe(true);
    expect(at(validateRecipe(recipe({ rules: [rule({ name: 'x'.repeat(2049) })] })), '/rules/0/name').some((e) => /2048/.test(e.message))).toBe(true);
  });
  it('a bad URL pattern is an error at its path', () => {
    const r = validateRecipe(recipe({ rules: [rule({ match: { url: ['ok.com/*', 'a.com/(x)'] } })] }));
    expect(at(r, '/rules/0/match/url/1').length).toBe(1);
  });
  it('a bad duration is an error at its path', () => {
    const r = validateRecipe(recipe({ rules: [rule({ actions: [{ close: { after: '5 minutes' } }] })] }));
    expect(at(r, '/rules/0/actions/0/close/after').length).toBe(1);
  });
  it('additionalProperties: false at the top level and in nested objects', () => {
    expect(at(validateRecipe(recipe({ extra: 1 })), '/').some((e) => /extra/.test(e.message))).toBe(true);
    expect(at(validateRecipe(recipe({ needs: { hosts: [], other: [] } })), '/needs').some((e) => /other/.test(e.message))).toBe(true);
    expect(validateRecipe(recipe({ params: { p: { type: 'string', default: '', label: 'P', x: 1 } } })).ok).toBe(false);
  });
  it('duplicate rule ids are an error', () => {
    const r = validateRecipe(recipe({ rules: [rule(), rule()] }));
    expect(at(r, '/rules/1/id').length).toBe(1);
  });
  it('recipe ids use the rule id pattern; "user" is reserved', () => {
    expect(validateRecipe(recipe({ recipe: 'my_recipe-2' })).ok).toBe(true);
    expect(at(validateRecipe(recipe({ recipe: 'Bad Id' })), '/recipe').length).toBeGreaterThan(0);
    expect(at(validateRecipe(recipe({ recipe: 'a'.repeat(65) })), '/recipe').length).toBeGreaterThan(0);
    expect(at(validateRecipe(recipe({ recipe: 'user' })), '/recipe').map((e) => e.message)).toEqual([expect.stringMatching(/reserved/)]);
  });
  it('rejects non-objects', () => {
    for (const x of [null, 1, 'x', []]) expect(validateRecipe(x).ok).toBe(false);
  });
});

describe('validateRecipe: needs', () => {
  it('needs.permissions must be optional permissions of the manifest', () => {
    const r = validateRecipe(recipe({ needs: { permissions: ['debugger'] } }));
    expect(at(r, '/needs/permissions/0').length).toBeGreaterThan(0);
    expect(validateRecipe(recipe({ needs: { permissions: ['scripting', 'notifications'] } })).ok).toBe(true);
  });
  it('the schema permission enum equals manifestConfig.optional_permissions (D31)', () => {
    const items = (recipeJsonSchema as { $defs: { permission: { enum: string[] } } }).$defs.permission.enum;
    expect(items).toEqual(manifestConfig.optional_permissions);
  });
  it('needs.hosts must be Chrome match patterns', () => {
    expect(validateRecipe(recipe({ needs: { hosts: ['https://meet.google.com/*', '*://*.example.com/*', 'http://localhost:8080/x'] } })).ok).toBe(true);
    const r = validateRecipe(recipe({ needs: { hosts: ['https://ok.com/*', 'meet.google.com/*'] } }));
    expect(at(r, '/needs/hosts/1').length).toBe(1);
  });
  it('a recipe rule may declare its own needs (T10): hosts must be match patterns, permissions optional ones', () => {
    expect(validateRecipe(recipe({ rules: [rule({ needs: { hosts: ['https://meet.google.com/*'], permissions: ['scripting'] } })] })).ok).toBe(true);
    expect(at(validateRecipe(recipe({ rules: [rule({ needs: { hosts: ['https://ok.com/*', 'meet.google.com/*'] } })] })), '/rules/0/needs/hosts/1').length).toBe(1);
    expect(at(validateRecipe(recipe({ rules: [rule({ needs: { permissions: ['debugger'] } })] })), '/rules/0/needs/permissions/0').length).toBeGreaterThan(0);
    expect(at(validateRecipe(recipe({ rules: [rule({ needs: { other: [] } })] })), '/rules/0/needs').length).toBeGreaterThan(0);
  });
  it.each([
    'https://*/*', '*://*/*', 'http://*.example.com/', 'https://example.com/path/*', 'http://127.0.0.1/*', 'http://localhost:*/*',
    'https://a-b.example.co.uk:443/x?y',
  ])('match pattern ok: %s', (p) => expect(matchPatternProblem(p)).toBeUndefined());
  it.each([
    'meet.google.com/*', 'ftp://example.com/*', 'chrome://settings/*', '<all_urls>', 'https://example.com', 'https://*example.com/*',
    'https://exa*mple.com/*', 'https://*.*/*', 'https:///x', 'https://example.com:80x/*', 'https://user@example.com/*', 'http*://a.com/*',
    'https://a.com/ space', 'https://*./*',
  ])('match pattern rejected: %s', (p) => expect(matchPatternProblem(p)).toEqual(expect.any(String)));
});

describe('validateRecipe: params and placeholders (R14)', () => {
  const withParams = (params: Record<string, unknown>, r: Record<string, unknown>) => recipe({ params, rules: [r] });
  it('a typed leaf may be exactly a {params.x} placeholder', () => {
    const r = validateRecipe(withParams(
      {
        delay: { type: 'duration', default: '3s', label: 'Delay' },
        mode: { type: 'string', default: 'suggest', label: 'Mode', enum: ['auto', 'suggest'] },
        urls: { type: 'string[]', default: ['localhost:*/*callback*'], label: 'URLs' },
        collapsed: { type: 'boolean', default: true, label: 'Collapsed' },
        on: { type: 'string[]', default: ['created'], label: 'Triggers' },
      },
      rule({
        trigger: { on: '{params.on}' },
        match: { url: '{params.urls}' },
        actions: [{ close: { after: '{params.delay}', mode: '{params.mode}' } }, { group: { title: 'T', color: 'red', collapsed: '{params.collapsed}' } }],
      }),
    ));
    expect(errorsOf(r)).toEqual([]);
  });
  it('a placeholder embedded in a larger string is allowed in strings', () => {
    const r = validateRecipe(withParams({ p: { type: 'string', default: 'PR', label: 'P' } }, rule({ actions: [{ group: { title: '{params.p} reviews', color: 'red' } }] })));
    expect(errorsOf(r)).toEqual([]);
  });
  it('a non-placeholder string in a typed leaf is still rejected', () => {
    const r = validateRecipe(recipe({ rules: [rule({ actions: [{ group: { title: 'T', color: 'red', collapsed: 'yes' } }] })] }));
    expect(at(r, '/rules/0/actions/0/group/collapsed').length).toBeGreaterThan(0);
    const r2 = validateRecipe(recipe({ rules: [rule({ actions: [{ close: { mode: '{params.mode} ' } }] })] }));
    expect(r2.ok).toBe(false);
  });
  it('every placeholder must name a declared param', () => {
    const r = validateRecipe(recipe({ rules: [rule({ actions: [{ group: { title: 'PR {params.nope}', color: 'red' } }] })] }));
    expect(at(r, '/rules/0/actions/0/group/title').map((e) => e.message)).toEqual([expect.stringMatching(/unknown param.*nope/)]);
    const r2 = validateRecipe(recipe({ views: [{ id: 'v', tab: '{params.tab}', kind: 'list', actions: ['focus'] }], rules: [] }));
    expect(at(r2, '/views/0/tab').length).toBe(1);
  });
  it('param defaults and enum values must fit the param type', () => {
    const r = validateRecipe(recipe({
      params: {
        d: { type: 'duration', default: 'soon', label: 'D' },
        e: { type: 'string', default: 'c', label: 'E', enum: ['a', 'b'] },
        n: { type: 'number', default: 1, label: 'N', enum: [1, 'two'] },
        x: { type: 'regex', default: '((', label: 'X' },
      },
    }));
    expect(at(r, '/params/d/default').length).toBe(1);
    expect(at(r, '/params/e/default').length).toBe(1);
    expect(at(r, '/params/n/enum/1').length).toBe(1);
    expect(at(r, '/params/x/default').length).toBe(1);
  });
  it('param names are identifiers and types come from the fixed list', () => {
    expect(validateRecipe(recipe({ params: { 'bad-name': { type: 'string', default: '', label: 'B' } } })).ok).toBe(false);
    expect(validateRecipe(recipe({ params: { p: { type: 'object', default: {}, label: 'P' } } })).ok).toBe(false);
  });
  it('rules are checked after substituting the defaults (a default that breaks a rule is an error at the rule)', () => {
    const r = validateRecipe(withParams({ u: { type: 'string[]', default: ['a.com/(x)'], label: 'U' } }, rule({ match: { url: '{params.u}' } })));
    expect(at(r, '/rules/0/match/url/0').length).toBe(1);
    const r2 = validateRecipe(withParams({ m: { type: 'string', default: 'never', label: 'M' } }, rule({ actions: [{ close: { mode: '{params.m}' } }] })));
    expect(at(r2, '/rules/0/actions/0/close/mode').length).toBeGreaterThan(0);
  });
});

describe('validateRecipe: views', () => {
  const view = (over: Record<string, unknown> = {}) => ({ id: 'v', tab: 'V', kind: 'list', actions: ['focus', 'close'], ...over });
  it('accepts structured show comparisons with all/any/not', () => {
    const show = { all: [{ field: 'tab.url', op: 'matches', value: '^https://' }, { not: { field: 'tab.pinned', op: '==', value: true } }, { any: [{ field: 'rule', op: 'in', value: ['a', 'b'] }] }] };
    expect(errorsOf(validateRecipe(recipe({ views: [view({ show, sort: { field: 'tab.title', dir: 'asc' }, groupBy: 'rule' })] })))).toEqual([]);
  });
  it('an unknown op is an enum error', () => {
    const r = validateRecipe(recipe({ views: [view({ show: { field: 'tab.url', op: '=~', value: 'x' } })] }));
    expect(at(r, '/views/0/show/op').some((e) => e.message.includes('must be equal to one of the allowed values'))).toBe(true);
  });
  it('a show object with two keys is an error at its path', () => {
    const r = validateRecipe(recipe({ views: [view({ show: { all: [], not: { field: 'a', op: '==', value: 1 } } })] }));
    expect(at(r, '/views/0/show').length).toBeGreaterThan(0);
  });
  it('a `matches` value must be a regex of at most 500 characters that compiles', () => {
    const bad = (value: unknown) => validateRecipe(recipe({ views: [view({ show: { not: { field: 'tab.url', op: 'matches', value } } })] }));
    expect(at(bad('(('), '/views/0/show/not/value').map((e) => e.message)).toEqual([expect.stringMatching(/invalid regex/)]);
    expect(at(bad('a'.repeat(501)), '/views/0/show/not/value').map((e) => e.message)).toEqual([expect.stringMatching(/too long/)]);
    expect(at(bad(5), '/views/0/show/not/value').length).toBe(1);
  });
  it('`in` takes a list', () => {
    const r = validateRecipe(recipe({ views: [view({ show: { field: 'rule', op: 'in', value: 'a' } })] }));
    expect(at(r, '/views/0/show/value').length).toBe(1);
  });
  it('kind and view actions come from fixed lists; ids are unique', () => {
    expect(validateRecipe(recipe({ views: [view({ kind: 'table' })] })).ok).toBe(false);
    expect(validateRecipe(recipe({ views: [view({ actions: ['discard'] })] })).ok).toBe(false);
    expect(at(validateRecipe(recipe({ views: [view(), view()] })), '/views/1/id').length).toBe(1);
  });
});

describe('validateRecipe: dedupe and tables', () => {
  it('urlTransforms must compile and are capped at 500 characters', () => {
    const t = (pattern: string) => validateRecipe(recipe({ dedupe: { urlTransforms: [{ pattern: 'ok', replacement: '' }, { pattern, replacement: '' }] } }));
    expect(at(t('(('), '/dedupe/urlTransforms/1/pattern').map((e) => e.message)).toEqual([expect.stringMatching(/invalid regex/)]);
    expect(at(t('a'.repeat(501)), '/dedupe/urlTransforms/1/pattern').length).toBeGreaterThan(0);
    expect(at(t('a'), '/dedupe/urlTransforms/1/pattern')).toEqual([]);
  });
  it('tables map names to string entries', () => {
    expect(validateRecipe(recipe({ tables: { owners: { acme: 'Acme' } } })).ok).toBe(true);
    expect(validateRecipe(recipe({ tables: { owners: { acme: 1 } } })).ok).toBe(false);
  });
});

describe('validateRule', () => {
  it('accepts a valid rule', () => {
    expect(validateRule(rule())).toEqual({ ok: true, rule: rule() as unknown as Rule });
  });
  it('schema errors carry JSON-pointer paths', () => {
    const r = validateRule(rule({ actions: [{ eval: 'x' }] }));
    expect(at(r, '/actions/0').some((e) => /eval/.test(e.message))).toBe(true);
  });
  it('rejects age conditions with "not supported yet" (R66), so the editor shows it', () => {
    const r = validateRule(rule({ match: { all: [{ url: 'example.com/*' }, { not: { age: { lt: '1h' } } }] } }));
    expect(at(r, '/match/all/1/not/age').map((e) => e.message)).toEqual(['age conditions are not supported yet']);
  });
  it('runs the TS post-checks', () => {
    expect(at(validateRule(rule({ match: { url: 'a.com/(x)' } })), '/match/url').length).toBe(1);
  });
  it('caps regexes at 500 characters in TS (the shared rule schema stays uncapped for stored config)', () => {
    const r = validateRule(rule({ extract: { n: { from: 'url', regex: 'a'.repeat(10_240) } } }));
    expect(at(r, '/extract/n/regex').map((e) => e.message)).toEqual([expect.stringMatching(/too long/)]);
  });
  it('placeholders are not allowed in a plain rule', () => {
    expect(validateRule(rule({ actions: [{ group: { title: 'T', color: 'red', collapsed: '{params.c}' } }] })).ok).toBe(false);
  });
});

describe('exported JSON schemas', () => {
  it('are the schema documents', () => {
    expect(recipeJsonSchema.$id).toBe('https://schemas.tabchef.invalid/recipe.json');
    expect(ruleJsonSchema.$id).toBe('https://schemas.tabchef.invalid/rule.json');
  });
});
