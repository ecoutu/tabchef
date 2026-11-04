import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/submit-stores.sh';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A fake `npx` (wxt submit): every call is logged to $FAKE_LOG.
const FAKE_NPX = `#!/usr/bin/env bash
echo "npx $*" >> "$FAKE_LOG"
`;

function run(o: { args?: string[]; token?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'submit-stores-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'npx'), FAKE_NPX, { mode: 0o755 });
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
      CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN: o.token ?? 'tok', CHROME_EXTENSION_ID: 'ext', CHROME_PUBLISHER_ID: 'pub',
    },
  });
  return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('submit-stores.sh', () => {
  it('submits with API v2, cancelling a review still pending (it locks the draft the upload replaces)', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['npx wxt submit --chrome-api-version v2 --chrome-cancel-pending --chrome-zip .output/tabchef-1.0.0-chrome.zip']);
  });

  it('passes --dry-run through (wxt checks the credentials and cancels nothing)', () => {
    const r = run({ args: ['--dry-run'] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['npx wxt submit --dry-run --chrome-api-version v2 --chrome-cancel-pending --chrome-zip .output/tabchef-1.0.0-chrome.zip']);
  });

  it('skips without any call when publishing is not configured', () => {
    const r = run({ token: '' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });
});
