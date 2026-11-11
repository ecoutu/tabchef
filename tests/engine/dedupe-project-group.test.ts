// Duplicates inside a project's group (#179): a second copy of a Jira ticket or of a project PR opens and joins the
// project's group. The Jira recipes put every /browse/<KEY> URL of a ticket into its project; their dedupe
// urlTransform folds Jira's own query params and fragment (?atlOrigin=, ?focusedCommentId=) into the bare ticket URL,
// so the copy closes into the existing tab. They also drop Jira's ?atlOrigin= tracking param on any page of the site, so a
// board copy opened from a shared link closes into the open board. github-prs does the same for a PR's sub-pages
// (/files, /changes, ...).
import { describe, expect, it, vi } from 'vitest';
import { DedupeHandler, NEW_TAB_AGE_MS, type DedupeDeps } from '../../src/engine/dedupe-handler';
import { defaultConfig } from '../../src/core/config/defaults';
import { resolveProjects } from '../../src/core/projects/resolve';
import { normalizeUrl } from '../../src/core/url/normalize';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config, TabSnap } from '../../src/core/types';
import { programOf } from '../helpers/config';

const SITE = 'https://acme.atlassian.net';
const TICKET = `${SITE}/browse/ABC-1`;
const TITLE = '[ABC-1] Login fails - Jira';
const GROUP = 70;

/** Default settings (always-switch) with the Jira ticket (PR title) recipe on, as a user who reported #179 has it. */
const cfg: Config = {
  ...defaultConfig(),
  recipes: defaultConfig().recipes.map((r) => (r.id === 'jira-ticket-title' ? { ...r, enabled: true } : r)),
};
const program = programOf(cfg);

type NewTab = Omit<TabSnap, 'index'> & Partial<Pick<TabSnap, 'index'>>;
const tab = (id: number, url: string, o: Partial<NewTab> = {}): NewTab => ({
  id, windowId: 1, url, title: TITLE, pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false, ...o,
});

/** The ABC-1 project is open (its group holds the existing tab); a second copy then opens into the group. */
function world(existingUrl: string, title = TITLE) {
  const port = new FakeBrowserPort();
  port.addWindow(1);
  port.addGroup({ id: GROUP, windowId: 1, title: 'ABC-1', color: 'blue', collapsed: false });
  port.addTab(tab(1, existingUrl, { groupId: GROUP, title }));
  let t = 1_000_000;
  const deps: DedupeDeps = {
    recentlyClosed: { add: () => 'rc1' }, log: { add: () => {} }, ask: vi.fn(async () => {}),
    isPaused: () => false, isLocked: () => false, now: () => t,
  };
  const h = new DedupeHandler(port, async () => program, deps);
  return { port, h, advance: (ms: number) => { t += ms; } };
}

/** Project key of each tab, as the ProjectService resolves it (proves both copies are "under" the ABC-1 project). ABC is a known prefix: the ticket tab is open. */
function projectKeys(tabs: TabSnap[]): Record<number, string | undefined> {
  const r = resolveProjects({
    snap: { tabs, groups: [], windows: [{ id: 1, type: 'normal', focused: true }] }, program, facts: () => ({}),
    projects: [], knownPrefixes: new Set(['ABC']), allowPrefixes: [], now: 0, sticky: new Map(),
  });
  return Object.fromEntries(tabs.map((x) => [x.id, r.assignments.get(x.id)?.key]));
}

async function openSecondCopy(existingUrl: string, newUrl: string, title = TITLE) {
  const w = world(existingUrl, title);
  w.port.addTab(tab(2, newUrl, { groupId: GROUP, openerTabId: 1, title }));
  const keys = projectKeys(w.port.state.tabs);
  w.h.recordCreated(2);
  await w.h.onCandidate(2, newUrl, 'pending');
  await w.h.onCandidate(2, newUrl, 'committed');
  return { open: w.port.state.tabs.map((x) => x.id), keys, port: w.port };
}

