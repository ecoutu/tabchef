// npm run e2e:open: the e2e build of the extension in Playwright's Chromium with a remote-debugging (CDP) port, open
// until Ctrl-C / SIGTERM. Agents attach over CDP (Playwright MCP, Chrome DevTools MCP) to drive and inspect the
// extension while a person clicks around in the same headed window. Builds the e2e flavor (WXT_E2E_LOCALHOST=1) into a
// folder of its own under .output-e2e-open/ (never .output, which `npm run zip` packs), so another instance's build never
// rewrites the files a running browser has loaded. Prints where everything is and writes it to a JSON state file,
// removed on shutdown with the temp profile and the build. --demo adds the store images' demo (store/demo.ts): the e2e:m3 mock
// GitHub and Jira services behind the connections, the demo group rules and tabs, their pages answered in-process.
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { config, rule, setConfig } from '../tests/e2e/helpers';
import type { MockServices } from '../tests/e2e/mock-services';
import { connect, open, recipes, routeDemoPages, settle, startDemoServices } from '../store/capture';
import * as demo from '../store/demo';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, '.output-e2e-open');
const CDP_WAIT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;
/** A repeat signal this soon after the first is the same Ctrl-C delivered twice (terminal and npm), not a force-quit. */
const REPEAT_SIGNAL_MS = 1_000;

const USAGE = `usage: npm run e2e:open -- [options]

Opens the e2e build of Tabchef in Playwright's Chromium with a CDP port, until Ctrl-C.

  --headless       no window (for agents)
  --port <n>       remote-debugging port (default 9222; 0 picks a free one)
  --demo           mock GitHub and Jira services, demo rules, connections and tabs; the browser
                   resolves only localhost, so no other host is ever reached
  --ext <dir>      load this unpacked extension instead of building one: .output/chrome-mv3 from
                   \`npm run e2e\`, or a \`WXT_E2E_LOCALHOST=1 npx wxt build\` (which --demo needs)
  --state <file>   where to write the state JSON (default .output-e2e-open/state.json)
  --help           this text

Exits 0 once closed (Ctrl-C included), 130 when interrupted before it was ready, 2 on bad options, 1 on any other failure.

Attach:
  npx @playwright/mcp --cdp-endpoint http://127.0.0.1:<port>
  npx chrome-devtools-mcp --browserUrl http://127.0.0.1:<port>`;

interface Options { headless: boolean; port: number; demo: boolean; ext?: string; state: string; help: boolean }

export interface State {
  cdpEndpoint: string;
  extensionId: string;
  /** The unpacked extension: --ext, or this run's own build under .output-e2e-open/, removed on shutdown. */
  extensionPath: string;
  /** The temp profile, removed on shutdown. */
  userDataDir: string;
  urls: { options: string; popup: string; sidePanel: string };
  mockOrigin?: string;
  pid: number;
  headless: boolean;
}

function parse(args: string[]): Options {
  // npm runs the script from the package root: paths are relative to where `npm run` was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const o: Options = { headless: false, port: 9222, demo: false, state: join(OUT_DIR, 'state.json'), help: false };
  const value = (i: number) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${args[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--headless') o.headless = true;
    else if (a === '--demo') o.demo = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--port') {
      const v = value(i++);
      o.port = Number(v);
      if (!/^\d+$/.test(v) || o.port > 65535) throw new Error(`--port: not a port: ${v}`);
    } else if (a === '--ext') o.ext = resolve(cwd, value(i++));
    else if (a === '--state') o.state = resolve(cwd, value(i++));
    else throw new Error(`unknown option: ${a}`);
  }
  return o;
}

/**
 * Starts the e2e flavor's build into `outDir`. `done` resolves with the extension's folder, or rejects with the signal
 * that ended the build, or after the build printed its errors.
 */
