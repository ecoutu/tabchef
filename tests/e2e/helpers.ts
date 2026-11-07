import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config, GroupRule } from '../../src/core/types';
import { groupRuleToRule, userKey } from '../../src/core/config/migrate';
import { defaultConfig } from '../../src/core/config/defaults';
import { STARTUP_GRACE_MS, SESSION_MARKER } from '../../src/engine/dedupe-constants';

export const EXT_PATH = resolve(import.meta.dirname, '../../.output/chrome-mv3');

/** Tiny local page server: every path returns a small HTML page titled after the path. */
export async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${(req.url ?? '/').replace(/[<>&]/g, '')}</title><p>tabchef e2e</p>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

export interface Harness {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  /** An extension page (options.html) used to talk to the worker like the real UI does. */
  ui: Page;
  port: number;
  close: () => Promise<void>;
}

/**
 * Launches Playwright's bundled Chromium (branded Chrome >= 137 ignores --load-extension) with the built extension,
 * in new headless mode (`channel: 'chromium'`; the default headless shell cannot load extensions).
 */
export async function launch(): Promise<Harness> {
  const { server, port } = await startServer();
  const userDataDir = mkdtempSync(join(tmpdir(), 'tabchef-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extensionId = new URL(sw.url()).host;
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${extensionId}/options.html`);
  return {
    context, sw, extensionId, ui, port,
    close: async () => {
      await context.close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

type Res<T> = { ok: true; data: T } | { ok: false; error: string; errors?: string[] };

/** Sends a UI request from the extension page, exactly as the popup / options page do. */
export async function send<T = unknown>(h: Harness, req: Record<string, unknown>): Promise<T> {
  const r = await h.ui.evaluate((m) => chrome.runtime.sendMessage(m), req) as Res<T>;
  if (!r.ok) throw new Error(`${String(req.type)} failed: ${r.error} ${(r.errors ?? []).join('; ')}`);
  return r.data;
}

/** config.set with the current rev as baseRev (optimistic concurrency, like the options page). */
export async function setConfig(h: Harness, config: Config): Promise<void> {
  const { rev } = await send<{ rev: string }>(h, { type: 'config.get' });
  await send(h, { type: 'config.set', config, baseRev: rev });
}

export function rule(id: string, url: string, title: string, color: GroupRule['group']['color']): GroupRule {
  return { id, name: title, enabled: true, match: { url }, group: { title, color } };
}

/** A v2 config whose user rules are the given M1-shaped rules (in priority order). */
export function config(groupRules: GroupRule[], dedupe: Partial<Config['dedupe']> = {}): Config {
  const c = defaultConfig();
  return {
    ...c, rules: groupRules.map((r) => groupRuleToRule(r)), order: groupRules.map((r) => userKey(r.id)),
    dedupe: { ...c.dedupe, ...dedupe },
  };
}

/**
 * Waits until the dedupe startup grace (10 s after the worker first started in this browser session) is over.
 * The grace start is the worker's start time, stored as the storage.session marker. Pre-setting the marker would
 * not help: the running worker has already opened the grace in memory when it read the (missing) marker.
 */
export async function waitPastStartupGrace(h: Harness): Promise<void> {
  const marker = () => h.sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] as number | undefined, SESSION_MARKER);
  await expect.poll(marker, { timeout: 5000 }).toBeGreaterThan(0);
  const started = (await marker())!;
  await expect.poll(() => Date.now(), { timeout: STARTUP_GRACE_MS + 5000, intervals: [500] }).toBeGreaterThan(started + STARTUP_GRACE_MS + 250);
}

export interface TabInfo { id: number; url: string; index: number; groupId: number; windowId: number; pinned: boolean }
export interface GroupInfo { id: number; title: string; color: string; windowId: number }

export const tabs = (h: Harness) => h.sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({
  id: t.id!, url: t.url || t.pendingUrl || '', index: t.index, groupId: t.groupId, windowId: t.windowId, pinned: t.pinned,
}))) as Promise<TabInfo[]>;

export const groups = (h: Harness) => h.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => ({
  id: g.id, title: g.title ?? '', color: g.color, windowId: g.windowId,
}))) as Promise<GroupInfo[]>;

/** Group titles in tab-bar order (leftmost first) for the window of `windowId`. */
export async function groupOrder(h: Harness, windowId: number): Promise<string[]> {
  const [ts, gs] = await Promise.all([tabs(h), groups(h)]);
  const byId = new Map(gs.map((g) => [g.id, g.title]));
  const out: string[] = [];
  for (const t of ts.filter((x) => x.windowId === windowId && x.groupId !== -1).sort((a, b) => a.index - b.index)) {
    const title = byId.get(t.groupId) ?? '?';
    if (out[out.length - 1] !== title) out.push(title);
  }
  return out;
}

/** Opens a tab via chrome.tabs.create in the worker (a "new tab" as far as Tabchef is concerned). */
export const openTab = (h: Harness, url: string, windowId?: number) =>
  h.sw.evaluate(async ([u, w]) => (await chrome.tabs.create({ url: u, active: true, ...(w === undefined ? {} : { windowId: w }) })).id!, [url, windowId] as const);

/** Opens a BACKGROUND tab (`active: false`): never active, so close fire-time protection does not apply (R17). */
export const openBackgroundTab = (h: Harness, url: string) =>
  h.sw.evaluate(async (u) => (await chrome.tabs.create({ url: u, active: false })).id!, url);

/** Closes every web tab (keeps extension pages), deletes the stored projects and resets the config, so scenarios don't see each other's. */
export async function reset(h: Harness): Promise<void> {
  await setConfig(h, config([]));
  await send(h, { type: 'safety.resume' });
  const ids = (await tabs(h)).filter((t) => !t.url.startsWith('chrome-extension://')).map((t) => t.id);
  if (ids.length) await h.sw.evaluate((x) => chrome.tabs.remove(x), ids);
  await expect.poll(async () => (await tabs(h)).filter((t) => !t.url.startsWith('chrome-extension://')).length).toBe(0);
  // Through projects.delete, since the worker's ProjectStore caches: with no tab open, the saved and archived lists are every project.
  const { saved, archived } = await send<{ saved: { id: string }[]; archived: { id: string }[] }>(h, { type: 'projects.savedLists' });
  for (const p of [...saved, ...archived]) await send(h, { type: 'projects.delete', projectId: p.id });
}

/** Waits until a tab has finished loading `url` (its committed URL, so a later duplicate sees an existing tab). */
export async function waitLoaded(h: Harness, tabId: number, url: string): Promise<void> {
  await expect.poll(() => h.sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    return `${t.status} ${t.url}`;
  }, tabId), { timeout: 5000 }).toBe(`complete ${url}`);
}
