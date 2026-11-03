// Captures the real extension UI for the store images (npm run store:assets): the popup, the options page and the
// side panel of an e2e build (WXT_E2E_LOCALHOST=1, built into a temp dir, never .output), with demo tabs and the
// e2e:m3 mock GitHub and Jira services behind the connections. Nothing here is a real account: the tokens are the
// mock's dummies and every page the tabs open is answered in-process (Playwright routes), never fetched.
import { chromium, type BrowserContext, type Page, type Route, type Worker } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinConnectionDefs } from '../src/core/connections/builtin';
import type { ConnectionDef } from '../src/core/connections/types';
import type { RecipeRef } from '../src/core/lang/types';
import type { Config } from '../src/core/types';
import { CONNECTIONS_KEY, secretKey } from '../src/engine/connections/secret-store';
import { config, rule, send, setConfig, type Harness } from '../tests/e2e/helpers';
import { MOCK_JIRA_EMAIL, MOCK_JIRA_TOKEN, MOCK_TOKEN, startMockServices, type MockServices } from '../tests/e2e/mock-services';
import { DEMO_ISSUES, DEMO_PRS, JIRA_SITE, pageTitle, type DemoPage } from './demo';

/** One capture: a PNG of part of a real extension page, at 2x. */
export type Shot = Buffer;
export interface TabStripGroup { title: string; color: string; tabs: string[] }
export interface Captures {
  duplicates: Shot; rules: Shot; strip: TabStripGroup[]; projects: Shot; merged: Shot; preview: Shot; popupProjects: Shot;
}

const SCALE = 2;
const POPUP = { width: 520, height: 640 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value; throws `what` after `ms`. */
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`store:assets: timed out waiting for ${what}`);
    await sleep(200);
  }
}

// A neutral favicon per site (not the services' logos): a dark disc for github.com, a blue tile for Jira.
const FAVICONS: Record<string, string> = {
  'github.com': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" fill="#24292f"/><circle cx="8" cy="8" r="3" fill="#fff"/></svg>',
  [JIRA_SITE]: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#1868db"/><path d="M5 4h6v6a3 3 0 0 1-6 0" fill="none" stroke="#fff" stroke-width="1.8"/></svg>',
  'developer.mozilla.org': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#1b1b1b"/><path d="M4 12V4l4 5 4-5v8" fill="none" stroke="#fff" stroke-width="1.6"/></svg>',
};

