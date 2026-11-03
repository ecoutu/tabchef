// docs/recipes.md stays true to the code. Its fenced code blocks are marked with an HTML comment on the line before:
// - `<!-- example: <recipe>/<rule> -->`: the block is that built-in recipe rule, exactly (parsed and deep-compared).
// - `<!-- example: <recipe> -->`: the block is an excerpt of that built-in recipe: every key it shows, at any depth,
//   has the recipe's value (lists compare item by item).
// - `<!-- user-rule -->`: the block is one rule of your own that compiles with no errors.
// - `<!-- user-config -->`: the block holds `rules` and `tables` of your own config that compile with no errors.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { builtinRecipes } from '../../src/recipes/load';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';
import type { Rule } from '../../src/core/lang/types';
import type { Config } from '../../src/core/types';

const DOC = readFileSync(join(__dirname, '../../docs/recipes.md'), 'utf8');

interface Block { marker: string; line: number; data: unknown }

/** Every marked fenced block of `md`: the marker comment, its line, and the block parsed (YAML, which reads JSON too). */
function markedBlocks(md: string): Block[] {
  const re = /^<!-- ([^\n]*?) -->\n```(?:yaml|json)\n([\s\S]*?)^```$/gm;
  return [...md.matchAll(re)].map((m) => ({
    marker: m[1] as string,
    line: md.slice(0, m.index).split('\n').length,
    data: parse(m[2] as string) as unknown,
  }));
}

const blocks = markedBlocks(DOC);
const examples = blocks.filter((b) => b.marker.startsWith('example: '));
const builtins = builtinRecipes();

/** A config with the user's rules (and tables) on top of the defaults, all built-in recipes as they come. */
const userConfig = (rules: Rule[], tables: Config['tables'] = {}): Config =>
  ({ ...defaultConfig(), rules, tables, order: rules.map((r) => `user/${r.id}`) });

describe('docs/recipes.md', () => {
  it('marks every example comment right before a yaml or json block', () => {
    const comments = [...DOC.matchAll(/^<!-- (example: [^\n]*?|user-rule|user-config) -->$/gm)].length;
    expect(blocks.length).toBe(comments);
  });

  it('has at least three worked examples, from three built-in recipes', () => {
    const recipes = new Set(examples.map((b) => b.marker.slice('example: '.length).split('/')[0]));
    expect(recipes.size).toBeGreaterThanOrEqual(3);
  });

  for (const b of examples) {
    const [recipeId, ruleId, ...rest] = b.marker.slice('example: '.length).split('/');
    it(`line ${b.line}: ${b.marker} matches the built-in recipe`, () => {
      expect(rest, 'marker is <recipe> or <recipe>/<rule>').toEqual([]);
      const recipe = builtins[recipeId as string];
      expect(recipe, `no built-in recipe "${recipeId}"`).toBeDefined();
      if (ruleId !== undefined) {
        const rule = recipe!.rules.find((r) => r.id === ruleId);
        expect(rule, `recipe ${recipeId} has no rule "${ruleId}"`).toBeDefined();
        expect(b.data).toEqual(rule);
      } else {
        expect(b.data).toBeTypeOf('object');
        expect(Object.keys(b.data as object).length).toBeGreaterThan(0);
        expect(recipe).toMatchObject(b.data as object);
      }
    });
  }

  for (const b of blocks.filter((x) => x.marker === 'user-rule')) {
    it(`line ${b.line}: the user rule compiles`, () => {
      const { program, errors } = compileProgram(userConfig([b.data as Rule]), builtins);
      expect(errors).toEqual([]);
      expect(program.rules.some((r) => r.key === `user/${(b.data as Rule).id}`)).toBe(true);
    });
  }

  for (const b of blocks.filter((x) => x.marker === 'user-config')) {
    it(`line ${b.line}: the user config compiles`, () => {
      const { rules, tables } = b.data as { rules: Rule[]; tables?: Config['tables'] };
      const { program, errors } = compileProgram(userConfig(rules, tables), builtins);
      expect(errors).toEqual([]);
      for (const r of rules) expect(program.rules.some((x) => x.key === `user/${r.id}`)).toBe(true);
    });
  }
});
