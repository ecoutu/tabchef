import { describe, it, expect } from 'vitest';
import { compileProgram, indexByKey } from '../../../src/core/lang/compile';
import { defaultConfig } from '../../../src/core/config/defaults';
import type { Recipe, RecipeRef, Rule } from '../../../src/core/lang/types';
import type { Config } from '../../../src/core/types';

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, name: id, enabled: true, match: { url: 'github.com/*' }, actions: [{ group: { title: 'GH', color: 'blue' } }], ...over,
});
const recipe = (id: string, rules: Rule[], over: Partial<Recipe> = {}): Recipe => ({
  recipe: id, version: 1, name: id, description: id, rules, ...over,
});
const ref = (id: string, over: Partial<RecipeRef> = {}): RecipeRef => ({ id, enabled: true, params: {}, source: 'builtin', ...over });
const config = (over: Partial<Config> = {}): Config => ({ ...defaultConfig(), recipes: [], ...over });
const keys = (c: Config, b: Record<string, Recipe> = {}, paused?: Set<string>) =>
  compileProgram(c, b, { paused }).program.rules.map((r) => r.key);

describe('compileProgram: keys and order', () => {
  it('keys user rules user/<id> and recipe rules <recipeId>/<ruleId>', () => {
    const c = config({ rules: [rule('a')], recipes: [ref('gh')] });
    expect(keys(c, { gh: recipe('gh', [rule('b')]) })).toEqual(['user/a', 'gh/b']);
  });
  it('an enabled recipe with an empty order: recipe keys come after the user keys, in recipe order', () => {
    const c = config({
      rules: [rule('u1'), rule('u2')], order: [],
      recipes: [ref('r1'), ref('r2')],
    });
    const b = { r1: recipe('r1', [rule('x'), rule('y')]), r2: recipe('r2', [rule('z')]) };
    expect(keys(c, b)).toEqual(['user/u1', 'user/u2', 'r1/x', 'r1/y', 'r2/z']);
  });
  it('order sets priority; missing keys are appended; unknown and duplicate order keys are ignored', () => {
    const c = config({
      rules: [rule('u1'), rule('u2')], recipes: [ref('r1')],
      order: ['r1/y', 'nope/x', 'user/u2', 'r1/y'],
    });
    const p = compileProgram(c, { r1: recipe('r1', [rule('x'), rule('y')]) }).program;
    expect(p.rules.map((r) => r.key)).toEqual(['r1/y', 'user/u2', 'user/u1', 'r1/x']);
    expect(p.rules.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(p.rules[0]?.recipeId).toBe('r1');
    expect(p.rules[1]?.recipeId).toBeUndefined();
  });
  it('skips disabled rules and disabled recipes', () => {
    const c = config({ rules: [rule('a', { enabled: false }), rule('b')], recipes: [ref('r1', { enabled: false }), ref('r2')] });
    const b = { r1: recipe('r1', [rule('x')]), r2: recipe('r2', [rule('y', { enabled: false }), rule('z')]) };
    expect(keys(c, b)).toEqual(['user/b', 'r2/z']);
  });
  it('user recipes use their body', () => {
    const c = config({ recipes: [ref('mine', { source: 'user', body: recipe('mine', [rule('x')]) })] });
    expect(keys(c)).toEqual(['mine/x']);
  });
  it('excludes paused rule keys and paused recipe ids', () => {
    const c = config({ rules: [rule('a'), rule('b')], recipes: [ref('r1'), ref('r2')] });
    const b = { r1: recipe('r1', [rule('x')]), r2: recipe('r2', [rule('y'), rule('z')]) };
    expect(keys(c, b, new Set(['user/a', 'r1', 'r2/z']))).toEqual(['user/b', 'r2/y']);
  });
  it('dryRun is rule-level dryRun OR config.dryRun', () => {
    const c = config({ rules: [rule('a', { dryRun: true }), rule('b')] });
    expect(compileProgram(c, {}).program.rules.map((r) => r.dryRun)).toEqual([true, false]);
    expect(compileProgram({ ...c, dryRun: true }, {}).program.rules.map((r) => r.dryRun)).toEqual([true, true]);
  });
});

describe('compileProgram: params (typed placeholders)', () => {
  const closeRecipe = (over: Partial<Recipe> = {}) => recipe('finished', [
    rule('oauth', { match: { url: '{params.patterns}' }, actions: [{ close: { after: '{params.delay}', mode: '{params.mode}' as 'auto' } }] }),
  ], {
    params: {
      delay: { type: 'duration', default: '3s', label: 'Delay' },
      mode: { type: 'string', default: 'auto', label: 'Mode', enum: ['auto', 'suggest'] },
      patterns: { type: 'string[]', default: ['localhost:8080/*callback*'], label: 'Patterns' },
    },
    ...over,
  });
  const compiled = (params: Record<string, unknown> = {}, r = closeRecipe()) =>
    compileProgram(config({ recipes: [ref('finished', { params })] }), { finished: r });

  it('substitutes defaults, and a string[] param replaces the whole url field with the array', () => {
    const { program, errors } = compiled();
    expect(errors).toEqual([]);
    const r = program.rules[0]?.rule as Rule;
    expect(r.match).toEqual({ url: ['localhost:8080/*callback*'] });
    expect(r.actions).toEqual([{ close: { after: '3s', mode: 'auto' } }]);
  });
  it('user param values win over defaults', () => {
    const { program } = compiled({ delay: '5s', patterns: ['a.com/*', 'b.com/*'] });
    expect(program.rules[0]?.rule.match).toEqual({ url: ['a.com/*', 'b.com/*'] });
    expect(program.rules[0]?.rule.actions).toEqual([{ close: { after: '5s', mode: 'auto' } }]);
  });
  it('a whole-value boolean placeholder becomes a boolean; placeholders in a larger string interpolate', () => {
    const r = recipe('pr', [rule('x', { actions: [{ group: { title: 'PR {params.prefix} #{params.n}', color: 'blue', collapsed: '{params.collapse}' as unknown as boolean } }] })], {
      params: {
        prefix: { type: 'string', default: 'acme', label: 'P' },
        n: { type: 'number', default: 3, label: 'N' },
        collapse: { type: 'boolean', default: true, label: 'C' },
      },
    });
    const { program, errors } = compileProgram(config({ recipes: [ref('pr')] }), { pr: r });
    expect(errors).toEqual([]);
    expect(program.rules[0]?.rule.actions).toEqual([{ group: { title: 'PR acme #3', color: 'blue', collapsed: true } }]);
  });
  it('an array element placeholder holding an array splices into the array', () => {
    const r = recipe('r', [rule('x', { match: { url: ['x.com/*', '{params.more}'] } })], {
      params: { more: { type: 'string[]', default: ['y.com/*', 'z.com/*'], label: 'M' } },
    });
    expect(compileProgram(config({ recipes: [ref('r')] }), { r }).program.rules[0]?.rule.match).toEqual({ url: ['x.com/*', 'y.com/*', 'z.com/*'] });
  });
  it('a param of the wrong type is an error for that recipe; other rules still compile', () => {
    const c = config({ rules: [rule('u')], recipes: [ref('finished', { params: { delay: 5 } }), ref('other')] });
    const { program, errors } = compileProgram(c, { finished: closeRecipe(), other: recipe('other', [rule('o')]) });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.key).toBe('finished');
    expect(errors[0]?.error).toMatch(/delay/);
    expect(program.rules.map((r) => r.key)).toEqual(['user/u', 'other/o']);
  });
  it.each([
    ['duration', { delay: 'soon' }],
    ['string[]', { patterns: ['a', 1] }],
    ['enum', { mode: 'never' }],
  ])('rejects a bad %s param', (_k, params) => {
    const { program, errors } = compiled(params);
    expect(errors.map((e) => e.key)).toEqual(['finished']);
    expect(program.rules).toEqual([]);
  });
  it('rejects a bad regex / number / boolean param', () => {
    const r = (type: 'regex' | 'number' | 'boolean', v: unknown) => recipe('r', [rule('x')], { params: { p: { type, default: v, label: 'p' } } });
    for (const [t, v] of [['regex', '(' ], ['number', '3'], ['number', Number.NaN], ['boolean', 'yes']] as const) {
      expect(compileProgram(config({ recipes: [ref('r')] }), { r: r(t, v) }).errors.map((e) => e.key)).toEqual(['r']);
    }
  });
  it('an unknown {params.x} is an error', () => {
    const r = recipe('r', [rule('x', { match: { url: '{params.nope}' } })]);
    const { program, errors } = compileProgram(config({ recipes: [ref('r')] }), { r });
    expect(errors[0]?.key).toMatch(/^r/);
    expect(errors[0]?.error).toMatch(/nope/);
    expect(program.rules).toEqual([]);
  });
  it('after substitution the rule is schema-validated: a bad enum value lands in errors under the rule key', () => {
    const r = closeRecipe({ params: { ...closeRecipe().params, mode: { type: 'string', default: 'bogus', label: 'Mode' } } });
    const { program, errors } = compiled({}, r);
    expect(errors.map((e) => e.key)).toEqual(['finished/oauth']);
    expect(program.rules).toEqual([]);
  });
  it('after substitution the TS post-checks run: a bad pattern lands in errors', () => {
    const { errors } = compiled({ patterns: ['https://a(b).com/*'] });
    expect(errors.map((e) => e.key)).toEqual(['finished/oauth']);
    expect(errors[0]?.error).toMatch(/\/match\/url\/0/);
  });
  it('a broken recipe skips the whole recipe, including its tables and views', () => {
    const bad = recipe('bad', [rule('ok'), rule('broken', { match: { url: 'https://a(b).com/*' } })], {
      tables: { t: { a: 'b' } }, views: [{ id: 'v', tab: 'V', kind: 'list', actions: [] }],
    });
    const { program, errors } = compileProgram(config({ recipes: [ref('bad')] }), { bad });
    expect(errors.map((e) => e.key)).toEqual(['bad/broken']);
    expect(program.rules).toEqual([]);
    expect(program.tables).toEqual({});
    expect(program.views).toEqual([]);
  });
  it('a missing built-in or a user recipe without body is an error', () => {
    const c = config({ recipes: [ref('ghost'), ref('mine', { source: 'user' })] });
    expect(compileProgram(c, {}).errors.map((e) => e.key)).toEqual(['ghost', 'mine']);
  });
  it('never throws on garbage recipes', () => {
    const c = config({ recipes: [ref('g')] });
    expect(() => compileProgram(c, { g: { rules: 'nope' } as unknown as Recipe })).not.toThrow();
    expect(compileProgram(c, { g: { rules: 'nope' } as unknown as Recipe }).errors.map((e) => e.key)).toEqual(['g']);
  });
});

