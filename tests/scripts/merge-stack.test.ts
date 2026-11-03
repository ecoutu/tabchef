import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/merge-stack.sh';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A fake `gh`: `pr list` prints $FAKE_PRS, `api` prints $FAKE_FORCE_PUSHED; every call is logged to $FAKE_LOG.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pr list") printf '%s' "$FAKE_PRS" ;;
  "api "*) echo "\${FAKE_FORCE_PUSHED:-false}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`;

type Pr = [number: number, state: string, base: string, head: string, title: string];

/** Runs a --single-release dry run of `args` against the fake gh listing `prs`. */
function run(prs: Pr[], args: string[], forcePushed = false) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-stack-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const tsv = prs.map(([n, s, b, h, t]) => [n, s, b, h, `oid${n}`, t].join('\t') + '\n').join('');
  const r = spawnSync('bash', [SCRIPT, '--single-release', '--dry-run', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_PRS: tsv, FAKE_LOG: log,
      FAKE_FORCE_PUSHED: String(forcePushed) },
  });
  return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n') };
}

const FIRST: Pr = [1, 'OPEN', 'main', 'a', 'ci: one'];
const STACK: Pr[] = [
  FIRST,
  [2, 'OPEN', 'a', 'b', 'feat(x): two'],
  [3, 'OPEN', 'b', 'c', 'fix: three'],
];

describe('merge-stack.sh validation', () => {
  it('reads every PR with a single gh call', () => {
    const r = run(STACK, ['1', '2', '3']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Done (single-release).');
    expect(r.calls).toEqual([expect.stringMatching(/^pr list --state all /)]);
  });
  it('rejects a broken chain', () => {
    const r = run([FIRST, [2, 'OPEN', 'main', 'b', 'feat: two']], ['1', '2']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('PR #2 targets main, expected a');
  });
  it('reports a PR it cannot find', () => {
    const r = run(STACK, ['1', '7']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('PR #7 not found');
  });
  it('reports a merged PR', () => {
    const r = run([[1, 'MERGED', 'main', 'a', 'ci: one']], ['1']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('PR #1 is already merged');
  });
  it('names a replacement when GitHub closed a PR because its base was force-pushed', () => {
    const r = run([FIRST, [2, 'CLOSED', 'a', 'b', 'feat(x): two']], ['1', '2'], true);
    expect(r.status).toBe(1);
    expect(r.out).toContain('GitHub closed PR #2 when its base branch a was force-pushed');
    expect(r.out).toContain("gh pr create --base a --head b --title 'feat(x): two'");
  });
  it('reports a PR closed by hand as closed', () => {
    const r = run([FIRST, [2, 'CLOSED', 'a', 'b', 'feat(x): two']], ['1', '2'], false);
    expect(r.status).toBe(1);
    expect(r.out).toContain('PR #2 is closed');
    expect(r.out).not.toContain('force-pushed');
  });
});
