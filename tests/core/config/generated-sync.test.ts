import { describe, it, expect } from 'vitest';
import committed from '../../../src/core/config/validate-config.generated.js?raw';
import committedDts from '../../../src/core/config/validate-config.generated.d.ts?raw';
import committedRecipeRule from '../../../src/core/lang/recipe-rule.schema.generated.json?raw';
import * as generated from '../../../src/core/config/validate-config.generated.js';
// @ts-expect-error plain .mjs script without types
import { EXPORTS, generate, generateRecipeRuleSchema, MAX_REGEX } from '../../../scripts/gen-validator.mjs';
import { MAX_REGEX_LEN } from '../../../src/core/match/pattern';

describe('generated validator', () => {
  it('matches the committed file (run `npm run gen:validator` after editing a *.schema.json)', () => {
    expect(generate()).toBe(committed);
  });
  it('the derived recipe-rule schema matches the committed file (run `npm run gen:validator`)', () => {
    expect(generateRecipeRuleSchema()).toBe(committedRecipeRule);
  });
  it('caps recipe-rule regexes at the same limit as the TS regex check', () => {
    expect(MAX_REGEX).toBe(MAX_REGEX_LEN);
  });
  it('is self-contained: no require() of ajv runtime helpers (the extension bundles it as ESM)', () => {
    expect(committed).not.toMatch(/\brequire\(/);
  });
  it('exports, and declares in the .d.ts, every validator the generator lists', () => {
    const names = Object.keys(EXPORTS as Record<string, string>);
    expect(names).toEqual(expect.arrayContaining(['validate', 'validateRule', 'validateRecipe', 'validateConfigV1']));
    expect(Object.keys(generated).sort()).toEqual([...names].sort());
    for (const n of names) {
      expect(typeof (generated as Record<string, unknown>)[n], n).toBe('function');
      expect(committedDts, n).toMatch(new RegExp(`export const ${n}: ValidateFn;`));
    }
  });
});