describe('compileProgram: validation of user rules and template vars', () => {
  it('an invalid user rule is reported under its key and skipped; others compile', () => {
    const c = config({ rules: [rule('bad', { match: { url: 'https://a(b).com/*' } }), rule('good')] });
    const { program, errors } = compileProgram(c, {});
    expect(errors.map((e) => e.key)).toEqual(['user/bad']);
    expect(program.rules.map((r) => r.key)).toEqual(['user/good']);
  });
  it('a title {var} no condition or extract provides is an error', () => {
    const c = config({ rules: [rule('a', { actions: [{ group: { title: '{repo}', color: 'blue' } }] })] });
    expect(compileProgram(c, {}).errors.map((e) => e.key)).toEqual(['user/a']);
  });
  it('a color {var} no condition or extract provides is an error', () => {
    const c = config({ rules: [rule('a', { actions: [{ group: { title: 'A', color: '{repo|default:grey}' } }] })] });
    expect(compileProgram(c, {}).errors.map((e) => e.key)).toEqual(['user/a']);
  });
  it('title-regex named groups, url captures and extract names count as available vars', () => {
    const c = config({
      rules: [rule('a', {
        match: { all: [{ url: 'github.com/:org/*' }, { title: '/^(?<num>\\d+)/' }] },
        extract: { proj: { selector: 'h1' } },
        actions: [{ group: { title: '{org} {num} {proj}', color: '{org|default:grey}' } }],
      })],
    });
    expect(compileProgram(c, {}).errors).toEqual([]);
  });
  it('a map: table must exist in the merged tables', () => {
    const r = (t: string) => rule('a', { match: { url: 'github.com/:repo/*' }, actions: [{ group: { title: 'A', color: `{repo|map:${t}|default:grey}` } }] });
    const ok = config({ rules: [r('colors')], tables: { colors: { api: 'red' } } });
    expect(compileProgram(ok, {}).errors).toEqual([]);
    expect(compileProgram(config({ rules: [r('nope')] }), {}).errors.map((e) => e.key)).toEqual(['user/a']);
  });
});

