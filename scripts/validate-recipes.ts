// Validates recipe YAML files (D32): schema, TS post-checks, then compileProgram with default params.
// Usage: npm run validate:recipes [-- file.yaml ...]   (default: src/recipes/builtin/*.yaml)
// Prints `file: path: message` per problem and exits 1 on any; 0 when all are valid.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { validateRecipe } from '../src/core/lang/schema';
import { compileProgram } from '../src/core/lang/compile';
import { defaultConfig } from '../src/core/config/defaults';

const BUILTIN_DIR = 'src/recipes/builtin';

/** Problems of one recipe file as `path: message` lines (empty when valid). */
export function checkFile(file: string): string[] {
  let data: unknown;
  try {
    data = parse(readFileSync(file, 'utf8'), { prettyErrors: true });
  } catch (e) {
    return [`/: ${(e as Error).message.split('\n')[0]}`];
  }
  const v = validateRecipe(data);
  if (!v.ok) return v.errors.map((e) => `${e.path}: ${e.message}`);
  const id = v.recipe.recipe;
  const config = { ...defaultConfig(), rules: [], order: [], recipes: [{ id, enabled: true, params: {}, source: 'builtin' as const }] };
  return compileProgram(config, { [id]: v.recipe }).errors.map((e) => `${e.key}: ${e.error}`);
}

export default function main(args: string[]): number {
  const files = args.length ? args : readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.yaml')).sort().map((f) => join(BUILTIN_DIR, f));
  let bad = 0;
  for (const f of files) {
    const problems = checkFile(f);
    for (const p of problems) console.error(`${relative(process.cwd(), f) || f}: ${p}`);
    if (problems.length) bad++;
  }
  console.log(`${files.length - bad}/${files.length} recipe file(s) valid`);
  return bad ? 1 : 0;
}
