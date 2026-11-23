// Runs npm run e2e:open (scripts/e2e-open.ts) for the specs that test it (e2e-open.spec.ts, e2e-open-demo.spec.ts):
// starts it headless on a free port with its state file in a temp dir, waits for that file, and tears it down after
// each test (a spec registers stopRun() as its afterEach), however the test ended.
import { expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { State } from '../../scripts/e2e-open';
import { EXT_PATH } from './helpers';

const ROOT = resolve(import.meta.dirname, '../..');
/** The script's 10 s bound on closing the browser (CLOSE_TIMEOUT_MS), plus 5 s for the rest of its cleanup. */
export const EXIT_WAIT_MS = 15_000;
/** How long the script may take to write its state file: launch, CDP port, service worker, options page. */
export const READY_WAIT_MS = 45_000;
/** Bounds each request to the CDP port, so a port that accepts but never answers fails the test, not hangs it. */
const FETCH_TIMEOUT_MS = 5_000;
export const cdp = (endpoint: string) => fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export interface Exit { code: number | null; signal: NodeJS.Signals | null; error?: Error }

export interface Run {
  child: ChildProcess;
  stateFile: string;
  /** Settles once the script exits, or with `error` when it could not be started. */
  exited: Promise<Exit>;
  output: () => string;
  /** The profile the state file named, so the teardown finds it after the script deleted the state file. */
  userDataDir?: string;
}

/** Rejects with `what` when `p` takes longer than `ms`. */
export async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(what)), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// Run as the spec's afterEach: after a failure and after the test timeout too (Playwright abandons the test body then,
// so a `finally` in it never runs and the worker exits without killing the script, which systemd adopts with its
// browser).
let teardown: (() => Promise<void>) | undefined;
/** Stops the running script (if any) and removes what it left behind. */
export async function stopRun(): Promise<void> {
  await teardown?.();
  teardown = undefined;
}

/** Starts e2e:open headless on a free port, writing its state into a temp dir, and registers its teardown. */
export function start(command: string, args: string[], options: { detached?: boolean; env?: NodeJS.ProcessEnv } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'tabchef-e2e-open-spec-'));
  const stateFile = join(dir, 'state.json');
  const child = spawn(command, [...args, '--headless', '--port', '0', '--ext', EXT_PATH, '--state', stateFile], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
  let output = '';
  child.stdout!.on('data', (d) => { output += String(d); });
  child.stderr!.on('data', (d) => { output += String(d); });
  const exited = new Promise<Exit>((r) => {
    child.on('exit', (code, signal) => r({ code, signal }));
    child.on('error', (error) => r({ code: null, signal: null, error }));
  });
  // A detached child leads its own process group (npm, its shell, the script): signal all of it. Chromium is not in it
  // (Playwright starts it in a group of its own): the script closes it, or it exits once the script's pipe closes.
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      if (options.detached) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  teardown = async () => {
    // SIGTERM lets the script close the browser and remove its profile; SIGKILL only if it does not exit in time.
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      kill('SIGTERM');
      const force = setTimeout(() => kill('SIGKILL'), EXIT_WAIT_MS);
      await exited;
      clearTimeout(force);
    }
    // After a SIGKILL (or a script that failed to clean up) the profile is left: the state file names it.
    let userDataDir = run.userDataDir;
    try {
      userDataDir = (JSON.parse(readFileSync(stateFile, 'utf8')) as State).userDataDir;
    } catch {
      // No state file: the script removed it, or never got that far.
    }
    if (userDataDir && exists(userDataDir)) {
      // Chromium exits on its own once the pipe to the killed script closes, but writes to the profile on the way out:
      // wait for its SingletonLock to go first.
      await expect.poll(() => exists(join(userDataDir, 'SingletonLock')), { timeout: EXIT_WAIT_MS }).toBe(false).catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  };
  const run: Run = { child, stateFile, exited, output: () => output };
  return run;
}

/** The state file, once the script has written it within `ms` (it exits early on a failure). */
export async function ready(run: Run, ms = READY_WAIT_MS): Promise<State> {
  await expect.poll(() => existsSync(run.stateFile) || run.child.exitCode !== null || run.child.pid === undefined, { timeout: ms }).toBe(true);
  expect(existsSync(run.stateFile), `e2e:open exited early:\n${run.output()}`).toBe(true);
  const state = JSON.parse(readFileSync(run.stateFile, 'utf8')) as State;
  run.userDataDir = state.userDataDir;
  return state;
}

/** Waits for the script to exit, then checks it left nothing behind: state file, profile, CDP port, mock services. */
export async function expectCleanExit(run: Run, state: State): Promise<Exit> {
  const exit = await within(run.exited, EXIT_WAIT_MS, `e2e:open did not exit within ${EXIT_WAIT_MS / 1000} s:\n${run.output()}`);
  expect(existsSync(run.stateFile), run.output()).toBe(false);
  expect(existsSync(state.userDataDir), run.output()).toBe(false);
  await expect(cdp(state.cdpEndpoint)).rejects.toThrow();
  if (state.mockOrigin) await expect(fetch(state.mockOrigin, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).rejects.toThrow();
  return exit;
}
