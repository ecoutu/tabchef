import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  config, EXT_PATH, groupOrder, groups, launch, openTab, reset, rule, send, setConfig, tabs, waitLoaded, waitPastStartupGrace,
  type Harness,
} from './helpers';
import type { Config } from '../../src/core/types';

test('built manifest: options page opens in a tab, no required host permissions', () => {
  const m = JSON.parse(readFileSync(join(EXT_PATH, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expect((m.options_ui as { open_in_tab?: boolean }).open_in_tab).toBe(true);
  expect(m.host_permissions).toBeUndefined();
  expect(m.permissions).toEqual(['tabs', 'tabGroups', 'storage', 'contextMenus', 'alarms', 'webNavigation', 'sidePanel']);
});

test.describe('extension in Chromium', () => {
  test.describe.configure({ mode: 'serial' });
  let h: Harness;
  let base: { a: string; b: string };

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    h = await launch();
    base = { a: `http://localhost:${h.port}`, b: `http://127.0.0.1:${h.port}` };
    // One browser for every scenario: wait out the dedupe startup grace once instead of per test.
    await waitPastStartupGrace(h);
  });
  test.afterAll(async () => { await h?.close(); });
  test.beforeEach(async () => { await reset(h); });

  const urlCount = async (u: string) => (await tabs(h)).filter((t) => t.url === u).length;

  test('(a) group order follows config order, and follows a reorder', async () => {
    const A = rule('a', `localhost:${h.port}/ex/*`, 'ex', 'blue');
    const B = rule('b', `127.0.0.1:${h.port}/org/*`, 'org', 'red');
    await setConfig(h, config([A, B]));
    const orgTab = await openTab(h, `${base.b}/org/1`);
    await waitLoaded(h, orgTab, `${base.b}/org/1`);
    const exTab = await openTab(h, `${base.a}/ex/1`);
    const windowId = (await tabs(h)).find((t) => t.id === exTab)!.windowId;

    await expect.poll(() => groupOrder(h, windowId), { timeout: 5000 }).toEqual(['ex', 'org']);
    const gs = await groups(h);
    expect(gs.find((g) => g.title === 'ex')?.color).toBe('blue');
    expect(gs.find((g) => g.title === 'org')?.color).toBe('red');

    // Reorder: A after B -> "ex" must move right of "org".
    await setConfig(h, config([B, A]));
    await expect.poll(() => groupOrder(h, windowId), { timeout: 5000 }).toEqual(['org', 'ex']);
    // Still one group per title.
    expect((await groups(h)).map((g) => g.title).sort()).toEqual(['ex', 'org']);
  });

  test('(b) dedupe closes the NEW tab and keeps the original', async () => {
    const url = `${base.a}/dd/a`;
    const original = await openTab(h, url);
    await waitLoaded(h, original, url);
    const dupe = await openTab(h, `${url}#x`);
    expect(dupe).not.toBe(original);

    await expect.poll(async () => {
      const ts = (await tabs(h)).filter((t) => t.url.startsWith(url));
      return ts.map((t) => t.id);
    }, { timeout: 1500 }).toEqual([original]);
    // followFragment: the kept tab may pick up the new #fragment.
    const kept = (await tabs(h)).find((t) => t.id === original)!;
    expect([url, `${url}#x`]).toContain(kept.url);
  });

  test('(c) paused: duplicates are left open', async () => {
    await send(h, { type: 'safety.pause', d: '15m' });
    expect(await send<{ paused: boolean }>(h, { type: 'safety.status' })).toEqual({ paused: true, locked: [] });
    const url = `${base.a}/pause/a`;
    const first = await openTab(h, url);
    await waitLoaded(h, first, url);
    const second = await openTab(h, url);
    await waitLoaded(h, second, url);
    // Negative check: give dedupe the same 1.5 s budget scenario (b) gets to close a tab.
    await h.ui.waitForTimeout(1500);
    expect(await urlCount(url)).toBe(2);
    await send(h, { type: 'safety.resume' });
  });

  test('(d) a tab ungrouped by the user stays ungrouped after a reconcile', async () => {
    await setConfig(h, config([rule('u', `localhost:${h.port}/ug/*`, 'ug', 'green')]));
    const t1 = await openTab(h, `${base.a}/ug/1`);
    await waitLoaded(h, t1, `${base.a}/ug/1`);
    const groupOf = async (id: number) => (await tabs(h)).find((t) => t.id === id)?.groupId ?? -2;
    await expect.poll(() => groupOf(t1), { timeout: 5000 }).toBeGreaterThan(-1);

    await h.sw.evaluate((id) => chrome.tabs.ungroup(id), t1);
    await expect.poll(() => groupOf(t1)).toBe(-1);

    // Trigger a reconcile: a second matching tab gets grouped, which proves the reconciler ran.
    const t2 = await openTab(h, `${base.a}/ug/2`);
    await expect.poll(() => groupOf(t2), { timeout: 5000 }).toBeGreaterThan(-1);
    // And a config-triggered reconcile.
    await setConfig(h, config([rule('u', `localhost:${h.port}/ug/*`, 'ug', 'cyan')]));
    await expect.poll(async () => (await groups(h)).find((g) => g.title === 'ug')?.color, { timeout: 5000 }).toBe('cyan');
    expect(await groupOf(t1)).toBe(-1);
  });

  test('(e) ask mode without optional permissions: pending ask, both tabs stay', async () => {
    await setConfig(h, config([], { mode: 'ask' }));
    const url = `${base.a}/ask/a`;
    const first = await openTab(h, url);
    await waitLoaded(h, first, url);
    const second = await openTab(h, url);
    await expect.poll(async () => (await send<{ pending: unknown[] }>(h, { type: 'dupes.list' })).pending.length, { timeout: 5000 }).toBe(1);
    expect(await urlCount(url)).toBe(2);
    const { pending } = await send<{ pending: { newTabId: number; existingTabId: number }[] }>(h, { type: 'dupes.list' });
    expect(pending[0]).toMatchObject({ newTabId: second, existingTabId: first });
  });

  test('(f) import decoder works in the built bundle (LZMA under the extension CSP)', async () => {
    const data = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../fixtures/auto-group-tabs.json'), 'utf8')) as unknown;
    const preview = await send<{ rules: unknown[]; warnings: string[] }>(h, { type: 'import.preview', source: 'auto-group-tabs', data });
    expect(preview.rules).toHaveLength(13);
  });
  test('(g) groups restored without Tabchef state: new groups append, a user ungroup sticks', async () => {
    const groupOf = async (id: number) => (await tabs(h)).find((t) => t.id === id)?.groupId ?? -2;
    // Tabs and groups exist before the rule does, as after a browser restart (titles match the rule's template).
    // A window of their own: already in the right order, so no move/update op touches (and adopts) them.
    const windowId = await h.sw.evaluate(async (u) => (await chrome.windows.create({ url: u }))!.id!, `${base.a}/rs/zeta/1`);
    const z1 = (await tabs(h)).find((t) => t.windowId === windowId)!.id;
    await waitLoaded(h, z1, `${base.a}/rs/zeta/1`);
    const open = async (path: string) => {
      const id = await openTab(h, `${base.a}${path}`, windowId);
      await waitLoaded(h, id, `${base.a}${path}`);
      return id;
    };
    const z2 = await open('/rs/zeta/2');
    const a1 = await open('/rs/alpha/1');
    await h.sw.evaluate(async ({ zs, as, w }) => {
      const z: number = await chrome.tabs.group({ tabIds: zs as [number, ...number[]], createProperties: { windowId: w } });
      await chrome.tabGroups.update(z, { title: 'zeta', color: 'blue' });
      const a: number = await chrome.tabs.group({ tabIds: as as [number, ...number[]], createProperties: { windowId: w } });
      await chrome.tabGroups.update(a, { title: 'alpha', color: 'blue' });
    }, { zs: [z1, z2], as: [a1], w: windowId });
    await h.sw.evaluate(() => chrome.storage.session.remove('rt'));
    expect(await groupOrder(h, windowId)).toEqual(['zeta', 'alpha']);
    await setConfig(h, config([rule('rs', `localhost:${h.port}/rs/:name/*`, '{name}', 'blue')]));

    // (a) A tab for a different templated value: its new group appends; the restored groups don't shift.
    const b1 = await openTab(h, `${base.a}/rs/beta/1`, windowId);
    await expect.poll(() => groupOrder(h, windowId), { timeout: 5000 }).toEqual(['zeta', 'alpha', 'beta']);
    expect(await groupOf(b1)).toBeGreaterThan(-1);
    await h.ui.waitForTimeout(500);
    expect(await groupOrder(h, windowId)).toEqual(['zeta', 'alpha', 'beta']);

    // (b) The user ungroups a tab of a restored group: it stays ungrouped after reconciles.
    await h.sw.evaluate((id) => chrome.tabs.ungroup(id), z2);
    await expect.poll(() => groupOf(z2)).toBe(-1);
    const b2 = await openTab(h, `${base.a}/rs/beta/2`, windowId);
    await expect.poll(async () => (await groupOf(b2)) === (await groupOf(b1)), { timeout: 5000 }).toBe(true);
    await setConfig(h, config([rule('rs', `localhost:${h.port}/rs/:name/*`, '{name}', 'cyan')]));
    await expect.poll(async () => (await groups(h)).find((g) => g.title === 'zeta')?.color, { timeout: 5000 }).toBe('cyan');
    expect(await groupOf(z2)).toBe(-1);
    expect(await groupOf(z1)).toBeGreaterThan(-1);
  });

  test('(h) context menu items exist after install (M2 T16)', async () => {
    // contextMenus.update rejects for an unknown id, so each resolving update proves onInstalled created the item.
    const exists = (id: string) => h.sw.evaluate(async (x) => chrome.contextMenus.update(x, {}).then(() => true, () => false), id);
    for (const id of ['tc-group', 'tc-close', 'tc-allowdup', 'tc-lock', 'tc-why']) await expect.poll(() => exists(id), { timeout: 5000 }).toBe(true);
    expect(await exists('tc-nope')).toBe(false);
  });

  test('(i) a help tip shown on hover stays open while the pointer moves onto it (WCAG 1.4.13)', async () => {
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extensionId}/options.html#/dedupe`);
    const btn = page.getByRole('button', { name: /^About / }).first();
    await btn.hover();
    const tip = page.locator(`[id="${await btn.getAttribute('aria-describedby')}"]`);
    await expect(tip).toBeVisible();
    // Move in small steps from the button's center straight down into the tip's text, crossing any gap between them.
    const b = (await btn.boundingBox())!;
    const t = (await tip.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width / 2, t.y + t.height - 4, { steps: 20 });
    await expect(tip).toBeVisible();
    await page.close();
  });

  test('(j) the Connections page lists GitHub and Jira as not connected, from the worker (M3 T7; no network)', async () => {
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extensionId}/options.html#/connections`);
    const card = page.getByRole('region', { name: 'GitHub' });
    await expect(card.getByText('Not connected')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await expect(page.getByLabel('Personal access token', { exact: true })).toHaveAttribute('type', 'password');
    const list = await send<{ defs: { id: string }[]; status: { state: string }[] }>(h, { type: 'connections.list' });
    expect(list.defs.map((d) => d.id)).toEqual(['github', 'jira']);
    expect(list.status.map((x) => x.state)).toEqual(['not-configured', 'not-configured']);
    await expect(page.getByRole('region', { name: 'Jira' }).getByText('Not connected')).toBeVisible();
    await page.close();
  });

  test('(k) Rules page: a recipe header drags the whole run, and a section moves as one block and persists (M4 rule sections)', async () => {
    const A = rule('a', `localhost:${h.port}/a/*`, 'a', 'blue');
    const B = rule('b', `localhost:${h.port}/b/*`, 'b', 'red');
    const c = config([A, B]);
    const finishedOnly = c.recipes.map((r) => ({ ...r, enabled: r.id === 'finished' }));
    await setConfig(h, { ...c, recipes: finishedOnly, order: ['finished/oauth-callback', 'finished/meet-ended', 'finished/redirect', 'user/a', 'user/b'],
      sections: [{ id: 'work', name: 'Work', rules: ['a', 'b'] }] });
    const page = await h.context.newPage();
    await page.goto(`chrome-extension://${h.extensionId}/options.html#/rules`);
    const finished = page.locator('.run', { has: page.getByRole('button', { name: /Finished · 3 rules/ }) });
    const work = page.locator('.run', { has: page.getByRole('button', { name: /Work \(2 rules\)/ }) });
    // Real HTML5 drag: the Finished header's handle onto the Work header (from above: lands after the section).
    await finished.getByRole('img', { name: 'Drag to move these rules' }).dragTo(work);
    await page.getByRole('button', { name: 'Save' }).click();
    const order = async () => (await send<{ config: Config }>(h, { type: 'config.get' })).config.order;
    await expect.poll(order, { timeout: 5000 }).toEqual(['user/a', 'user/b', 'finished/oauth-callback', 'finished/meet-ended', 'finished/redirect']);
    await page.getByRole('button', { name: 'Move section down' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(order, { timeout: 5000 }).toEqual(['finished/oauth-callback', 'finished/meet-ended', 'finished/redirect', 'user/a', 'user/b']);
    await page.reload();
    await expect(page.getByRole('button', { name: /Work \(2 rules\)/ })).toHaveAttribute('aria-expanded', 'false');
    await page.close();
  });
});