function buildE2e(outDir: string): { child: ChildProcess; done: Promise<string> } {
  console.log(`e2e:open: building the e2e extension into ${relative(ROOT, outDir)}/ (not .output)`);
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'import { build } from "wxt"; await build({ outDir: process.argv[1] });', outDir], {
    cwd: ROOT, env: { ...process.env, WXT_E2E_LOCALHOST: '1' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const done = new Promise<string>((ok, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (code === 0) ok(join(outDir, 'chrome-mv3'));
      else fail(Object.assign(new Error(`build exited with ${signal ?? code}`), { signal }));
    });
  });
  return { child, done };
}

/** Fails when something already listens on 127.0.0.1:`port` (Chromium would start without its CDP port). */
async function assertPortFree(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      fail(new Error(e.code === 'EADDRINUSE' ? `port ${port} is taken: pass --port <n> (or --port 0 for any free port)` : e.message)));
    server.listen(port, '127.0.0.1', ok);
  });
  await new Promise<void>((r) => server.close(() => r()));
}

/**
 * The CDP endpoint once this run's browser answers on it: its target list has `targetId`, one of this browser's pages.
 * With port 0 Chromium picks a port and writes it to DevToolsActivePort in the profile (with a fixed port it writes no
 * file). A fixed port someone took after assertPortFree leaves Chromium on [::1] only, or with no port at all, while
 * 127.0.0.1:<port> answers for the other process, maybe another e2e:open's browser: that fails as taken.
 */