describe('compileProgram: tables, dedupe, views, needs', () => {
  it('tables merge builtin → user recipe → config.tables, later wins', () => {
    const c = config({
      recipes: [ref('mine', { source: 'user', body: recipe('mine', [], { tables: { t: { a: 'user', b: 'user' } } }) }), ref('bi')],
      tables: { t: { b: 'config' }, other: { x: 'y' } },
    });
    const { program } = compileProgram(c, { bi: recipe('bi', [], { tables: { t: { a: 'bi', b: 'bi', c: 'bi' } } }) });
    expect(program.tables).toEqual({ t: { a: 'user', b: 'config', c: 'bi' }, other: { x: 'y' } });
  });
  it('dedupe urlTransforms = config + each enabled recipe', () => {
    const t1 = { pattern: 'a', replacement: 'b' };
    const t2 = { pattern: 'c', replacement: 'd' };
    const c = config({ dedupe: { ...defaultConfig().dedupe, urlTransforms: [t1] }, recipes: [ref('r'), ref('off', { enabled: false })] });
    const { program } = compileProgram(c, { r: recipe('r', [], { dedupe: { urlTransforms: [t2] } }), off: recipe('off', [], { dedupe: { urlTransforms: [t1] } }) });
    expect(program.dedupe.urlTransforms).toEqual([t1, t2]);
    expect(program.dedupe.mode).toBe(c.dedupe.mode);
  });
  it('a recipe with an invalid urlTransform regex is an error', () => {
    const c = config({ recipes: [ref('r')] });
    const { program, errors } = compileProgram(c, { r: recipe('r', [rule('x')], { dedupe: { urlTransforms: [{ pattern: '(', replacement: '' }] } }) });
    expect(errors.map((e) => e.key)).toEqual(['r']);
    expect(program.rules).toEqual([]);
  });
  it('views carry their recipe id; needs default to empty lists', () => {
    const v = { id: 'finished', tab: 'Finished', kind: 'list' as const, actions: ['focus' as const] };
    const c = config({ recipes: [ref('a'), ref('b')] });
    const { program } = compileProgram(c, {
      a: recipe('a', [], { views: [v], needs: { hosts: ['https://meet.google.com/*'] } }),
      b: recipe('b', []),
    });
    expect(program.views).toEqual([{ ...v, recipeId: 'a' }]);
    expect(program.needs).toEqual({ a: { origins: ['https://meet.google.com/*'], permissions: [] }, b: { origins: [], permissions: [] } });
  });
  it('rule-level needs are keyed by rule key, listed for paused rules too, and not for disabled rules (T10)', () => {
    const MEET = 'https://meet.google.com/*';
    const b = {
      f: recipe('f', [
        rule('oauth'),
        rule('meet', { needs: { hosts: [MEET] } }),
        rule('off', { enabled: false, needs: { hosts: ['https://x.com/*'] } }),
        rule('perm', { needs: { permissions: ['notifications'] } }),
      ]),
    };
    const { program, errors } = compileProgram(config({ recipes: [ref('f')] }), b, { paused: new Set(['f/meet']) });
    expect(errors).toEqual([]);
    expect(program.rules.map((r) => r.key)).toEqual(['f/oauth', 'f/perm']);
    expect(program.needs).toEqual({
      f: { origins: [], permissions: [] },
      'f/meet': { origins: [MEET], permissions: [] },
      'f/perm': { origins: [], permissions: ['notifications'] },
    });
  });
  it('rule-level needs hosts may come from a string[] param (whole array)', () => {
    const b = { f: recipe('f', [rule('m', { needs: { hosts: '{params.h}' as unknown as string[] } })], { params: { h: { type: 'string[]', default: ['https://a.com/*'], label: 'h' } } }) };
    expect(compileProgram(config({ recipes: [ref('f')] }), b).program.needs['f/m']).toEqual({ origins: ['https://a.com/*'], permissions: [] });
  });
  it('a user rule cannot declare needs (R44): it is reported and skipped', () => {
    const { program, errors } = compileProgram(config({ rules: [rule('u', { needs: { hosts: ['https://a.com/*'] } }), rule('v')] }), {});
    expect(errors).toEqual([{ key: 'user/u', error: expect.stringMatching(/needs/) }]);
    expect(program.rules.map((r) => r.key)).toEqual(['user/v']);
    expect(program.needs).toEqual({});
  });
  it('is pure: does not mutate the config or the built-ins', () => {
    const b = { r: recipe('r', [rule('x', { match: { url: '{params.p}' } })], { params: { p: { type: 'string[]', default: ['a.com/*'], label: 'p' } } }) };
    const c = config({ rules: [rule('u')], recipes: [ref('r')] });
    const before = JSON.stringify([c, b]);
    compileProgram(c, b);
    expect(JSON.stringify([c, b])).toBe(before);
  });
});

