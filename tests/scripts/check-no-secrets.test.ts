import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/check-no-secrets.mjs';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Writes `files` (relative path -> content) into a fresh temp dir, runs the guard on it, returns the exit code. */
function run(files: Record<string, string>): number {
  const dir = mkdtempSync(join(tmpdir(), 'nosecrets-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  try {
    execFileSync('node', [SCRIPT, dir], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

const GH = 'ghp_' + 'a'.repeat(24);

describe('check-no-secrets', () => {
  it('passes on clean sources', () => {
    expect(run({ 'a.js': 'export const x = 1;', 'content-scripts/c.js': 'console.log(1)' })).toBe(0);
  });
  it('fails on client_secret', () => expect(run({ 'a.ts': "const o = { client_secret: 'x' };" })).toBe(1));
  it.each([GH, 'github_pat_' + 'B'.repeat(24), 'ATATT' + 'c'.repeat(24)])('fails on token literal %s', (t) => {
    expect(run({ 'a.js': `const t = "${t}";` })).toBe(1);
  });
  it('fails on conn.secret./conn.access. inside content-scripts', () => {
    expect(run({ 'content-scripts/c.js': 'get("conn.secret.github")' })).toBe(1);
    expect(run({ 'content-scripts/c.js': 'get(`conn.access.jira`)' })).toBe(1);
  });
  it('allows conn.secret. outside content-scripts (the background owns it)', () => {
    expect(run({ 'background.js': 'get("conn.secret.github");x({allowLocalhost:!1})' })).toBe(0);
  });
  it('enforces the content-script check when the content-scripts dir itself is the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nosecrets-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'content-scripts'));
    writeFileSync(join(dir, 'content-scripts', 'c.js'), 'get("conn.secret.x")');
    expect(() => execFileSync('node', [SCRIPT, join(dir, 'content-scripts')], { stdio: 'pipe' })).toThrow();
  });
  it('e2e flag: !1 and false pass; !0, true and non-literals fail; a missing flag fails', () => {
    expect(run({ 'background.js': 'x({allowLocalhost:!1})' })).toBe(0);
    expect(run({ 'background.js': 'x({allowLocalhost:false})' })).toBe(0);
    expect(run({ 'background.js': 'x({allowLocalhost:!0})' })).toBe(1);
    expect(run({ 'background.js': 'x({allowLocalhost:true})' })).toBe(1);
    expect(run({ 'background.js': 'x({allowLocalhost:x})' })).toBe(1);
    expect(run({ 'background.js': 'x({allowLocalhost})' })).toBe(1);
    expect(run({ 'background.js': 'x({})' })).toBe(1);
  });
  it('does not skip tests/fixtures dirs inside a built bundle', () => {
    expect(run({ 'background.js': 'x({allowLocalhost:!1})', 'tests/a.js': `"${GH}"` })).toBe(1);
  });
  it('excludes tests and fixtures', () => {
    expect(run({ 'tests/fixtures/a.json': `{"t":"${GH}"}`, 'x/a.test.ts': `"${GH}"`, 'fixtures/m3/b.json': 'client_secret' })).toBe(0);
  });
  it('the repo source tree is clean', () => {
    execFileSync('node', [SCRIPT, 'src'], { stdio: 'pipe' });
  });
  it('mirrors the exported redaction token regex (M3-R87)', () => {
    const lit = (f: string, re: RegExp) => /\/(.+)\/[a-z]*;/.exec(re.exec(readFileSync(f, 'utf8'))![0])![1];
    const shared = lit('src/core/connections/redact.ts', /TOKEN_PATTERN = \/.+\/[a-z]*;/);
    const mine = lit(SCRIPT, /TOKEN_PATTERN = \/.+\/[a-z]*;/);
    expect(mine).toBe(shared);
  });
});