async function cdpEndpoint(port: number, userDataDir: string, targetId: string): Promise<string> {
  const end = Date.now() + CDP_WAIT_MS;
  for (;;) {
    let p = port;
    if (p === 0) {
      try {
        p = Number(readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      } catch {
        p = 0;
      }
    }
    if (p) {
      const endpoint = `http://127.0.0.1:${p}`;
      try {
        const r = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1000) });
        if (r.ok && ((await r.json()) as { id?: string }[]).some((t) => t.id === targetId)) return endpoint;
      } catch {
        // Not listening yet (or not answering).
      }
    }
    if (Date.now() > end) {
      throw new Error(port === 0
        ? `the CDP port did not answer within ${CDP_WAIT_MS / 1000} s`
        : `port ${port} is taken (it did not answer for this browser within ${CDP_WAIT_MS / 1000} s): pass --port <n>, or --port 0 for any free port`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The demo: connections on the mock, the group rules and the two service recipes on, the demo tabs open. */
async function loadDemo(context: BrowserContext, sw: Worker, ui: Page, extensionId: string, mock: MockServices): Promise<void> {
  const h = { context, sw, ui, mock };
  await connect(h);
  await setConfig(h, recipes(config(demo.GROUP_RULES.map((g) => rule(g.id, g.url, g.title, g.color))), {
    'merged-prs': { enabled: true },
    'jira-ticket-either': { enabled: true, params: { jiraSite: demo.JIRA_SITE, titleFormat: '{key} · {summary}' } },
  }));
  const pages = [...new Map([...demo.PROJECT_TABS, ...demo.PREVIEW_TABS, ...demo.GROUP_EXTRA_TABS].map((p) => [p.url, p])).values()];
  for (const p of pages) await open(h, p);
  await settle(h, pages.length);
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Resolves on SIGINT / SIGTERM / SIGHUP or when the browser goes away (its window closed), and takes over the signals
 * from `early`. Another signal more than REPEAT_SIGNAL_MS later exits at once (the 'exit' cleanup still runs); one
 * sooner is the same Ctrl-C again.
 */
function shutdownSignal(context: BrowserContext, early: (s: NodeJS.Signals) => void): Promise<string> {
  return new Promise((done) => {
    let since: number | undefined;
    for (const s of SIGNALS) {
      process.off(s, early);
      process.on(s, () => {
        if (since === undefined) {
          since = Date.now();
          done(s);
        } else if (Date.now() - since > REPEAT_SIGNAL_MS) process.exit(130);
      });
    }
    // Also fires when the cleanup closes it: only a signal while closing forces the exit.
    context.on('close', () => {
      since ??= Date.now();
      done('the browser closed');
    });
  });
}

/** Waits for `p`, at most `ms`; the timer goes either way. */
async function bounded(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([p, new Promise((r) => { timer = setTimeout(r, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The extension's manifest host_permissions (the e2e build grants http://localhost/*, which --demo needs). */
function hostPermissions(extPath: string): string[] {
  try {
    return (JSON.parse(readFileSync(join(extPath, 'manifest.json'), 'utf8')) as { host_permissions?: string[] }).host_permissions ?? [];
  } catch {
    return [];
  }
}

export default async function main(args: string[]): Promise<number> {
  let o: Options;
  try {
    o = parse(args);
  } catch (e) {
    console.error(`e2e:open: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    console.log(USAGE);
    return 0;
  }

  // Until the browser is up, a signal exits at once (after the build it interrupts, if any); Playwright's own 'exit'
  // listener kills a half-launched Chromium, and the 'exit' cleanup below removes what this run made.
  let interrupted: NodeJS.Signals | undefined;
  let building: ChildProcess | undefined;
  const interrupt = (s: NodeJS.Signals) => {
    if (interrupted) return false;
    interrupted = s;
    console.error(`e2e:open: interrupted (${s})`);
    return true;
  };
  const early = (s: NodeJS.Signals) => {
    if (!interrupt(s)) return;
    if (building && building.exitCode === null && building.signalCode === null) {
      building.once('exit', () => process.exit(130));
      building.kill(s);
      setTimeout(() => {
        building?.kill('SIGKILL');
        process.exit(130);
      }, CLOSE_TIMEOUT_MS).unref();
    } else process.exit(130);
  };
  for (const s of SIGNALS) process.on(s, early);

  // Synchronous and idempotent, so the 'exit' handler can repeat them when a signal exits mid-setup or mid-cleanup.
  // The state file goes only while it is ours: a second instance writing the same file must keep it.
  let buildDir: string | undefined;
  let userDataDir: string | undefined;
  const removeState = () => {
    try {
      if ((JSON.parse(readFileSync(o.state, 'utf8')) as State).pid === process.pid) rmSync(o.state, { force: true });
    } catch {
      // Not written (yet), or not readable.
    }
  };
  const removeDirs = () => {
    for (const dir of [userDataDir, buildDir]) {
      try {
        if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch (e) {
        console.error(`e2e:open: could not remove ${dir}: ${(e as Error).message}`);
      }
    }
  };
  process.on('exit', () => {
    removeState();
    removeDirs();
  });

  let context: BrowserContext | undefined;
  let mock: MockServices | undefined;
  let setup: Promise<unknown> | undefined;
  try {
    let extPath = o.ext;
    if (!extPath) {
      // A folder per run: a build never rewrites the files another instance's browser has loaded.
      mkdirSync(OUT_DIR, { recursive: true });
      buildDir = mkdtempSync(join(OUT_DIR, 'build-'));
      const build = buildE2e(buildDir);
      building = build.child;
      try {
        extPath = await build.done;
      } catch (e) {
        // Only a signal our handler passed on interrupts; a build killed by anything else failed.
        if (interrupted) return 130;
        const signal = (e as { signal?: NodeJS.Signals | null }).signal;
        console.error(`e2e:open: build failed: ${signal ? `killed by ${signal}` : (e as Error).message}`);
        return 1;
      }
    }
    if (!existsSync(join(extPath, 'manifest.json'))) {
      console.error(`e2e:open: no extension in ${relative(ROOT, extPath) || extPath}: build it first`);
      return 1;
    }
    if (o.demo && !hostPermissions(extPath).includes('http://localhost/*')) {
      console.error('e2e:open: --demo needs the e2e build: drop --ext or build with WXT_E2E_LOCALHOST=1');
      return 1;
    }
    // The fast check; cdpEndpoint() catches a port taken between here and Chromium's start.
    if (o.port !== 0) await assertPortFree(o.port);

    userDataDir = mkdtempSync(join(tmpdir(), 'tabchef-e2e-open-'));
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: o.headless,
        timeout: LAUNCH_TIMEOUT_MS,
        // Headed: the page follows the window size, like a normal browser.
        ...(o.headless ? {} : { viewport: null }),
        // Our own signal handling closes the browser after the state file and the mock services.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, `--remote-debugging-port=${o.port}`,
          // The demo's pages are answered by routes: never let a navigation reach the real GitHub or Jira.
          ...(o.demo ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] : [])],
      });
    } catch (e) {
      throw new Error(`Chromium did not start: ${(e as Error).message}`);
    }
    const ctx = context;
    const profile = userDataDir;
    const closed = shutdownSignal(ctx, early);
    // Raced against the shutdown: a Ctrl-C during the setup closes the browser at once, and never writes the state.
    const ready = (async (): Promise<State> => {
      // The first tab shows the options page (it is also the page demo setup talks to the worker from).
      const ui = ctx.pages()[0] ?? (await ctx.newPage());
      const session = await ctx.newCDPSession(ui);
      const { targetInfo } = await session.send('Target.getTargetInfo');
      await session.detach();
      const endpoint = await cdpEndpoint(o.port, profile, targetInfo.targetId);
      const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15_000 }));
      const extensionId = new URL(sw.url()).host;
      const base = `chrome-extension://${extensionId}`;
      const urls = { options: `${base}/options.html`, popup: `${base}/popup.html`, sidePanel: `${base}/panel.html` };
      await ui.goto(urls.options);
      if (o.demo) {
        console.log('e2e:open: loading the demo (mock services, connections, rules and tabs)');
        mock = await startDemoServices();
        await routeDemoPages(ctx, mock);
        await loadDemo(ctx, sw, ui, extensionId, mock);
        await ui.bringToFront();
      }
      return {
        cdpEndpoint: endpoint, extensionId, extensionPath: extPath, userDataDir: profile, urls,
        ...(mock ? { mockOrigin: mock.origin } : {}), pid: process.pid, headless: o.headless,
      };
    })();
    setup = ready.catch(() => {});
    const first = await Promise.race([ready.then((state) => ({ state })), closed.then((reason) => ({ reason }))]);
    if ('reason' in first) {
      console.log(`e2e:open: closing (${first.reason}) before the setup finished`);
      return first.reason === 'the browser closed' ? 1 : 130;
    }
    const { state } = first;
    // Written whole (temp file + rename): a reader polling for it never sees half a file.
    mkdirSync(dirname(o.state), { recursive: true });
    // Per process: two instances writing the same state file never share a temp file.
    const tmp = `${o.state}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, o.state);
    console.log([
      `e2e:open: Tabchef ${state.extensionId} in Chromium (${o.headless ? 'headless' : 'headed'}${o.demo ? ', demo' : ''})`,
      `  CDP         ${state.cdpEndpoint}`,
      `  options     ${state.urls.options}`,
      `  popup       ${state.urls.popup}`,
      `  side panel  ${state.urls.sidePanel}`,
      ...(mock ? [`  mock        ${mock.origin}`] : []),
      `  extension   ${relative(ROOT, extPath) || extPath}`,
      `  state       ${relative(ROOT, o.state) || o.state}`,
      'Attach:',
      `  npx @playwright/mcp --cdp-endpoint ${state.cdpEndpoint}`,
      `  npx chrome-devtools-mcp --browserUrl ${state.cdpEndpoint}`,
      'Ctrl-C to close.',
    ].join('\n'));
    console.log(`e2e:open: closing (${await closed})`);
    return 0;
  } catch (e) {
    console.error(`e2e:open: ${(e as Error).message}`);
    return 1;
  } finally {
    removeState();
    // Bounded: a browser that does not close in time goes away with this process (its pipe closes).
    await bounded(context?.close().catch(() => {}), CLOSE_TIMEOUT_MS);
    // An interrupted setup fails fast once the browser is gone; it may have started the mock services meanwhile.
    await bounded(setup, CLOSE_TIMEOUT_MS);
    await mock?.close();
    removeDirs();
  }
}