describe('compileProgram: malformed recipe parts never throw', () => {
  it.each([
    ['needs', { needs: { hosts: 5 } }],
    ['urlTransforms', { dedupe: { urlTransforms: 'x' } }],
    ['urlTransform item', { dedupe: { urlTransforms: [null] } }],
    ['views', { views: ['x'] }],
    ['tables', { tables: 'x' }],
  ])('%s', (_k, over) => {
    const c = config({ recipes: [ref('g')] });
    const b = { g: recipe('g', [rule('x')], over as unknown as Partial<Recipe>) };
    expect(() => compileProgram(c, b)).not.toThrow();
    expect(compileProgram(c, b).errors.map((e) => e.key)).toEqual(['g']);
  });
});

describe('compileProgram: fix round 1 (R37, reserved user id)', () => {
  const BRACES = 'param p: braces are not allowed in values used in templates';
  const tpl = (title: string, color = 'blue', p: unknown = undefined) => {
    const r = recipe('r', [rule('x', { match: { url: 'github.com/:org/*' }, actions: [{ group: { title, color } }] })], {
      params: { p: { type: 'string', default: '{org|upper}', label: 'p' } },
    });
    return compileProgram(config({ recipes: [ref('r', { params: p === undefined ? {} : { p } })] }), { r });
  };
  it('rejects a default with template syntax interpolated into a title', () => {
    const { program, errors } = tpl('A {params.p}');
    expect(errors).toEqual([{ key: 'r', error: BRACES }]);
    expect(program.rules).toEqual([]);
  });
  it('rejects a user value with braces interpolated into a title', () => {
    expect(tpl('A {params.p}', 'blue', 'a{b}').errors).toEqual([{ key: 'r', error: BRACES }]);
  });
  it('rejects braces in a whole-value title placeholder and in a color', () => {
    expect(tpl('{params.p}', 'blue', 'a}').errors).toEqual([{ key: 'r', error: BRACES }]);
    expect(tpl('A', '{params.p}', '{org}').errors).toEqual([{ key: 'r', error: BRACES }]);
  });
  it('a brace-free value still interpolates', () => {
    const { program, errors } = tpl('A {params.p}', 'blue', 'acme');
    expect(errors).toEqual([]);
    expect(program.rules[0]?.rule.actions).toEqual([{ group: { title: 'A acme', color: 'blue' } }]);
  });
  it('braces in a param used outside template fields are fine', () => {
    const r = recipe('r', [rule('x', { match: { url: '{params.p}' } })], { params: { p: { type: 'pattern', default: '/a{2}/', label: 'p' } } });
    expect(compileProgram(config({ recipes: [ref('r')] }), { r }).errors).toEqual([]);
  });
  it('a rule key collision is reported, never silently overwritten (first wins)', () => {
    const errors: { key: string; error: string }[] = [];
    const m = indexByKey([{ key: 'user/a', n: 1 }, { key: 'user/a', n: 2 }, { key: 'r/b', n: 3 }], errors);
    expect([...m.values()].map((e) => e.n)).toEqual([1, 3]);
    expect(errors).toEqual([{ key: 'user/a', error: 'duplicate rule key' }]);
  });
  it('reserves the recipe id "user"', () => {
    const c = config({ rules: [rule('a')], recipes: [ref('user', { source: 'user', body: recipe('user', [rule('a', { actions: [{ group: { title: 'X', color: 'red' } }] })]) })] });
    const { program, errors } = compileProgram(c, {});
    expect(errors).toEqual([{ key: 'user', error: 'recipe id "user" is reserved' }]);
    expect(program.rules.map((r) => [r.key, r.recipeId])).toEqual([['user/a', undefined]]);
  });
});

