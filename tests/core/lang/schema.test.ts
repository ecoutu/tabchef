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
  it('the schema permission enum equals manifestConfig.optional_permissions, less bookmarks (D31; project sync only, a recipe never needs it)', () => {
    const items = (recipeJsonSchema as { $defs: { permission: { enum: string[] } } }).$defs.permission.enum;
    expect(items).toEqual(manifestConfig.optional_permissions?.filter((p) => p !== 'bookmarks'));
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
  it('a urlTransform pattern with a placeholder is checked with the param default rendered as a host glob', () => {
    const t = (pattern: string) => validateRecipe(recipe({
      params: { site: { type: 'string', default: '*.example.com', label: 'Site' } }, dedupe: { urlTransforms: [{ pattern, replacement: '' }] },
    }));
    expect(t('^https://{params.site}/x').ok).toBe(true);
    // Elsewhere in the pattern the default interpolates plainly: 485 + 13 characters, under the cap.
    expect(t(`${'a'.repeat(485)}{params.site}`).ok).toBe(true);
    expect(at(t('^(https://{params.site}/x'), '/dedupe/urlTransforms/0/pattern').map((e) => e.message)).toEqual([expect.stringMatching(/invalid regex/)]);
    // 496 characters as written, 504 rendered (`*.` is `[^/?#]*\.`): over the cap.
    expect(at(t(`${'a'.repeat(475)}https://{params.site}`), '/dedupe/urlTransforms/0/pattern').map((e) => e.message)).toEqual([expect.stringMatching(/too long/)]);
  });
  it('a urlTransform whose default renders to dropped is not checked, as compileProgram drops it silently', () => {
    const t = (pattern: string, flags?: string) => validateRecipe(recipe({
      params: { site: { type: 'string', default: '*', label: 'Site' } },
      dedupe: { urlTransforms: [{ pattern, replacement: '$1', ...(flags ? { flags } : {}) }] },
    }));
    expect(t('^(https?://{params.site}/x)\\?.*$', 'u').ok).toBe(true);
    // A placeholder that fails to substitute is reported, and the pattern as written is still checked.
    expect(at(t('^(https://{params.nope}/x'), '/dedupe/urlTransforms/0/pattern').map((e) => e.message)).toEqual([
      'unknown param: {params.nope}', expect.stringMatching(/invalid regex/),
    ]);
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
  it('accepts age conditions (M3-R6, was R66); bad durations are still rejected', () => {
    expect(validateRule(rule({ match: { all: [{ url: 'example.com/*' }, { not: { age: { lt: '1h' } } }] } })).ok).toBe(true);
    const r = validateRule(rule({ match: { all: [{ url: 'example.com/*' }, { not: { age: { lt: 'soon' } } }] } }));
    expect(at(r, '/match/all/1/not/age/lt').map((e) => e.message)).toEqual([expect.stringMatching(/must be a duration/)]);
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

describe('M3 T1: sources, fields, keys and projects', () => {
  const src = (over: Record<string, unknown> = {}) => ({
    connection: 'github', query: 'github.pull_request', args: { owner: 'acme', repo: 'api', number: '7' }, fields: { merged: 'merged', mergedAt: 'mergedAt' }, ...over,
  });
  it('a recipe rule may declare a source', () => {
    expect(errorsOf(validateRecipe(recipe({ rules: [rule({ source: src() })] })))).toEqual([]);
  });
  it('the query enum lists exactly the five source queries (M3-R29)', () => {
    const q = (ruleJsonSchema as unknown as { $defs: { source: { properties: { query: { enum: string[] } } } } }).$defs.source.properties.query.enum;
    expect(q).toEqual(['github.pull_request', 'github.search_prs_by_key', 'github.issue', 'jira.issue', 'jira.projects']);
  });
  it('rejects an unknown query and a field path that is not a dot path', () => {
    expect(at(validateRecipe(recipe({ rules: [rule({ source: src({ query: 'github.anything' }) })] })), '/rules/0/source/query').length).toBeGreaterThan(0);
    expect(at(validateRecipe(recipe({ rules: [rule({ source: src({ fields: { x: 'a[0]()' } }) })] })), '/rules/0/source/fields/x').length).toBeGreaterThan(0);
    expect(validateRecipe(recipe({ rules: [rule({ source: src({ fields: { x: 'head.repo.name' } }) })] })).ok).toBe(true);
  });
  it('accepts a source fallback page adapter (M3-R59) and rejects an unknown one or extra keys', () => {
    expect(errorsOf(validateRecipe(recipe({ rules: [rule({ source: src({ fallback: { adapter: 'github.prPage' } }) })] })))).toEqual([]);
    expect(at(validateRecipe(recipe({ rules: [rule({ source: src({ fallback: { adapter: 'gitlab.mrPage' } }) })] })), '/rules/0/source/fallback/adapter').length).toBeGreaterThan(0);
    expect(validateRecipe(recipe({ rules: [rule({ source: src({ fallback: { adapter: 'github.prPage', x: 1 } }) })] })).ok).toBe(false);
    expect(validateRecipe(recipe({ rules: [rule({ source: src({ fallback: {} }) })] })).ok).toBe(false);
  });
  it('a field path may come from a string param ({params.x} placeholder)', () => {
    const r = recipe({ params: { p: { type: 'string', default: 'mergedAt', label: 'P' } }, rules: [rule({ source: src({ fields: { x: '{params.p}' } }) })] });
    expect(errorsOf(validateRecipe(r))).toEqual([]);
    const bad = recipe({ params: { p: { type: 'string', default: 'a[0]', label: 'P' } }, rules: [rule({ source: src({ fields: { x: '{params.p}' } }) })] });
    expect(at(validateRecipe(bad), '/rules/0/source/fields/x').length).toBeGreaterThan(0);
  });
  it("trigger.on: ['sourceUpdated'] validates", () => {
    expect(validateRule(rule({ trigger: { on: ['sourceUpdated'] } })).ok).toBe(true);
  });
  it('accepts field conditions on source and extract fields, with {ago}', () => {
    const r = rule({ source: src(), extract: { k: { from: 'url', regex: 'pull/(\\d+)' } }, match: { all: [
      { url: 'github.com/*' },
      { field: { field: 'source.mergedAt', op: '<', value: { ago: '24h' } } },
      { not: { field: { field: 'extract.k', op: '==', value: '7' } } },
    ] } });
    expect(errorsOf(validateRule(r))).toEqual([]);
  });
  it('rejects a field condition with a bad field name, op, {ago} duration or {ago} op', () => {
    const f = (field: Record<string, unknown>, extra: Record<string, unknown> = {}) => validateRule(rule({ source: src(), match: { field }, ...extra }));
    expect(f({ field: 'tab.url', op: '==', value: 'x' }).ok).toBe(false);
    expect(f({ field: 'source.merged', op: '~', value: 'x' }).ok).toBe(false);
    expect(at(f({ field: 'source.mergedAt', op: '<', value: { ago: 'soon' } }), '/match/field/value/ago').map((e) => e.message)).toEqual([expect.stringMatching(/must be a duration/)]);
    expect(at(f({ field: 'source.mergedAt', op: '==', value: { ago: '1h' } }), '/match/field/value').length).toBe(1);
    expect(at(f({ field: 'source.merged', op: 'in', value: 'x' }), '/match/field/value').length).toBe(1);
    expect(at(f({ field: 'source.merged', op: 'matches', value: '((' }), '/match/field/value').length).toBe(1);
  });
  it('a source.<n> field must name a source field, an extract.<n> field an extract', () => {
    expect(at(validateRule(rule({ match: { field: { field: 'source.merged', op: '==', value: true } } })), '/match/field/field').length).toBe(1);
    expect(at(validateRule(rule({ source: src(), match: { field: { field: 'source.nope', op: '==', value: true } } })), '/match/field/field').length).toBe(1);
    expect(at(validateRule(rule({ match: { field: { field: 'extract.k', op: '==', value: '1' } } })), '/match/field/field').length).toBe(1);
  });
  it('accepts a jiraKey extract from url, title or a source field; the source field must exist', () => {
    const ok = rule({ source: src(), extract: { a: { from: 'url', jiraKey: {} }, b: { from: 'title', jiraKey: { allow: ['ABC'], ignore: ['UTF'] } }, c: { from: 'source.merged', jiraKey: { pattern: '[A-Z]+-\\d+' } } } });
    expect(errorsOf(validateRule(ok))).toEqual([]);
    expect(at(validateRule(rule({ extract: { a: { from: 'source.x', jiraKey: {} } } })), '/extract/a/from').length).toBe(1);
    expect(validateRule(rule({ extract: { a: { from: 'page', jiraKey: {} } } })).ok).toBe(false);
    expect(at(validateRule(rule({ extract: { a: { from: 'url', jiraKey: { pattern: '((' } } } })), '/extract/a/jiraKey/pattern').length).toBe(1);
  });
  it('accepts a githubIssue extract from url, title or a source field; rejects unknown keys and a bad pattern', () => {
    const ok = rule({ source: src(), extract: { a: { from: 'url', githubIssue: {} }, b: { from: 'source.merged', githubIssue: { pattern: '(?<n>\\d+)', allow: ['acme/*'], ignore: ['acme/x'] } } } });
    expect(errorsOf(validateRule(ok))).toEqual([]);
    expect(validateRule(rule({ extract: { a: { from: 'url', githubIssue: { bogus: 1 } } } })).ok).toBe(false);
    expect(at(validateRule(rule({ extract: { a: { from: 'source.x', githubIssue: {} } } })), '/extract/a/from').length).toBe(1);
    expect(at(validateRule(rule({ extract: { a: { from: 'url', githubIssue: { pattern: '((' } } } })), '/extract/a/githubIssue/pattern').length).toBe(1);
    const noGroup = at(validateRule(rule({ extract: { a: { from: 'url', githubIssue: { pattern: '^fix/(\\d+)' } } } })), '/extract/a/githubIssue/pattern');
    expect(noGroup.map((e) => e.message)).toEqual([expect.stringContaining('named group n')]);
  });
  it('accepts an {adapter, field} extract (T10, M3-R58); the adapter must exist and have that field', () => {
    expect(errorsOf(validateRule(rule({ extract: { a: { adapter: 'github.prPage', field: 'state' }, b: { adapter: 'jira.issuePage', field: 'summary' } } })))).toEqual([]);
    expect(errorsOf(validateRecipe(recipe({ rules: [rule({ extract: { a: { adapter: 'github.prPage', field: 'branch' } } })] })))).toEqual([]);
    expect(validateRule(rule({ extract: { a: { adapter: 'gitlab.mrPage', field: 'state' } } })).ok).toBe(false);
    expect(validateRule(rule({ extract: { a: { adapter: 'github.prPage', field: 'state', attr: 'x' } } })).ok).toBe(false);
    expect(at(validateRule(rule({ extract: { a: { adapter: 'github.prPage', field: 'status' } } })), '/extract/a/field').map((e) => e.message))
      .toEqual(['github.prPage has no field "status" (state, branch)']);
  });
  it('accepts an assignProject action; its key template vars must be provided', () => {
    const ok = rule({ extract: { k: { from: 'url', jiraKey: {} } }, actions: [{ assignProject: { key: '{k}', create: true } }] });
    expect(errorsOf(validateRule(ok))).toEqual([]);
    expect(at(validateRule(rule({ actions: [{ assignProject: { key: '{nope}' } }] })), '/actions/0/assignProject/key').length).toBe(1);
    expect(validateRule(rule({ actions: [{ assignProject: { key: '' } }] })).ok).toBe(false);
  });
  it('recipe needs gain connections and anyOf (one $defs/needs, M3-R13)', () => {
    const needs = { anyOf: [{ connections: ['github'] }, { hosts: ['https://github.com/*'] }] };
    expect(errorsOf(validateRecipe(recipe({ needs })))).toEqual([]);
    expect(errorsOf(validateRecipe(recipe({ rules: [rule({ needs })] })))).toEqual([]);
    expect(at(validateRecipe(recipe({ needs: { anyOf: [{ hosts: ['github.com/*'] }] } })), '/needs/anyOf/0/hosts/0').length).toBe(1);
    expect(validateRecipe(recipe({ needs: { connections: ['Not An Id'] } })).ok).toBe(false);
  });
  it('a {params.x} placeholder cannot stand in for the needs.anyOf list (M3-R14)', () => {
    const r = recipe({ params: { x: { type: 'string[]', default: [], label: 'X' } }, rules: [rule({ needs: { anyOf: '{params.x}' } })] });
    expect(validateRecipe(r).ok).toBe(false);
  });
  it('levels map to kinds by position (M3-R69): at most 3, and each listed rule has an alternative of that kind', () => {
    const anyOf = { anyOf: [{ connections: ['github'] }, { hosts: ['https://github.com/*'] }, {}] };
    const lv = (rules: string[][]) => rules.map((r, i) => ({ id: `l${i}`, label: `L${i}`, rules: r }));
    expect(errorsOf(validateRecipe(recipe({ rules: [rule({ needs: anyOf })], levels: lv([['r'], ['r'], ['r']]) })))).toEqual([]);
    const four = validateRecipe(recipe({ rules: [rule({ needs: anyOf })], levels: lv([['r'], ['r'], ['r'], ['r']]) }));
    expect(at(four, '/levels').map((e) => e.message)).toEqual([expect.stringMatching(/at most 3 levels/)]);
    // A rule with only a host alternative: no titles alternative (level 0) and no connection one (level 2).
    const hostOnly = rule({ needs: { anyOf: [{ hosts: ['https://github.com/*'] }] } });
    const r = validateRecipe(recipe({ rules: [hostOnly], levels: lv([['r'], ['r'], ['r']]) }));
    expect(at(r, '/levels/0/rules/0').map((e) => e.message)).toEqual(['rule r has no titles alternative (level 0 means titles)']);
    expect(at(r, '/levels/1/rules/0')).toEqual([]);
    expect(at(r, '/levels/2/rules/0').map((e) => e.message)).toEqual(['rule r has no connection alternative (level 2 means connection)']);
    // Without anyOf the rule's needs are its one alternative: no needs = titles, hosts = page, connections = connection.
    expect(errorsOf(validateRecipe(recipe({ levels: lv([['r']]) })))).toEqual([]);
    expect(at(validateRecipe(recipe({ levels: lv([['r'], ['r']]) })), '/levels/1/rules/0').length).toBe(1);
  });
  it('a recipe may declare a project, conflicts and levels; level rules must exist', () => {
    const project = { key: '{key}', title: '{key}', color: 'blue', container: 'group', join: ['rules', 'manual'] };
    const ok = recipe({ project, conflicts: ['other'], levels: [{ id: 'full', label: 'Full', rules: ['r'] }] });
    expect(errorsOf(validateRecipe(ok))).toEqual([]);
    expect(at(validateRecipe(recipe({ levels: [{ id: 'full', label: 'Full', rules: ['nope'] }] })), '/levels/0/rules/0').length).toBe(1);
    expect(at(validateRecipe(recipe({ conflicts: ['demo'] })), '/conflicts/0').length).toBe(1);
    expect(validateRecipe(recipe({ project: { ...project, container: 'tab' } })).ok).toBe(false); // 'window' is accepted by the schema; compileProgram rejects it
    expect(at(validateRecipe(recipe({ project: { ...project, color: 'mauve' } })), '/project/color').length).toBe(1);
  });
  it('T16: a project color from a param is checked with the default substituted', () => {
    const project = { key: '{key}', title: '{params.fmt}', color: '{params.color}', container: 'group', join: ['rules'] };
    const params = (color: string) => ({ color: { type: 'string', default: color, label: 'C' }, fmt: { type: 'string', default: '{key}', label: 'F' } });
    expect(errorsOf(validateRecipe(recipe({ project, params: params('blue') })))).toEqual([]);
    expect(at(validateRecipe(recipe({ project, params: params('mauve') })), '/project/color').length).toBe(1);
  });
  it('T16: assignProject.fallbackKey is a template whose vars must be provided', () => {
    const ok = rule({ extract: { a: { from: 'title', jiraKey: {} }, b: { from: 'url', jiraKey: {} } }, actions: [{ assignProject: { key: '{a}', fallbackKey: '{b}' } }] });
    expect(errorsOf(validateRule(ok))).toEqual([]);
    expect(at(validateRule(rule({ actions: [{ assignProject: { key: 'K-1', fallbackKey: '{nope}' } }] })), '/actions/0/assignProject/fallbackKey').length).toBe(1);
    expect(validateRule(rule({ actions: [{ assignProject: { key: 'K-1', fallbackKey: '' } }] })).ok).toBe(false);
  });
  it('a recipe rule with assignProject needs the recipe to declare a project', () => {
    const r = recipe({ rules: [rule({ actions: [{ assignProject: { key: 'ABC-1' } }] })] });
    expect(at(validateRecipe(r), '/rules/0/actions/0/assignProject').length).toBe(1);
  });
  it("accepts View.kind 'projects' (M3-R81 lifts M3-R18 now that T17 renders it)", () => {
    expect(errorsOf(validateRecipe(recipe({ views: [{ id: 'p', tab: 'P', kind: 'projects', actions: [] }] })))).toEqual([]);
    expect(validateRecipe(recipe({ views: [{ id: 'p', tab: 'P', kind: 'nope', actions: [] }] })).ok).toBe(false);
  });
});

describe('M3-R77: param min / max (duration and number)', () => {
  const dur = (o: Record<string, unknown>) => recipe({ params: { d: { type: 'duration', default: '5m', label: 'D', ...o } } });
  const num = (o: Record<string, unknown>) => recipe({ params: { n: { type: 'number', default: 5, label: 'N', ...o } } });
  it('the schema accepts min and max on duration and number params', () => {
    expect(validateRecipe(dur({ min: '1m', max: '1h' })).ok).toBe(true);
    expect(validateRecipe(num({ min: 1, max: 10 })).ok).toBe(true);
  });
  it('a default below min or above max is a problem with the bound in the message', () => {
    expect(at(validateRecipe(dur({ default: '30s', min: '1m' })), '/params/d/default').map((e) => e.message)).toEqual(['must be at least 1m']);
    expect(at(validateRecipe(dur({ default: '2h', max: '1h' })), '/params/d/default').map((e) => e.message)).toEqual(['must be at most 1h']);
    expect(at(validateRecipe(num({ default: 0, min: 1 })), '/params/n/default').map((e) => e.message)).toEqual(['must be at least 1']);
    expect(at(validateRecipe(num({ default: 11, max: 10 })), '/params/n/default').map((e) => e.message)).toEqual(['must be at most 10']);
    expect(validateRecipe(dur({ default: '1m', min: '1m', max: '1m' })).ok).toBe(true); // bounds are inclusive
  });
  it('a bound must fit the param type, sit on a duration or number param, and min must not exceed max', () => {
    expect(at(validateRecipe(dur({ min: 5 })), '/params/d/min').length).toBe(1);
    expect(at(validateRecipe(num({ max: '1m' })), '/params/n/max').length).toBe(1);
    expect(at(validateRecipe(dur({ min: '1h', max: '1m' })), '/params/d/min').length).toBe(1);
    const s = recipe({ params: { s: { type: 'string', default: 'x', label: 'S', min: 1 } } });
    expect(at(validateRecipe(s), '/params/s/min').length).toBe(1);
  });
});
