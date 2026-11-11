import { describe, it, expect } from 'vitest';
import { buildDoneRows, buildProjectCards, projectSubtitle, staleText } from '../../src/ui/projects-model';
import type { DoneProject, ProjectCardData } from '../../src/core/projects/types';

const TICKET = 'https://acme.atlassian.net/browse/ABC-1';
const PR = 'https://github.com/acme/api/pull/7';
const card = (o: Partial<ProjectCardData> = {}): ProjectCardData => ({
  id: 'jira:ABC-1', key: 'ABC-1', title: 'ABC-1 · Login fails', done: false,
  tabs: [{ tabId: 1, windowId: 1, title: 'ABC-1 ticket', url: TICKET, lastAccessed: 10 }],
  linked: [], ...o,
});

describe('buildProjectCards (M3 T17)', () => {
  it('a project with status category done shows the close prompt; others do not', () => {
    const [done, open] = buildProjectCards([
      card({ id: 'a', status: { name: 'Done', category: 'done', via: 'api' }, done: true }),
      card({ id: 'b', status: { name: 'In Progress', category: 'indeterminate', via: 'page' } }),
    ]);
    expect(done).toMatchObject({ id: 'a', showClose: true, status: { label: 'Done', tone: 'done' } });
    expect(open).toMatchObject({ id: 'b', showClose: false, status: { label: 'In Progress', tone: 'progress' } });
    expect(buildProjectCards([card({ status: { name: 'To Do', category: 'new', via: 'title' } })])[0]!.status).toEqual({ label: 'To Do', tone: 'todo' });
  });

  it('M3-R90: a Done status that is not fresh (done: false: stale or stored) shows the status but no close prompt', () => {
    const [c] = buildProjectCards([card({ status: { name: 'Done', category: 'done', via: 'api' }, done: false })]);
    expect(c).toMatchObject({ showClose: false, status: { label: 'Done', tone: 'done' } });
  });

  it('M3-R72: without a ticket status the card has the title alone', () => {
    const [c] = buildProjectCards([card()]);
    expect(c).not.toHaveProperty('status');
    expect(c).toMatchObject({ title: 'ABC-1 · Login fails', tabCount: 1, showClose: false });
  });

  it('a linked PR already open in the project is not in linked', () => {
    const [c] = buildProjectCards([card({
      tabs: [{ tabId: 1, windowId: 1, title: 'T', url: TICKET }, { tabId: 2, windowId: 1, title: 'PR 7', url: PR, pill: 'open' }],
      linked: [{ url: PR, title: 'PR 7', state: 'open' }, { url: 'https://github.com/acme/web/pull/9', title: 'PR 9', state: 'merged' }],
    })]);
    expect(c!.linked).toEqual([{ url: 'https://github.com/acme/web/pull/9', title: 'PR 9', state: 'merged' }]);
    expect(c!.tabCount).toBe(2);
  });

  it('a stale PR row is stale: true with its PR pill; a fresh row has no stale flag', () => {
    const [c] = buildProjectCards([card({
      tabs: [{ tabId: 2, windowId: 1, title: 'PR 7', url: PR, pill: 'merged', stale: true }, { tabId: 1, windowId: 1, title: 'T', url: TICKET }],
    })]);
    expect(c!.tabs).toEqual([{ tabId: 2, title: 'PR 7', url: PR, pill: 'merged', stale: true }, { tabId: 1, title: 'T', url: TICKET }]);
    expect(staleText('GitHub')).toBe('Last known state; GitHub unavailable');
  });

  it("M3-R45: PrState 'unknown' is never shown as a pill or a linked state", () => {
    const [c] = buildProjectCards([card({
      tabs: [{ tabId: 2, windowId: 1, title: 'PR 7', url: PR, pill: 'unknown' }],
      linked: [{ url: 'https://github.com/acme/web/pull/9', title: 'PR 9', state: 'unknown' }],
    })]);
    expect(c!.tabs[0]).not.toHaveProperty('pill');
    expect(c!.linked[0]).toEqual({ url: 'https://github.com/acme/web/pull/9', title: 'PR 9' });
  });

  it('sorted by most recently active tab (a project without lastAccessed last)', () => {
    const at = (id: string, ...ts: (number | undefined)[]) => card({
      id, tabs: ts.map((t, i) => ({ tabId: i + 1, windowId: 1, title: 't', url: `${TICKET}?${i}`, ...(t !== undefined && { lastAccessed: t }) })),
    });
    expect(buildProjectCards([at('a', 5, 1), at('none', undefined), at('b', 2, 30), at('c', 20)]).map((c) => c.id)).toEqual(['b', 'c', 'a', 'none']);
  });
});