describe('compileProgram: ruleEnabled overrides (R56)', () => {
  const meet = recipe('m', [
    rule('a'),
    rule('b', { needs: { hosts: ['https://meet.google.com/*'] }, match: { url: 'meet.google.com/*' } }),
    rule('c', { enabled: false, needs: { hosts: ['https://c.example/*'] }, match: { url: 'c.example/*' } }),
  ]);

  it('no entry: the body default applies; absent field = body defaults', () => {
    expect(keys(config({ recipes: [ref('m')] }), { m: meet })).toEqual(['m/a', 'm/b']);
  });

  it('turning a default-on rule off compiles it as disabled', () => {
    expect(keys(config({ recipes: [ref('m', { ruleEnabled: { a: false } })] }), { m: meet })).toEqual(['m/b']);
  });

  it('turning a default-off rule on compiles it as enabled (and the rule is enabled in the Program)', () => {
    const p = compileProgram(config({ recipes: [ref('m', { ruleEnabled: { c: true } })] }), { m: meet }).program;
    expect(p.rules.map((r) => r.key)).toEqual(['m/a', 'm/b', 'm/c']);
    expect(p.rules[2]!.rule.enabled).toBe(true);
  });

  it('github-prs group-by-repo (off by default) turns on via the override', async () => {
    const { builtinRecipes } = await import('../../../src/recipes/load');
    const base = defaultConfig();
    const on = { ...base, recipes: base.recipes.map((r) => (r.id === 'github-prs' ? { ...r, ruleEnabled: { 'group-by-repo': true } } : r)) };
    expect(compileProgram(base, builtinRecipes()).program.rules.map((r) => r.key)).not.toContain('github-prs/group-by-repo');
    const res = compileProgram(on, builtinRecipes());
    expect(res.errors).toEqual([]);
    expect(res.program.rules.map((r) => r.key)).toContain('github-prs/group-by-repo');
  });

  it('R57: no override fill-in: a body rule without `enabled` still fails validateRule (as before R56)', () => {
    const noEnabled = { id: 'x', name: 'x', match: { url: 'a.com/*' }, actions: [{ group: { title: 'X', color: 'blue' } }] } as unknown as Rule;
    const res = compileProgram(config({ recipes: [ref('n')] }), { n: recipe('n', [rule('a'), noEnabled]) });
    expect(res.errors.map((e) => e.key)).toEqual(['n/x']);
    expect(res.program.rules).toEqual([]); // an invalid body rule (author's error) still skips its recipe
  });

  it('R57: a body-off rule turned on that fails to compile is reported for its key; the rest of the recipe runs', () => {
    const broken = recipe('u', [rule('ok'), rule('bad', { enabled: false, match: { url: '/(/' } })]);
    const res = compileProgram(config({ recipes: [ref('u', { ruleEnabled: { bad: true } })] }), { u: broken });
    expect(res.errors).toEqual([{ key: 'u/bad', error: expect.stringMatching(/invalid regex/) }]);
    expect(res.program.rules.map((r) => r.key)).toEqual(['u/ok']);
  });

  it('R57: ruleOn is the one effective-state rule (override, else the body: on unless enabled === false)', async () => {
    const { ruleOn } = await import('../../../src/core/lang/compile');
    expect(ruleOn(ref('m'), rule('a'))).toBe(true);
    expect(ruleOn(ref('m'), rule('a', { enabled: false }))).toBe(false);
    expect(ruleOn(ref('m'), { id: 'a' } as Rule)).toBe(true);
    expect(ruleOn(ref('m', { ruleEnabled: { a: true } }), rule('a', { enabled: false }))).toBe(true);
    expect(ruleOn(ref('m', { ruleEnabled: { a: false } }), rule('a'))).toBe(false);
    expect(ruleOn(ref('m', { ruleEnabled: { a: 'x' as unknown as boolean } }), rule('a'))).toBe(true);
  });

  it('needs follow the effective state; unknown ids are ignored', () => {
    expect(Object.keys(compileProgram(config({ recipes: [ref('m')] }), { m: meet }).program.needs)).toEqual(['m', 'm/b']);
    const flipped = compileProgram(config({ recipes: [ref('m', { ruleEnabled: { b: false, c: true, nope: true } })] }), { m: meet });
    expect(Object.keys(flipped.program.needs)).toEqual(['m', 'm/c']);
    expect(flipped.errors).toEqual([]);
  });

  it('a rule turned off is neither a winner nor a shadower (explain / findShadowed)', async () => {
    const { explainTab, findShadowed } = await import('../../../src/core/lang/explain');
    const shadower = recipe('s', [rule('wide', { match: { url: 'x.com/*' } })]);
    const c = config({ recipes: [ref('s', { ruleEnabled: { wide: false } })], rules: [rule('narrow', { match: { url: 'x.com/a/*' } })] });
    const p = compileProgram(c, { s: shadower }).program;
    expect(findShadowed(p)).toEqual([]);
    const tab = { id: 1, windowId: 1, index: 0, url: 'https://x.com/a/1', title: '', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false };
    expect(explainTab(p, { tab }, 0).map((e) => e.key)).not.toContain('s/wide');
  });
});