/** Answers every page a demo tab opens: PR pages and Jira tickets from the mock services, the rest from demo.ts. */
async function answer(route: Route, mock: MockServices): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === '/favicon.ico') { await route.fulfill({ status: 404, body: '' }); return; }
  const svg = FAVICONS[url.host];
  const icon = svg ? `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}">` : '';
  // The mock titles PR pages and /browse/<key> like the real sites; the API calls go to the mock directly.
  if (/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) || url.pathname.startsWith('/browse/')) {
    const r = await fetch(`${mock.origin}${url.pathname}`);
    await route.fulfill({ status: r.status, contentType: 'text/html; charset=utf-8', body: (await r.text()).replace('<title>', `${icon}<title>`) });
    return;
  }
  const title = pageTitle(url);
  await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>${icon}<title>${title.replace(/[<>&]/g, '')}</title><p>demo</p>` });
}

interface Session extends Harness { mock: MockServices; page: (path: string, viewport?: { width: number; height: number }) => Promise<Page> }

async function session(extPath: string): Promise<Session> {
  const mock = await startMockServices();
  for (const [key, pr] of Object.entries(DEMO_PRS)) mock.github.setPr(key, pr);
  for (const [key, issue] of Object.entries(DEMO_ISSUES)) mock.jira.setIssue(key, issue);
  const userDataDir = mkdtempSync(join(tmpdir(), 'tabchef-store-'));
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    colorScheme: 'light',
    // 2x captures: the composed images downscale them, so text stays crisp at 1280×800.
    deviceScaleFactor: SCALE,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    // No network: every demo page is answered by a route, and anything else fails to resolve (never a real site).
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--hide-scrollbars',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
  });
  for (const p of context.pages()) await p.close();
  await context.route(/^https:\/\/(github\.com|[a-z0-9-]+\.atlassian\.net|developer\.mozilla\.org)\//, (r) => answer(r, mock));
  await context.route(/^http:\/\/localhost:3000\//, (r) => answer(r, mock));
  const sw: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(sw.url()).host;
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extensionId}/options.html`);
  const page = async (path: string, viewport = POPUP) => {
    const p = await context.newPage();
    await p.setViewportSize(viewport);
    await p.goto(`chrome-extension://${extensionId}/${path}`);
    return p;
  };
  return {
    context, sw, extensionId, ui, port: mock.port, mock, page,
    close: async () => {
      await context.close();
      await mock.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Opens a demo tab in the background: chrome.tabs.create (the extension sees a new tab in the same window), then the
 * page loads through Playwright, so its routes answer it (they do not see a navigation the extension starts itself).
 */
async function open(h: Session, p: DemoPage): Promise<void> {
  const [page] = await Promise.all([
    h.context.waitForEvent('page'),
    h.sw.evaluate(async () => { await chrome.tabs.create({ url: 'about:blank', active: false }); }),
  ]);
  await page.goto(p.url);
}

const webTabs = (h: Session) => h.sw.evaluate(async () => (await chrome.tabs.query({}))
  .filter((t) => !/^(chrome-extension:|about:)/.test(t.url ?? t.pendingUrl ?? ''))
  .map((t) => ({ id: t.id!, windowId: t.windowId, url: t.url ?? '', title: t.title ?? '', status: t.status, groupId: t.groupId, index: t.index, favIconUrl: t.favIconUrl })));

/** Waits until every web tab has loaded, has its title and (where the site has one) its favicon. */
async function settle(h: Session, count: number): Promise<void> {
  await until(`${count} demo tabs to load`, async () => {
    const ts = await webTabs(h);
    return ts.length === count && ts.every((t) => t.status === 'complete' && t.title !== '' && !t.title.startsWith('http'));
  });
  await sleep(600);
}

/** The github and jira connections on the mock, stored the way the e2e:m3 tests store them (setToken validates against the real hosts). */
async function connect(h: Session): Promise<void> {
  const github: ConnectionDef = {
    ...builtinConnectionDefs().github, auth: 'token', apiBaseUrl: h.mock.origin, hosts: ['http://localhost/*'],
  };
  const jira: ConnectionDef = {
    ...builtinConnectionDefs().jira, baseUrl: h.mock.origin, apiBaseUrl: h.mock.origin, hosts: ['http://localhost/*'],
    jira: { site: JIRA_SITE, email: MOCK_JIRA_EMAIL, tokenKind: 'classic' },
  };
  await h.sw.evaluate(async (items) => { await chrome.storage.local.set(items); }, {
    [CONNECTIONS_KEY]: [github, jira], [secretKey('github')]: { token: MOCK_TOKEN }, [secretKey('jira')]: { token: MOCK_JIRA_TOKEN },
  });
  const login = await send<{ login?: string }>(h, { type: 'connections.test', id: 'github' });
  if (login.login !== 'e2e-user') throw new Error('store:assets: the github connection did not reach the mock');
}

const recipes = (c: Config, over: Record<string, Partial<RecipeRef>>): Config => ({
  ...c, recipes: c.recipes.map((r) => (over[r.id] ? { ...r, ...over[r.id] } : r)),
});

/**
 * Ends a scene: closes every tab but the worker's own options page (closing a tab drops it from its group, and an
 * empty group goes away), puts back the default config and removes both connections, so the next scene sees none of
 * this one's tabs, groups, rules or connections.
 */
async function scene(h: Session): Promise<void> {
  for (const p of h.context.pages()) if (p !== h.ui) await p.close();
  await setConfig(h, config([]));
  for (const id of ['github', 'jira']) await send(h, { type: 'connections.disconnect', id });
  await until('the scene to end', async () => (await webTabs(h)).length === 0
    && (await h.sw.evaluate(() => chrome.tabGroups.query({}))).length === 0);
}

/** A popup capture: popup.html with `view` open, as tall as its content. */
async function popup(h: Session, view: string, ready: (p: Page) => Promise<unknown>): Promise<Shot> {
  await h.sw.evaluate(async (v) => { await chrome.storage.local.set({ 'popup.lastTab': v }); }, view);
  const p = await h.page('popup.html');
  await ready(p);
  await sleep(400);
  const shot = await p.locator('main').screenshot({ animations: 'disabled' });
  await p.close();
  return shot;
}

export async function capture(extPath: string, demo: typeof import('./demo'), keep?: string): Promise<Captures> {
  const out = new Proxy({} as Partial<Captures>, {
    set(t, k: string, v: Shot | TabStripGroup[]) {
      if (keep) {
        mkdirSync(keep, { recursive: true });
        writeFileSync(join(keep, Buffer.isBuffer(v) ? `${k}.png` : `${k}.json`), Buffer.isBuffer(v) ? v : JSON.stringify(v, null, 2));
      }
      return Reflect.set(t, k, v);
    },
  });
  // One browser for all scenes; each scene starts from a clean slate (scene()). The duplicates scene goes first:
  // it needs the startup grace of a freshly started worker.
  const h = await session(extPath);
  const run = async (fn: (h: Session) => Promise<void>) => {
    await fn(h);
    await scene(h);
  };
  try {
    // 1. Duplicates: tabs opened during the startup grace stay open as duplicates; the popup lists each set once.
    await run(async (h) => {
      for (const p of demo.DUPLICATE_TABS) await open(h, p);
      await settle(h, demo.DUPLICATE_TABS.length);
      out.duplicates = await popup(h, 'duplicates', (p) => p.getByRole('button', { name: 'Close all duplicates' }).waitFor());
    });

    // 2. Groups by repo: the user's own group rules, then the tab strip they produced, read from chrome.tabGroups.
    await run(async (h) => {
      await setConfig(h, config(demo.GROUP_RULES.map((g) => rule(g.id, g.url, g.title, g.color))));
      for (const p of demo.GROUP_TABS) await open(h, p);
      await settle(h, demo.GROUP_TABS.length);
      await until('the tab groups', async () => (await h.sw.evaluate(() => chrome.tabGroups.query({}))).length === demo.GROUP_RULES.length);
      await sleep(800);
      out.strip = await h.sw.evaluate(async () => {
        const tabs = (await chrome.tabs.query({})).filter((t) => !(t.url ?? '').startsWith('chrome-extension://')).sort((a, b) => a.index - b.index);
        const gs = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
        const strip: { title: string; color: string; tabs: string[] }[] = [];
        for (const t of tabs) {
          const g = gs.get(t.groupId);
          const title = g?.title ?? '';
          const last = strip[strip.length - 1];
          if (last && last.title === title && g) last.tabs.push(t.title ?? '');
          else strip.push({ title, color: g?.color ?? '', tabs: [t.title ?? ''] });
        }
        return strip;
      });
      const p = await h.page('options.html#/rules', { width: 760, height: 900 });
      const yaml = p.getByRole('button', { name: 'YAML', exact: true });
      await until('the rule cards', async () => (await yaml.count()) === demo.GROUP_RULES.length);
      for (let i = demo.GROUP_RULES.length - 1; i >= 0; i--) await yaml.nth(i).click();
      await sleep(800);
      // The first two rules, each shown as YAML; the third is more of the same.
      const box = await p.locator('div.rule').nth(0).evaluate((e, next) => {
        const a = e.getBoundingClientRect();
        const b = (document.querySelectorAll('div.rule')[next] ?? e).getBoundingClientRect();
        return { x: a.left - 8, y: a.top + window.scrollY - 8, width: a.width + 16, height: b.bottom - a.top + 16 };
      }, 1);
      out.rules = await p.screenshot({ fullPage: true, clip: box });
      await p.close();
    });

    // 3 and 4. Merged PRs and the Jira ticket projects, on the mock GitHub and Jira connections.
    await run(async (h) => {
      await connect(h);
      await setConfig(h, recipes(config([]), {
        'merged-prs': { enabled: true },
        'jira-ticket-either': { enabled: true, params: { jiraSite: JIRA_SITE, titleFormat: '{key} · {summary}' } },
      }));
      for (const p of demo.PROJECT_TABS) await open(h, p);
      await settle(h, demo.PROJECT_TABS.length);
      await until('the merged pull requests', async () =>
        (await send<{ rows: unknown[] }>(h, { type: 'view.data', viewId: 'merged' })).rows.length === demo.MERGED_COUNT);
      await until('the projects', async () => {
        const cards = await send<{ status?: unknown; tabs: unknown[] }[]>(h, { type: 'projects.list' });
        return cards.length === demo.PROJECT_COUNT && cards.every((c) => c.status);
      });
      await sleep(800);
      out.merged = await popup(h, 'merged', (p) => p.getByRole('button', { name: /close all/i }).first().waitFor());
      out.popupProjects = await popup(h, 'projects', (p) => p.locator('article.card').first().waitFor());
      const panel = await h.page('panel.html', { width: 400, height: 760 });
      await panel.locator('article.card').nth(demo.PROJECT_COUNT - 1).waitFor();
      await sleep(600);
      const end = await panel.locator('article.card').last().evaluate((e) => e.getBoundingClientRect().bottom);
      out.projects = await panel.screenshot({ clip: { x: 0, y: 0, width: 400, height: Math.ceil(end) + 8 } });
      await panel.close();
    });

    // 5. Preview before apply: the group rules are there but off; turning them on and saving opens the preview.
    await run(async (h) => {
      const off = demo.GROUP_RULES.map((g) => ({ ...rule(g.id, g.url, g.title, g.color), enabled: false }));
      await setConfig(h, config(off));
      for (const p of demo.PREVIEW_TABS) await open(h, p);
      await settle(h, demo.PREVIEW_TABS.length);
      const p = await h.page('options.html#/rules', { width: 900, height: 760 });
      const boxes = p.getByRole('checkbox', { name: 'Enabled' });
      await until('the rule cards', async () => (await boxes.count()) === demo.GROUP_RULES.length);
      for (let i = 0; i < demo.GROUP_RULES.length; i++) await boxes.nth(i).check();
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await p.getByRole('dialog').waitFor();
      await sleep(600);
      // The crop is the dialog's box, whose edges fall between device pixels: make the backdrop opaque white (the
      // card the image sits on), so no sliver of the page behind it shows at the edges or rounded corners.
      await p.addStyleTag({ content: '.backdrop { background: #fff !important; }' });
      await sleep(100);
      out.preview = await p.locator('.dialog').screenshot();
      await p.close();
    });
  } finally {
    await h.close();
  }
  return out as Captures;
}
