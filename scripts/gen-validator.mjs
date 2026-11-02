// Precompiles the JSON schemas into standalone validators (no eval / new Function at runtime, required by MV3 CSP).
// One module, several exports: validate (config v2), validateRule (one rule), validateRecipe (one recipe),
// validateConfigV1 (M1 config, migration).
// No custom keywords: regex/pattern/template/duration checks are TS post-validation (src/core/config/schema.ts,
// src/core/lang/schema.ts). Avoid keywords whose standalone code require()s ajv runtime helpers (uniqueItems, enum or
// const with object values, and maxLength/minLength without `unicode: false`); a test guards this.
//
// Also writes src/core/lang/recipe-rule.schema.generated.json: rule.schema.json where every typed leaf may instead be
// an exact `{params.<name>}` placeholder (R14), so recipe rules are checked against the one rule schema, and every
// free-form string has a length cap (see cap()).
// Usage: node scripts/gen-validator.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';

const root = new URL('../', import.meta.url);
const RULE_SCHEMA = 'src/core/lang/rule.schema.json';
const RECIPE_RULE_SCHEMA = 'src/core/lang/recipe-rule.schema.generated.json';
const SCHEMAS = [RULE_SCHEMA, 'src/core/lang/recipe.schema.json', 'src/core/config/config.schema.json', 'src/core/config/config-v1.schema.json'];
export const EXPORTS = {
  validate: 'https://schemas.tabchef.invalid/config.json',
  validateRule: 'https://schemas.tabchef.invalid/rule.json',
  validateRecipe: 'https://schemas.tabchef.invalid/recipe.json',
  validateConfigV1: 'https://schemas.tabchef.invalid/config-v1.json',
};
export const outPath = new URL('src/core/config/validate-config.generated.js', root);
export const recipeRuleOutPath = new URL(RECIPE_RULE_SCHEMA, root);

const read = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const PLACEHOLDER = { $ref: 'recipe.json#/$defs/placeholder' };
const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
/** A schema for one typed scalar value: an enum/const, a boolean/number, or a string with a pattern. */
const scalar = (s) => isObj(s) && ('enum' in s || 'const' in s || ['boolean', 'number', 'integer'].includes(s.type) || (s.type === 'string' && 'pattern' in s));
/**
 * An array of scalars or strings (a whole list can come from one `string[]` param); not lists of conds, actions or
 * other object defs (`needs.anyOf`, M3-R14).
 */
const scalarList = (s) => isObj(s) && s.type === 'array' && isObj(s.items) && !('$ref' in s.items && /cond|action|needs/.test(s.items.$ref)) && s.items.type !== 'object';

/**
 * `s` with each typed leaf wrapped as `oneOf: [leaf, placeholder]`. A list that is itself a `oneOf` branch (e.g.
 * `url: pattern | pattern[]`) is not wrapped: its string sibling already accepts the placeholder, and wrapping would
 * make a placeholder match two branches.
 */
function placeholderize(s, branch = false) {
  if (!isObj(s)) return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'properties' || k === '$defs') {
      // Rule ids stay literal: they are rule keys (R19) and appear in `order`.
      out[k] = Object.fromEntries(Object.entries(v).map(([n, x]) => [n, k === '$defs' && n === 'id' ? x : placeholderize(x)]));
    } else if (k === 'propertyNames' || k === 'enum' || k === 'const') out[k] = v;
    else if (k === 'oneOf' || k === 'anyOf') out[k] = v.map((x) => placeholderize(x, true));
    else out[k] = placeholderize(v);
  }
  return scalar(s) || (scalarList(s) && !branch) ? { oneOf: [out, PLACEHOLDER] } : out;
}

/** Length caps for recipe rules (strings <= 2048; URL/title patterns and regexes <= 500). */
export const MAX_STRING = 2048;
export const MAX_REGEX = 500;
/**
 * `s` with `maxLength` on every free-form string: MAX_REGEX for the `pattern` def and `regex` properties, MAX_STRING
 * otherwise. Only the derived recipe-rule schema is capped: rule.schema.json also checks stored config, where a
 * disabled rule from a laxer version must still load (src/core/config/schema.ts caps enabled rules' regexes in TS).
 */
function cap(s, key) {
  if (Array.isArray(s)) return s.map((x) => cap(x));
  if (!isObj(s)) return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'properties' || k === '$defs') out[k] = Object.fromEntries(Object.entries(v).map(([n, x]) => [n, cap(x, n)]));
    else if (k === 'enum' || k === 'const') out[k] = v;
    else out[k] = cap(v);
  }
  if (s.type === 'string' && !('maxLength' in s) && !('pattern' in s) && !('enum' in s) && !('const' in s)) {
    out.maxLength = key === 'pattern' || key === 'regex' ? MAX_REGEX : MAX_STRING;
  }
  return out;
}

/** The derived recipe-rule schema, as the committed file's text. */
export function generateRecipeRuleSchema() {
  const rule = read(RULE_SCHEMA);
  const { $id: _id, $comment: _c, ...rest } = rule;
  const derived = {
    $id: 'https://schemas.tabchef.invalid/recipe-rule.json',
    $comment: `@generated by scripts/gen-validator.mjs from ${RULE_SCHEMA}. Do not edit. Typed leaves also accept an exact {params.<name>} placeholder (R14); strings are capped at ${MAX_STRING} characters, patterns and regexes at ${MAX_REGEX}.`,
    ...placeholderize(cap(rest)),
  };
  return JSON.stringify(derived, null, 2) + '\n';
}

export function generate() {
  const ajv = new Ajv({ allErrors: true, unicode: false, code: { source: true, esm: true } });
  for (const p of SCHEMAS) ajv.addSchema(read(p));
  ajv.addSchema(JSON.parse(generateRecipeRuleSchema()));
  return '// @generated by scripts/gen-validator.mjs from the *.schema.json files it lists. Do not edit.\n' + standaloneCode(ajv, EXPORTS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(recipeRuleOutPath, generateRecipeRuleSchema());
  console.log('wrote', fileURLToPath(recipeRuleOutPath));
  writeFileSync(outPath, generate());
  console.log('wrote', fileURLToPath(outPath));
}
