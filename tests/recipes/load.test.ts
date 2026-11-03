import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { builtinRecipes, loadRecipes } from '../../src/recipes/load';
import { validateRecipe } from '../../src/core/lang/schema';
import { compileProgram } from '../../src/core/lang/compile';
import { defaultConfig } from '../../src/core/config/defaults';

const BUILTIN_DIR = join(__dirname, '../../src/recipes/builtin');
const yamlFiles = readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.yaml'));

describe('built-in recipes', () => {
  it('every built-in YAML file validates', () => {
    expect(yamlFiles.length).toBeGreaterThan(0);
    for (const f of yamlFiles) expect(validateRecipe(parse(readFileSync(join(BUILTIN_DIR, f), 'utf8'))), f).toMatchObject({ ok: true });
  });
  it('builtinRecipes() holds every file, keyed by recipe id (= file name), pre-parsed at build time', () => {
    const b = builtinRecipes();
    expect(Object.keys(b).sort()).toEqual(yamlFiles.map((f) => f.replace(/\.yaml$/, '')).sort());
    for (const f of yamlFiles) expect(b[f.replace(/\.yaml$/, '')]).toEqual(parse(readFileSync(join(BUILTIN_DIR, f), 'utf8')));
  });
  it('duplicates is views only for now (T6 adds rules)', () => {
    expect(builtinRecipes().duplicates).toMatchObject({
      recipe: 'duplicates', rules: [],
      views: [{ id: 'duplicates', tab: 'Duplicates', kind: 'duplicates', actions: ['focus', 'close', 'close-all'] }],
    });
  });
  it('every built-in compiles with default params (alone: the jira-ticket variants conflict, M3-R17)', () => {
    const b = builtinRecipes();
    for (const id of Object.keys(b)) {
      const config = { ...defaultConfig(), recipes: [{ id, enabled: true, params: {}, source: 'builtin' as const }] };
      expect(compileProgram(config, b).errors).toEqual([]);
    }
  });
  it('built-in recipes are frozen', () => {
    expect(Object.isFrozen(builtinRecipes().duplicates)).toBe(true);
    expect(Object.isFrozen(builtinRecipes().duplicates?.views)).toBe(true);
  });
});

describe('loadRecipes', () => {
  const good = { recipe: 'a', version: 1, name: 'A', description: 'A', rules: [] };
  it('keys recipes by file name', () => {
    expect(Object.keys(loadRecipes({ './builtin/a.yaml': good }))).toEqual(['a']);
  });
  it('throws on an invalid recipe, naming the file and the error path', () => {
    expect(() => loadRecipes({ './builtin/a.yaml': { ...good, version: 'x' } })).toThrow(/a\.yaml.*\n.*\/version/);
  });
  it('throws when the recipe id does not match the file name', () => {
    expect(() => loadRecipes({ './builtin/b.yaml': good })).toThrow(/b\.yaml/);
  });
});

describe('src/recipes/load.ts module load', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lang/schema');
    vi.resetModules();
  });
  it('throws at module load when a built-in recipe is invalid', async () => {
    vi.resetModules();
    vi.doMock('../../src/core/lang/schema', () => ({ validateRecipe: () => ({ ok: false, errors: [{ path: '/rules', message: 'broken on purpose' }] }) }));
    await expect(import('../../src/recipes/load')).rejects.toThrow(/broken on purpose/);
  });
});

describe('validate:recipes script', () => {
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', ['scripts/run-ts.mjs', 'scripts/validate-recipes.ts', ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: err.stdout + err.stderr };
    }
  };
  it('exits 0 on the built-ins', () => {
    expect(run([])).toMatchObject({ code: 0 });
  }, 30_000);
  it('exits 1 on an invalid file, printing path: message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabchef-recipes-'));
    try {
      const f = join(dir, 'bad.yaml');
      writeFileSync(f, 'recipe: bad\nversion: 1\nname: Bad\ndescription: Bad\nrules:\n  - id: r\n    name: R\n    enabled: true\n    match: { url: "a.com/*" }\n    actions: [{ eval: x }]\n');
      const r = run([f]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/bad\.yaml: \/rules\/0\/actions\/0: .*eval/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
  it('exits 1 when a recipe validates but does not compile with its defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabchef-recipes-'));
    try {
      // Schema-valid (table names are only known once merged), but the compiler finds no `nope` table.
      const f = join(dir, 'tbl.yaml');
      writeFileSync(f, 'recipe: tbl\nversion: 1\nname: T\ndescription: T\nrules:\n  - id: r\n    name: R\n    enabled: true\n    match: { url: "github.com/:repo/*" }\n    actions: [{ group: { title: A, color: "{repo|map:nope|default:grey}" } }]\n');
      const r = run([f]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/tbl\.yaml: tbl\/r: .*unknown table: nope/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
  it('exits 1 on unparsable YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabchef-recipes-'));
    try {
      const f = join(dir, 'broken.yaml');
      writeFileSync(f, 'recipe: [unclosed\n');
      expect(run([f]).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
