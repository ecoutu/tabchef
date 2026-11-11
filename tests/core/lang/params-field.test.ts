// `params.<name>` field conditions in a recipe rule's match: the recipe's setting decides part of the match, with the
// same comparison as a view's `params.*` show fields. Only recipe rules have params: a user rule with one, or a recipe
// rule naming an undeclared param, is an error (like an undeclared `{params.x}` placeholder).
import { describe, it, expect } from 'vitest';
import { compileProgram } from '../../../src/core/lang/compile';
import { evalCond } from '../../../src/core/lang/cond';
import { evaluateTab } from '../../../src/core/lang/evaluate';
import { explainTab, findShadowed } from '../../../src/core/lang/explain';
import { validateRecipe, validateRule } from '../../../src/core/lang/schema';
import { defaultConfig } from '../../../src/core/config/defaults';
import { inactiveReason, ruleRows, ruleSummary } from '../../../src/ui/rules-model';
import type { Cond, Recipe, RecipeRef, Rule } from '../../../src/core/lang/types';
import type { Config, TabSnap } from '../../../src/core/types';

const NOW = 1_800_000_000_000;
const tab = (url: string): TabSnap => ({
  id: 1, windowId: 1, index: 0, url, title: 't', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false,
});
const FLAG: Cond = { field: { field: 'params.flag', op: '==', value: true } };
const MATCH: Cond = { any: [{ url: 'a.com/*' }, { all: [{ url: 'b.com/*' }, FLAG] }] };
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'x', name: 'X', enabled: true, match: MATCH, actions: [{ group: { title: 'G', color: 'blue' } }], ...over,
});
const recipe = (rules: Rule[] = [rule()], params: Recipe['params'] = { flag: { type: 'boolean', default: false, label: 'Flag' } }): Recipe => ({
  recipe: 'r', version: 1, name: 'R', description: 'R', params, rules,
});
const ref = (params: Record<string, unknown> = {}): RecipeRef => ({ id: 'r', enabled: true, params, source: 'builtin' });
const config = (over: Partial<Config> = {}): Config => ({ ...defaultConfig(), recipes: [ref()], ...over });
const compiled = (params: Record<string, unknown> = {}, body = recipe()) => compileProgram(config({ recipes: [ref(params)] }), { r: body });
const groups = (params: Record<string, unknown>, url: string) => {
  const { program, errors } = compiled(params);
  expect(errors).toEqual([]);
  return evaluateTab(program, { tab: tab(url) }, NOW).group?.title;
};

describe('params.<name> fields in a recipe rule match', () => {
  it('follow the recipe setting: off by default, on when the user turns it on', () => {
    expect(groups({}, 'https://a.com/1')).toBe('G');
    expect(groups({}, 'https://b.com/1')).toBeUndefined();
    expect(groups({ flag: false }, 'https://b.com/1')).toBeUndefined();
    expect(groups({ flag: true }, 'https://b.com/1')).toBe('G');
    expect(groups({ flag: true }, 'https://c.com/1')).toBeUndefined();
  });

  it('compare like any field: !=, not, in and string params', () => {
    const body = (match: Cond) => recipe([rule({ match })], {
      flag: { type: 'boolean', default: false, label: 'F' }, mode: { type: 'string', default: 'a', label: 'M' },
    });
    const hit = (match: Cond, params: Record<string, unknown> = {}) => {
      const { program, errors } = compiled(params, body(match));
      expect(errors).toEqual([]);
      return evaluateTab(program, { tab: tab('https://a.com/') }, NOW).group !== undefined;
    };
    expect(hit({ not: FLAG })).toBe(true);
    expect(hit({ not: FLAG }, { flag: true })).toBe(false);
    expect(hit({ field: { field: 'params.flag', op: '!=', value: true } })).toBe(true);
    expect(hit({ field: { field: 'params.mode', op: 'in', value: ['a', 'b'] } })).toBe(true);
    expect(hit({ field: { field: 'params.mode', op: '==', value: 'b' } })).toBe(false);
    expect(hit({ field: { field: 'params.mode', op: '==', value: 'b' } }, { mode: 'b' })).toBe(true);
  });

  it('an undeclared params.<name> is an error for the recipe, like an undeclared {params.x}', () => {
    const body = recipe([rule({ match: { all: [{ url: 'a.com/*' }, { field: { field: 'params.nope', op: '==', value: true } }] } })]);
    const { program, errors } = compiled({}, body);
    expect(errors.map((e) => e.key)).toEqual(['r/x']);
    expect(errors[0]?.error).toMatch(/unknown param: params\.nope/);
    expect(program.rules).toEqual([]);
    const v = validateRecipe(body);
    expect(v.ok ? [] : v.errors).toEqual([{ path: '/rules/0/match/all/1/field/field', message: 'unknown param: params.nope' }]);
    expect(validateRecipe(recipe()).ok).toBe(true);
  });

  it('a user rule cannot read params: it is reported and skipped', () => {
    const { program, errors } = compileProgram(config({ recipes: [], rules: [rule({ id: 'u' })] }), {});
    expect(errors).toEqual([{ key: 'user/u', error: expect.stringMatching(/only recipe rules have params/) }]);
    expect(program.rules).toEqual([]);
    // Like `source`, the rule itself is well formed (the YAML editor accepts it); compileProgram reports it.
    expect(validateRule(rule()).ok).toBe(true);
    expect(validateRule(rule(), new Set(['other'])).ok).toBe(false);
  });

  it('evalCond reads them from the scope; with no params in scope they are unknown', () => {
    expect(evalCond(FLAG, { tab: tab('https://a.com/') }, NOW, { ruleKey: 'r/x', params: { flag: true } }).ok).toBe(true);
    expect(evalCond(FLAG, { tab: tab('https://a.com/') }, NOW, { ruleKey: 'r/x', params: { flag: false } }).ok).toBe(false);
    expect(evalCond(FLAG, { tab: tab('https://a.com/') }, NOW, { ruleKey: 'r/x' })).toEqual(expect.objectContaining({ ok: false, unknown: true }));
  });

  it('explain, the shadowed-rules check and the Rules page handle them', () => {
    const { program } = compiled();
    expect(explainTab(program, { tab: tab('https://b.com/1') }, NOW)).toEqual([]);
    expect(explainTab(program, { tab: tab('https://a.com/1') }, NOW).map((e) => [e.key, e.matched])).toEqual([['r/x', true]]);
    expect(explainTab(compiled({ flag: true }).program, { tab: tab('https://b.com/1') }, NOW).map((e) => e.matched)).toEqual([true]);
    expect(() => findShadowed(program)).not.toThrow();
    const rows = ruleRows(config(), { r: recipe() });
    expect(rows.map((r) => [r.key, r.kind === 'recipe' ? r.error : 'user'])).toEqual([['r/x', undefined]]);
    const shown = rows[0]!.rule;
    expect(ruleSummary(shown)[0]).toBe('Match: any of (url a.com/*; all of (url b.com/*; params.flag == true))');
    expect(inactiveReason(shown)).toBeUndefined();
  });
});