describe('projectSubtitle: the ticket title shown beside the project key in lists', () => {
  it('the Jira summary, beside a title that is the key', () => {
    expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123', summary: 'Fix login' })).toBe('Fix login');
  });
  it('none when the title already shows it (titleFormat {key} · {summary}), or without a summary or PR title', () => {
    expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123 · Fix login', summary: 'Fix login' })).toBeUndefined();
    expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123' })).toBeUndefined();
    expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123', summary: '  ' })).toBeUndefined();
  });
  it('a manual project (titled by its name, no summary) has none', () => {
    expect(projectSubtitle({ key: 'taxes', title: 'Taxes' })).toBeUndefined();
  });
  it('falls back to the first PR\'s title, without the key it starts with', () => {
    expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123', prTitle: 'Fix the login form' })).toBe('Fix the login form');
    for (const t of ['ABC-123: Fix login', '[ABC-123] Fix login', 'abc-123 - Fix login', 'ABC-123 Fix login', 'ABC-123 | Fix login']) {
      expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123', prTitle: t }), t).toBe('Fix login');
    }
    expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123', prTitle: 'ABC-123' })).toBeUndefined();
    expect(projectSubtitle({ key: 'ABC-1', title: 'ABC-1', prTitle: 'ABC-12: other' })).toBe('ABC-12: other');
  });
  it('the summary wins over the PR title', () => {
    expect(projectSubtitle({ key: 'ABC-123', title: 'ABC-123', summary: 'Fix login', prTitle: 'ABC-123: tests' })).toBe('Fix login');
  });
  it('buildProjectCards sets it on the card', () => {
    const [c] = buildProjectCards([card({ title: 'ABC-1', summary: 'Login fails' })]);
    expect(c!.subtitle).toBe('Login fails');
    expect(buildProjectCards([card()])[0]).not.toHaveProperty('subtitle');
  });
});

describe('#195: a Done prompt answered Keep, and the Finished view\'s done project rows', () => {
  it('a card whose Done prompt was kept (doneKept) shows the Done status without the prompt', () => {
    const [c] = buildProjectCards([{ id: 'a', key: 'ABC-1', title: 'ABC-1', status: { name: 'Done', category: 'done', via: 'api' }, done: true, doneKept: true, tabs: [], linked: [] }]);
    expect(c).toMatchObject({ showClose: false, status: { label: 'Done', tone: 'done' } });
  });

  it('buildDoneRows: title, subtitle, status pill, tab count, and whether it is a GitHub issue', () => {
    const done: DoneProject[] = [
      { id: 'jira:ABC-1', key: 'ABC-1', title: 'ABC-1', summary: 'Login fails', status: { name: 'Done', category: 'done', via: 'api' }, tabCount: 1 },
      { id: 'gh:acme/web#12', key: 'acme/web#12', title: 'acme/web#12 · Fix login', summary: 'Fix login', status: { name: 'Closed', category: 'done', via: 'page' }, tabCount: 3 },
    ];
    expect(buildDoneRows(done)).toEqual([
      { id: 'jira:ABC-1', title: 'ABC-1', subtitle: 'Login fails', status: { label: 'Done', tone: 'done' }, tabCount: 1 },
      { id: 'gh:acme/web#12', title: 'acme/web#12 · Fix login', status: { label: 'Closed', tone: 'done' }, tabCount: 3, issue: true },
    ]);
  });
});
