// #24: Vitest's file-system module cache (node_modules/.vitest-cache) skips a module that uses `import.meta.glob(`, but
// not `import.meta.glob<T>(` as src/recipes/load.ts writes it, so a new built-in recipe YAML was missing from
// builtinRecipes() until `npx vitest --clearCache`. vitest.config.ts's `globCacheBust` plugin keeps such modules out of
// that cache. This test runs Vitest twice on a copy of the setup in a temp dir, with its own cache, and adds and edits a
// recipe YAML between the runs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const VITEST = join(ROOT, 'node_modules/vitest/vitest.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const recipe = (id: string, name: string): string => `recipe: ${id}\nversion: 1\nname: ${name}\ndescription: x\nrules: []\n`;

/** The recipes the copy of load.ts sees in one Vitest run, as `id=name` pairs. */
function run(dir: string): string[] {
  const r = spawnSync(process.execPath, [VITEST, 'run', '--root', dir, '--config', join(dir, 'vitest.config.mjs'), '--silent=false'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, timeout: 60_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  expect(r.status, out).toBe(0);
  return JSON.parse(/RECIPES (\[.*\])/.exec(out)?.[1] ?? 'null') as string[];
}

describe('built-in recipe cache (#24)', () => {
  it('a new or edited recipe YAML is seen by the next run without --clearCache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabchef-cache-bust-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'builtin'));
    writeFileSync(join(dir, 'builtin/alpha.yaml'), recipe('alpha', 'Alpha'));
    // load.ts's glob, with its type argument (the form the cache did not recognize).
    writeFileSync(join(dir, 'load.ts'), [
      "const mods = import.meta.glob<{ name: string }>('./builtin/*.yaml', { eager: true, import: 'default' });",
      'export const recipes = (): string[] => Object.entries(mods).map(([f, m]) => `${/([^/]+)\\.yaml$/.exec(f)![1]}=${m.name}`).sort();',
    ].join('\n'));
    writeFileSync(join(dir, 'probe.test.ts'), [
      "import { recipes } from './load';",
      "test('probe', () => { console.log(`RECIPES ${JSON.stringify(recipes())}`); });",
    ].join('\n'));
    writeFileSync(join(dir, 'vitest.config.mjs'), [
      `import { yamlJson } from ${JSON.stringify(join(ROOT, 'wxt.config.ts'))};`,
      `import { globCacheBust } from ${JSON.stringify(join(ROOT, 'vitest.config.ts'))};`,
      "export default { plugins: [yamlJson, globCacheBust], test: { globals: true, include: ['probe.test.ts'], fsModuleCachePath: './.cache' } };",
    ].join('\n'));

    expect(run(dir)).toEqual(['alpha=Alpha']);
    writeFileSync(join(dir, 'builtin/beta.yaml'), recipe('beta', 'Beta'));
    writeFileSync(join(dir, 'builtin/alpha.yaml'), recipe('alpha', 'Alpha 2'));
    expect(run(dir)).toEqual(['alpha=Alpha 2', 'beta=Beta']);
  }, 120_000);
});
