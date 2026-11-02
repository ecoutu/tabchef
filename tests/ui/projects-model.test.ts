import { describe, it, expect } from 'vitest';
import { buildProjectCards, staleText } from '../../src/ui/projects-model';
import type { ProjectCardData } from '../../src/core/projects/types';

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
