// M2 end-to-end (Task 20): the Finished recipe, global dry run and anchors in the built extension.
// The local server listens on 127.0.0.1 (D29), which the Finished default `http://127.0.0.1:*/*callback*` matches and
// which needs no host permission (optional permissions cannot be granted in e2e, M1 ruling T18).
import { expect, test } from '@playwright/test';
import type { Rule } from '../../src/core/types';
import { userKey } from '../../src/core/config/migrate';
import {
  config, groups, launch, openBackgroundTab, openTab, reset, rule, send, setConfig, tabs, type Harness,
} from './helpers';

interface WhyEntry { tabId?: number; ruleId?: string; action: string; detail: string }
interface ViewRow { tabId: number; url: string; suggested?: true }

test.describe('M2 in Chromium', () => {
  test.describe.configure({ mode: 'serial' });
  let h: Harness;
  let base: string;

  test.beforeAll(async () => {
    h = await launch();
    base = `http://127.0.0.1:${h.port}`;
  });
  test.afterAll(async () => { await h?.close(); });
  test.beforeEach(async () => { await reset(h); });

  const tabById = async (id: number) => (await tabs(h)).find((t) => t.id === id);
  const why = () => send<WhyEntry[]>(h, { type: 'why.all' });

  /**
   * Enables Finished in auto mode and waits until the worker runs it (its view is listed), so the callback tab opened
   * next is evaluated by the new Program and its commit is seen by the worker (R46, R51).
   */
  async function enableFinished(): Promise<void> {
    await send(h, { type: 'recipes.enable', id: 'finished', params: { mode: 'auto' } });
    await expect.poll(async () => (await send<{ id: string }[]>(h, { type: 'views.list' })).map((v) => v.id), { timeout: 5000 })
      .toContain('finished');
  }

  test('(a) Finished, auto: a background OAuth callback tab closes within 5 s and is in Recently closed', async () => {
    await enableFinished();
    const url = `${base}/auth/callback?code=e2e`;
    // Background (R17): a tabs.create tab is otherwise active in the focused window, and fire-time protection would
    // turn the close into a banner / suggestion.
    const id = await openBackgroundTab(h, url);
    await expect.poll(() => tabById(id), { timeout: 5000 }).toBeUndefined();

    const recent = await send<{ url: string; ruleId?: string }[]>(h, { type: 'recent.list' });
    expect(recent.find((r) => r.url === url)).toMatchObject({ ruleId: 'finished/oauth-callback' });
    expect((await why()).some((e) => e.tabId === id && e.action === 'auto-close')).toBe(true);
  });

  test('(b) Finished, auto: a focused callback tab stays open and is listed by the Finished view', async () => {
    await enableFinished();
    const url = `${base}/auth/callback?code=focused`;
    const id = await openTab(h, url);
    const windowId = (await tabById(id))!.windowId;
    await h.sw.evaluate((w) => chrome.windows.update(w, { focused: true }), windowId);

    // Delay 3 s, then fire-time protection: no banner without the scripting grant -> a suggestion instead.
    await expect.poll(async () => {
      const d = await send<{ kind: string; rows: ViewRow[] }>(h, { type: 'view.data', viewId: 'finished' });
      return d.rows.filter((r) => r.tabId === id).map((r) => ({ url: r.url, suggested: r.suggested }));
    }, { timeout: 8000 }).toEqual([{ url, suggested: true }]);
    expect(await tabById(id)).toMatchObject({ url });
    expect((await h.sw.evaluate((x) => chrome.tabs.get(x), id)).active).toBe(true);
    expect((await send<{ url: string }[]>(h, { type: 'recent.list' })).some((r) => r.url === url)).toBe(false);
    expect((await why()).some((e) => e.tabId === id && e.action === 'close-suggested')).toBe(true);
  });

  test('(c) global dry run + a new rule: the tab bar is unchanged and why.all has would-group', async () => {
    await setConfig(h, { ...config([rule('dr', `127.0.0.1:${h.port}/dr/*`, 'dry', 'blue')]), dryRun: true });
    const t1 = await openTab(h, `${base}/dr/1`);
    const wouldGroup = async (id: number) => (await why()).some((e) => e.tabId === id && e.action === 'would-group');
    await expect.poll(() => wouldGroup(t1), { timeout: 5000 }).toBe(true);
    // A second reconcile (another matching tab) also only logs.
    const t2 = await openTab(h, `${base}/dr/2`);
    await expect.poll(() => wouldGroup(t2), { timeout: 5000 }).toBe(true);

    expect(await groups(h)).toEqual([]);
    expect((await tabs(h)).filter((t) => t.id === t1 || t.id === t2).map((t) => t.groupId)).toEqual([-1, -1]);
    const e = (await why()).find((x) => x.tabId === t1 && x.action === 'would-group')!;
    expect(e).toMatchObject({ ruleId: 'user/dr' });
    expect(e.detail).toContain('dry');
  });

  test('(d) an anchor rule: creating the group opens the anchor tab inside it', async () => {
    const anchor = `${base}/anchor/home`;
    const r: Rule = {
      id: 'an', name: 'Anchored', enabled: true, match: { url: `127.0.0.1:${h.port}/an/*` },
      actions: [{ group: { title: 'anchored', color: 'green', anchors: [anchor] } }],
    };
    await setConfig(h, { ...config([]), rules: [r], order: [userKey('an')] });
    const t1 = await openTab(h, `${base}/an/1`);

    const groupOf = async (id: number) => (await tabById(id))?.groupId ?? -2;
    await expect.poll(() => groupOf(t1), { timeout: 5000 }).toBeGreaterThan(-1);
    const gid = await groupOf(t1);
    expect((await groups(h)).find((g) => g.id === gid)).toMatchObject({ title: 'anchored', color: 'green' });
    await expect.poll(async () => (await tabs(h)).filter((t) => t.url === anchor).map((t) => t.groupId), { timeout: 5000 })
      .toEqual([gid]);
  });
});
