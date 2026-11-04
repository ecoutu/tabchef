import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/submit-stores.sh';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Fakes, each call logged to $FAKE_LOG. `npx` (wxt submit) exits $FAKE_NPX_EXIT (default 0). `curl` (fetchStatus)
// prints the next line of $FAKE_STATUSES per call, or fails when that line is `fail`.
const FAKE_NPX = `#!/usr/bin/env bash
echo "npx $*" >> "$FAKE_LOG"
exit "\${FAKE_NPX_EXIT:-0}"
`;
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
n=$(grep -c '^curl ' "$FAKE_LOG")
line=$(sed -n "\${n}p" <<<"$FAKE_STATUSES")
[[ "$line" == fail ]] && exit 22
printf '%s' "$line"
`;

const rev = (state: string, version: string) => ({ state, distributionChannels: [{ crxVersion: version, deployPercentage: 100 }] });

function run(o: { args?: string[]; token?: string; statuses?: (object | 'fail')[]; summary?: boolean; npxExit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'submit-stores-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'npx'), FAKE_NPX, { mode: 0o755 });
  writeFileSync(join(dir, 'curl'), FAKE_CURL, { mode: 0o755 });
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, '');
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  // The script globs the zip from the working directory.
  const cwd = join(dir, 'repo');
  mkdirSync(join(cwd, '.output'), { recursive: true });
  writeFileSync(join(cwd, '.output', 'tabchef-1.0.0-chrome.zip'), '');
  const r = spawnSync('bash', [join(process.cwd(), SCRIPT), ...(o.args ?? [])], {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: log,
      FAKE_STATUSES: (o.statuses ?? [{}, {}]).map((x) => (x === 'fail' ? x : JSON.stringify(x))).join('\n'),
      GITHUB_STEP_SUMMARY: o.summary === false ? '' : summary,
      ...(o.npxExit !== undefined && { FAKE_NPX_EXIT: String(o.npxExit) }),
      CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN: o.token ?? 'tok', CHROME_EXTENSION_ID: 'ext', CHROME_PUBLISHER_ID: 'pub',
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { status: r.status, out: r.stdout + r.stderr, calls, summary: readFileSync(summary, 'utf8') };
}
const npx = (calls: string[]) => calls.filter((c) => c.startsWith('npx '));

describe('submit-stores.sh', () => {
  it('submits with API v2, cancelling a review still pending (it locks the draft the upload replaces)', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(npx(r.calls)).toEqual(['npx wxt submit --chrome-api-version v2 --chrome-cancel-pending --chrome-zip .output/tabchef-1.0.0-chrome.zip']);
  });

  it('passes --dry-run through (wxt checks the credentials and cancels nothing)', () => {
    const r = run({ args: ['--dry-run'] });
    expect(r.status).toBe(0);
    expect(npx(r.calls)).toEqual(['npx wxt submit --dry-run --chrome-api-version v2 --chrome-cancel-pending --chrome-zip .output/tabchef-1.0.0-chrome.zip']);
  });

  it('skips without any call when publishing is not configured', () => {
    const r = run({ token: '' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('writes the store state before and after the submission to the run summary', () => {
    const r = run({ statuses: [
      { publishedItemRevisionStatus: rev('PUBLISHED', '1.2.0'), submittedItemRevisionStatus: rev('PENDING_REVIEW', '1.2.1') },
      { publishedItemRevisionStatus: rev('PUBLISHED', '1.2.0'), submittedItemRevisionStatus: rev('PENDING_REVIEW', '1.2.2') },
    ] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.split(' ')[0])).toEqual(['curl', 'npx', 'curl']);
    expect(r.calls[0]).toContain('https://chromewebstore.googleapis.com/v2/publishers/pub/items/ext:fetchStatus');
    expect(r.calls[0]).toContain('Authorization: Bearer tok');
    expect(r.summary).toContain('| Before | PUBLISHED 1.2.0 | PENDING_REVIEW 1.2.1 |');
    expect(r.summary).toContain('| After | PUBLISHED 1.2.0 | PENDING_REVIEW 1.2.2 |');
  });

  it('shows a missing revision as a dash, a partial rollout with its percentage, and flags a takedown or warning', () => {
    const r = run({ statuses: [{}, {
      publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.2.1', deployPercentage: 10 }] },
      takenDown: true, warned: true,
    }] });
    expect(r.summary).toContain('| Before | — | — |');
    expect(r.summary).toContain('| After | PUBLISHED 1.2.1 (10%) | — |');
    // The notes follow the table: the rows stay one table.
    expect(r.summary).toMatch(/\| After \|[^\n]*\n\n\*\*The item is taken down\.\*\*\n\n\*\*The item has a policy warning\.\*\*/);
  });

  it('an unreadable status only warns: the submission still runs and succeeds', () => {
    const r = run({ statuses: ['fail', 'fail'] });
    expect(r.status).toBe(0);
    expect(npx(r.calls)).toHaveLength(1);
    expect(r.out).toContain('::warning::');
  });

  it('a failed submission still writes the summary and fails the step', () => {
    const r = run({ npxExit: 3, statuses: [{}, { submittedItemRevisionStatus: rev('REJECTED', '1.2.1') }] });
    expect(r.status).toBe(3);
    expect(r.summary).toContain('| After | — | REJECTED 1.2.1 |');
  });

  it('outside GitHub Actions (no GITHUB_STEP_SUMMARY) it reads no status', () => {
    const r = run({ summary: false });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('curl '))).toEqual([]);
  });
});