describe('duplicates of a Jira ticket inside its project group (#179)', () => {
  it('an identical /browse URL is closed', async () => {
    const r = await openSecondCopy(TICKET, TICKET);
    expect(r.open).toEqual([1]);
  });

  // Each case: both tabs belong to project ABC-1 (asserted), and the second copy should close.
  const cases: [string, string, string][] = [
    ['a link from Slack / email / Confluence (?atlOrigin=)', TICKET, `${TICKET}?atlOrigin=eyJpIjoiMTIzNDU2Nzg5MCIsInAiOiJqIn0`],
    ['a comment link from a notification (?focusedCommentId=)', TICKET, `${TICKET}?focusedCommentId=10001`],
    ['the existing ticket tab was opened with ?atlOrigin=, the copy is plain', `${TICKET}?atlOrigin=eyJpIjoiYWJjIn0`, TICKET],
  ];
  for (const [name, existing, dup] of cases) {
    it(`${name}: the second copy is closed`, async () => {
      const r = await openSecondCopy(existing, dup);
      expect(r.keys).toEqual({ 1: 'ABC-1', 2: 'ABC-1' }); // both are "under" the ABC-1 project
      expect(r.open).toEqual([1]);
    });
  }

  it('a comment link (?focusedCommentId=) focuses the existing ticket tab without changing its URL', async () => {
    const r = await openSecondCopy(TICKET, `${TICKET}?focusedCommentId=10001`);
    expect(r.port.state.tabs.map((x) => ({ id: x.id, url: x.url, active: x.active }))).toEqual([{ id: 1, url: TICKET, active: true }]);
  });

  it('a comment link with a #fragment: the kept ticket tab follows the fragment', async () => {
    const r = await openSecondCopy(TICKET, `${TICKET}?focusedCommentId=10001#comment-10001`);
    expect(r.port.state.tabs.map((x) => ({ id: x.id, url: x.url, active: x.active }))).toEqual([{ id: 1, url: `${TICKET}#comment-10001`, active: true }]);
  });

  it('the ticket open on a board (?selectedIssue=) is another page: a /browse/<KEY> copy stays open', async () => {
    const r = await openSecondCopy(`${SITE}/jira/software/projects/ABC/boards/1?selectedIssue=ABC-1`, TICKET);
    expect(r.keys).toEqual({ 1: undefined, 2: 'ABC-1' }); // a board showing a ticket is not the ticket's tab by default (#194)
    expect(r.open).toEqual([1, 2]);
  });

  it('another ticket of the same project group stays open', async () => {
    const r = await openSecondCopy(TICKET, `${SITE}/browse/ABC-2?atlOrigin=x`);
    expect(r.open).toEqual([1, 2]);
  });
});

describe('duplicates of a project PR inside its project group', () => {
  // The PR rule joins any `pull/:num*` page by its title; github-prs folds the sub-pages into the PR, including
  // GitHub's newer Files changed page (/changes).
  it('a PR in the project opened again on its /changes page: the second copy is closed', async () => {
    const pr = 'https://github.com/acme/api/pull/5';
    const r = await openSecondCopy(pr, `${pr}/changes`, 'ABC-1 fix login by emma · Pull Request #5 · acme/api');
    expect(r.keys).toEqual({ 1: 'ABC-1', 2: 'ABC-1' });
    expect(r.open).toEqual([1]);
  });
});