describe('compileProgram: age conditions compile (M3-R6, was R66)', () => {
  const match = { all: [{ url: 'example.com/*' }, { not: { age: { lt: '1h' } } }] } as Rule['match'];
  it('a user rule using age compiles', () => {
    const { program, errors } = compileProgram(config({ rules: [rule('old', { match, actions: [{ close: { after: '3s' } }] })] }), {});
    expect(program.rules.map((r) => r.key)).toEqual(['user/old']);
    expect(errors).toEqual([]);
  });
  it('a recipe rule using age (nested under opener) compiles', () => {
    const b = { r: recipe('r', [rule('x', { match: { opener: { age: { gt: '1m' } } } })]) };
    const { program, errors } = compileProgram(config({ recipes: [ref('r')] }), b);
    expect(program.rules.map((r) => r.key)).toEqual(['r/x']);
    expect(errors).toEqual([]);
  });
  it('a bad age duration still does not compile', () => {
    const bad = { age: { gt: 'soon' } } as Rule['match'];
    const { program, errors } = compileProgram(config({ rules: [rule('bad', { match: bad })] }), {});
    expect(program.rules).toEqual([]);
    expect(errors).toEqual([{ key: 'user/bad', error: expect.stringContaining('must be a duration') }]);
  });
});


describe('compileProgram: M3 T1 (sources, needs, conflicts, projects)', () => {
  const src = { connection: 'github', query: 'github.pull_request' as const, args: {}, fields: { state: 'state' } };
  const project = { key: '{key}', title: '{key}', color: 'blue', container: 'group' as const, join: ['rules' as const] };
  it('source and assignProject are recipe-rule-only (M3-R15)', () => {
    const { program, errors } = compileProgram(config({ rules: [
      rule('s', { source: src }), rule('p', { actions: [{ assignProject: { key: 'ABC-1' } }] }), rule('ok'),
    ] }), {});
    expect(errors).toEqual([
      { key: 'user/s', error: expect.stringMatching(/source: only recipe rules/) },
      { key: 'user/p', error: expect.stringMatching(/assignProject: only recipe rules/) },
    ]);
    expect(program.rules.map((r) => r.key)).toEqual(['user/ok']);
  });
  it('a recipe rule may declare a source and assignProject', () => {
    const b = { p: recipe('p', [rule('s', { source: src, actions: [{ assignProject: { key: 'ABC-1' } }] })], { project }) };
    const { program, errors } = compileProgram(config({ recipes: [ref('p')] }), b);
    expect(errors).toEqual([]);
    expect(program.rules.map((r) => r.key)).toEqual(['p/s']);
  });
  it('a recipe\'s project (params substituted) and its params are carried into Program.projects / Program.params (T15)', () => {
    const params = { color: { type: 'string' as const, default: 'blue', label: 'c' }, githubOrgs: { type: 'string[]' as const, default: [], label: 'o' } };
    const b = {
      p: recipe('p', [rule('s', { actions: [{ assignProject: { key: 'ABC-1' } }] })], { project: { ...project, color: '{params.color}' }, params }),
      q: recipe('q', [rule('t')]),
    };
    const { program, errors } = compileProgram(config({ recipes: [ref('p', { params: { color: 'red', githubOrgs: ['acme'] } }), ref('q')] }), b);
    expect(errors).toEqual([]);
    expect(program.projects).toEqual([{ ...project, color: 'red', recipeId: 'p' }]);
    expect(program.params).toEqual({ p: { color: 'red', githubOrgs: ['acme'] } });
    expect(compileProgram(config({ recipes: [ref('q')] }), b).program).not.toHaveProperty('projects');
  });
  it('assignProject in a recipe without a project is an error', () => {
    const b = { p: recipe('p', [rule('s', { actions: [{ assignProject: { key: 'ABC-1' } }] })]) };
    const { program, errors } = compileProgram(config({ recipes: [ref('p')] }), b);
    expect(errors).toEqual([{ key: 'p/s', error: expect.stringMatching(/project/) }]);
    expect(program.rules).toEqual([]);
  });
  it('project.<name> fields are not supported yet (M3-R11)', () => {
    const b = { p: recipe('p', [rule('s', { match: { all: [{ url: '*' }, { field: { field: 'project.key', op: '==', value: 'x' } }] } })]) };
    const { errors } = compileProgram(config({ recipes: [ref('p')] }), b);
    expect(errors).toEqual([{ key: 'p/s', error: expect.stringMatching(/project fields are not supported yet/) }]);
  });
  it('needs.anyOf and needs.connections compile into Program.needs (M3-R63), recipe-level and rule-level', () => {
    const anyOf = { anyOf: [{ connections: ['github'] }, { hosts: ['https://github.com/*'] }, {}] };
    const r1 = compileProgram(config({ recipes: [ref('p')] }), { p: recipe('p', [rule('a', { needs: { connections: ['jira'] } })], { needs: anyOf }) });
    expect(r1.errors).toEqual([]);
    expect(r1.program.needs).toEqual({
      p: { origins: [], permissions: [], anyOf: [
        { origins: [], permissions: [], connections: ['github'] },
        { origins: ['https://github.com/*'], permissions: [] },
        { origins: [], permissions: [] },
      ] },
      'p/a': { origins: [], permissions: [], connections: ['jira'] },
    });
  });
  it('a needs.anyOf alternative with its own anyOf is an error', () => {
    const nested = { anyOf: [{ anyOf: [{ hosts: ['https://github.com/*'] }] }] };
    const { program, errors } = compileProgram(config({ recipes: [ref('p')] }), { p: recipe('p', [rule('a', { needs: nested })]) });
    expect(errors).toEqual([{ key: 'p/a', error: expect.stringMatching(/needs\.anyOf.*own anyOf/) }]);
    expect(program.rules).toEqual([]);
  });
  it('a recipe\'s levels are carried into Program.levels by recipe id', () => {
    const levels = [{ id: 'titles', label: 'Titles', rules: ['a'] }];
    const { program } = compileProgram(config({ recipes: [ref('p'), ref('q')] }), { p: recipe('p', [rule('a')], { levels }), q: recipe('q', [rule('b')]) });
    expect(program.levels).toEqual({ p: levels });
  });
  it('conflicting recipes both enabled: reported, and the later one in config.recipes is skipped (M3-R17)', () => {
    const b = { a: recipe('a', [rule('x')], { conflicts: ['b'] }), b: recipe('b', [rule('y')]) };
    const { program, errors } = compileProgram(config({ recipes: [ref('b'), ref('a')] }), b);
    expect(errors).toEqual([{ key: 'a', error: expect.stringMatching(/conflicts with recipe "b"/) }]);
    expect(program.rules.map((r) => r.key)).toEqual(['b/y']);
    expect(Object.keys(program.needs)).toEqual(['b']);
    // Declared on the earlier recipe instead: still the later one is skipped.
    const b2 = { a: recipe('a', [rule('x')]), b: recipe('b', [rule('y')], { conflicts: ['a'] }) };
    const r2 = compileProgram(config({ recipes: [ref('b'), ref('a')] }), b2);
    expect(r2.errors).toEqual([{ key: 'a', error: expect.stringMatching(/conflicts with recipe "b"/) }]);
    expect(r2.program.rules.map((r) => r.key)).toEqual(['b/y']);
    // One of them disabled: no conflict.
    expect(compileProgram(config({ recipes: [ref('b'), ref('a', { enabled: false })] }), b).errors).toEqual([]);
  });
});
