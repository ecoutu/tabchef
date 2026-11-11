// Duplicates of a GitHub issue opened from a link with extra parameters: GitHub's notification links add
// ?notification_referrer_id=, timeline links ?timeline_page=, and a link typed by hand may differ in owner/repo letter
// case. The github-issue recipe's dedupe urlTransform folds them into the issue URL, so a new copy closes into the open
// issue tab (as #179 does for Jira tickets).
import { describe, expect, it, vi } from 'vitest';
import { DedupeHandler, type DedupeDeps } from '../../src/engine/dedupe-handler';
import { defaultConfig } from '../../src/core/config/defaults';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';
import { programOf } from '../helpers/config';

const ISSUE = 'https://github.com/ecoutu/tabchef-fixtures/issues/2';
const ISSUE_TITLE = 'Fix login · Issue #2 · ecoutu/tabchef-fixtures';
const GROUP = 70;

const cfgWith = (ids: string[]): Config => ({
  ...defaultConfig(),
  recipes: defaultConfig().recipes.map((r) => (ids.includes(r.id) ? { ...r, enabled: true } : r)),
});

type NewTab = Omit<TabSnap, 'index'> & Partial<Pick<TabSnap, 'index'>>;
const tab = (id: number, url: string, title: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});

/** The existing tab is open in its project's group; a second copy then opens into the group as a new tab. */
async function openSecondCopy(cfg: Config, existingUrl: string, newUrl: string, title: string) {
  const program = programOf(cfg);
  const port = new FakeBrowserPort();
  port.addWindow(1);
  port.addGroup({ id: GROUP, windowId: 1, title: 'g', color: 'purple', collapsed: false });
  port.addTab(tab(1, existingUrl, title, { groupId: GROUP }));
  const deps: DedupeDeps = {
    recentlyClosed: { add: () => 'rc1' }, log: { add: () => {} }, ask: vi.fn(async () => {}),
    isPaused: () => false, isLocked: () => false, now: () => 1_000_000,
  };
  const h = new DedupeHandler(port, async () => program, deps);
  port.addTab(tab(2, newUrl, title, { groupId: GROUP, openerTabId: 1 }));
  h.recordCreated(2);
  await h.onCandidate(2, newUrl, 'pending');
  await h.onCandidate(2, newUrl, 'committed');
  return port.state.tabs.map((x) => ({ id: x.id, url: x.url, active: x.active }));
}

describe('a GitHub issue opened again from a link with extra parameters (github-issue on)', () => {
  const cfg = cfgWith(['github-issue']);
  for (const copy of [
    `${ISSUE}?notification_referrer_id=NT_kwDOABC`,
    `${ISSUE}?timeline_page=1`,
    'https://github.com/ECOUTU/Tabchef-Fixtures/issues/2',
    'https://github.com/Ecoutu/tabchef-fixtures/issues/2?notification_referrer_id=NT_x',
  ]) {
    it(`${copy}: the copy closes and the issue tab is focused, its URL unchanged`, async () => {
      expect(await openSecondCopy(cfg, ISSUE, copy, ISSUE_TITLE)).toEqual([{ id: 1, url: ISSUE, active: true }]);
    });
  }

  it('the existing tab was opened from a notification link, the copy is plain: the copy closes', async () => {
    const existing = `${ISSUE}?notification_referrer_id=NT_x`;
    expect(await openSecondCopy(cfg, existing, ISSUE, ISSUE_TITLE)).toEqual([{ id: 1, url: existing, active: true }]);
  });

  it('a notification link with a #fragment: the kept issue tab follows the fragment', async () => {
    const r = await openSecondCopy(cfg, ISSUE, `${ISSUE}?notification_referrer_id=NT_x#issuecomment-123`, ISSUE_TITLE);
    expect(r).toEqual([{ id: 1, url: `${ISSUE}#issuecomment-123`, active: true }]);
  });

  it('another issue of the same repository stays open', async () => {
    const r = await openSecondCopy(cfg, ISSUE, 'https://github.com/ECOUTU/tabchef-fixtures/issues/3?notification_referrer_id=NT_x', ISSUE_TITLE);
    expect(r.map((x) => x.id)).toEqual([1, 2]);
  });

  it('with github-issue off, a notification link stays open next to the issue', async () => {
    const r = await openSecondCopy(cfgWith([]), ISSUE, `${ISSUE}?notification_referrer_id=NT_x`, ISSUE_TITLE);
    expect(r.map((x) => x.id)).toEqual([1, 2]);
  });
});