describe('a Jira board opened again from a shared link (&atlOrigin=) inside its project group (#179)', () => {
  // Jira's shared links add &atlOrigin=; its SPA strips it later with history.replaceState (Chrome then reports the new
  // URL as tabs.onUpdated({url}): onCandidate 'pending'), sometimes after the copy is no longer new (NEW_TAB_AGE_MS).
  const BOARD = `${SITE}/jira/software/projects/SCRUM/boards/1?filter=&groupBy=none&selectedIssue=SCRUM-1`;
  const SHARED = `${BOARD}&atlOrigin=test`;
  const BOARD_TITLE = 'SCRUM board - Agile Board - Jira';
  const ids = (w: { port: FakeBrowserPort }) => w.port.state.tabs.map((x) => x.id);
  const tab2 = (w: { port: FakeBrowserPort }) => w.port.state.tabs.find((x) => x.id === 2);
  /** Jira's replaceState dropping &atlOrigin= on tab 2, if it is still open. */
  async function strip(w: ReturnType<typeof world>) {
    const t2 = tab2(w);
    if (!t2) return;
    t2.url = BOARD;
    await w.h.onCandidate(2, BOARD, 'pending');
  }

  it('the board with and without &atlOrigin= has one dedupe key', () => {
    expect(normalizeUrl(SHARED, program.dedupe)?.key).toBe(normalizeUrl(BOARD, program.dedupe)?.key);
  });

  for (const stripAfterMs of [1_000, NEW_TAB_AGE_MS - 100, 12_000]) {
    it(`the copy closes at once, before Jira strips &atlOrigin= (${stripAfterMs} ms later)`, async () => {
      const w = world(BOARD, BOARD_TITLE);
      w.port.addTab(tab(2, SHARED, { groupId: GROUP, openerTabId: 1, title: BOARD_TITLE }));
      w.h.recordCreated(2);
      await w.h.onCandidate(2, SHARED, 'pending'); // tabs.onCreated (pendingUrl)
      await w.h.onCandidate(2, SHARED, 'committed'); // webNavigation.onCommitted
      expect(ids(w)).toEqual([1]);
      w.advance(stripAfterMs);
      await strip(w);
      expect(ids(w)).toEqual([1]);
    });
  }

  it('the existing board tab focuses, its URL unchanged', async () => {
    const w = world(BOARD, BOARD_TITLE);
    w.port.addTab(tab(2, SHARED, { groupId: GROUP, openerTabId: 1, title: BOARD_TITLE }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, SHARED, 'pending');
    await w.h.onCandidate(2, SHARED, 'committed');
    expect(w.port.state.tabs.map((x) => ({ id: x.id, url: x.url, active: x.active }))).toEqual([{ id: 1, url: BOARD, active: true }]);
  });

  it('a link pasted into a new tab 6 s after Ctrl+T closes, before Jira strips &atlOrigin= 5 s after load', async () => {
    const w = world(BOARD, BOARD_TITLE);
    w.port.addTab(tab(2, 'chrome://newtab/', { title: 'New Tab' }));
    w.h.recordCreated(2);
    w.advance(6_000);
    const t2 = tab2(w)!;
    t2.pendingUrl = SHARED;
    await w.h.onCandidate(2, SHARED, 'pending');
    t2.url = SHARED; delete t2.pendingUrl; t2.groupId = GROUP;
    await w.h.onCandidate(2, SHARED, 'committed');
    w.advance(5_000);
    await strip(w);
    expect(ids(w)).toEqual([1]);
  });

  it('Undo of the closed copy reopens it with &atlOrigin=; Jira stripping it 1 s later does not close it again', async () => {
    const w = world(BOARD, BOARD_TITLE);
    w.port.addTab(tab(2, SHARED, { groupId: GROUP, openerTabId: 1, title: BOARD_TITLE }));
    w.h.recordCreated(2);
    w.h.exemptOnce(2);
    await w.h.onCandidate(2, SHARED, 'pending');
    await w.h.onCandidate(2, SHARED, 'committed');
    w.advance(1_000);
    await strip(w);
    expect(ids(w)).toEqual([1, 2]);
  });

  it('another issue on the same board (&selectedIssue=SCRUM-2) from a shared link stays open', async () => {
    const w = world(BOARD, BOARD_TITLE);
    const other = `${SITE}/jira/software/projects/SCRUM/boards/1?filter=&groupBy=none&selectedIssue=SCRUM-2&atlOrigin=test`;
    w.port.addTab(tab(2, other, { groupId: GROUP, openerTabId: 1, title: BOARD_TITLE }));
    w.h.recordCreated(2);
    await w.h.onCandidate(2, other, 'pending');
    await w.h.onCandidate(2, other, 'committed');
    expect(ids(w)).toEqual([1, 2]);
  });
});
