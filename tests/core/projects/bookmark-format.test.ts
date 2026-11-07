import { describe, expect, it } from 'vitest';
import { fromFolder, ROOT_TITLE, toFolder, type FolderNode, type SyncedProject } from '../../../src/core/projects/bookmark-format';

const project: SyncedProject = {
  id: 'jira:ABC-1', recipeId: 'jira', key: 'ABC-1', name: 'Fix login', color: 'blue', updatedAt: 1_800_000_000_000,
  groups: [
    { title: 'Code', tabs: [{ url: 'https://github.com/acme/api/pull/5', title: 'PR 5' }, { url: 'https://example.com/a', title: 'A' }] },
    { title: 'Docs', tabs: [{ url: 'https://example.com/d', title: 'D' }] },
    { title: '', tabs: [{ url: 'https://example.com/loose', title: 'Loose' }] },
  ],
};

const metaOf = (f: FolderNode) => f.children![0]!;
const decode = (url: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(url.split('#')[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
const encode = (o: unknown) => 'https://tabchef.invalid/project#' + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('bookmark folder format', () => {
  it('names the root folder Tabchef', () => expect(ROOT_TITLE).toBe('Tabchef'));

  it('writes the metadata bookmark first, then group subfolders, then ungrouped tabs', () => {
    const f = toFolder(project);
    expect(f.title).toBe('Fix login');
    expect(metaOf(f).url).toMatch(/^https:\/\/tabchef\.invalid\/project#[A-Za-z0-9_-]+$/);
    expect(metaOf(f).title).toBe("Tabchef project data (don't edit)");
    expect(decode(metaOf(f).url!)).toEqual({ id: 'jira:ABC-1', recipeId: 'jira', key: 'ABC-1', name: 'Fix login', color: 'blue', updatedAt: 1_800_000_000_000 });
    expect(f.children!.slice(1).map((c) => c.title)).toEqual(['Code', 'Docs', 'Loose']);
    expect(f.children![1]!.children!.map((c) => c.url)).toEqual(['https://github.com/acme/api/pull/5', 'https://example.com/a']);
    expect(f.children![3]).toEqual({ title: 'Loose', url: 'https://example.com/loose' });
  });

  it('titles the folder with the key when the project has no name', () => {
    expect(toFolder({ ...project, name: undefined }).title).toBe('ABC-1');
  });

  it('round-trips, including archivedAt and unknown metadata fields', () => {
    const p: SyncedProject = { ...project, archivedAt: 5, extra: { future: { a: [1, 2] }, flag: true } };
    expect(fromFolder(toFolder(p))).toEqual(p);
    expect(decode(metaOf(toFolder(p)).url!)).toMatchObject({ future: { a: [1, 2] }, flag: true });
    expect(fromFolder(toFolder(project))).toEqual(project);
  });

  it('lets known fields win over extra of the same name', () => {
    const f = toFolder({ ...project, extra: { key: 'evil', updatedAt: 1 } });
    expect(fromFolder(f)).toMatchObject({ key: 'ABC-1', updatedAt: 1_800_000_000_000 });
  });

  it('parses a folder edited by hand in the bookmark manager', () => {
    const f = toFolder(project);
    f.title = 'Renamed by hand';
    f.children![1]!.title = 'Code 2';
    f.children![1]!.children![0]!.title = 'Renamed tab';
    f.children![1]!.children!.push({ id: '99', title: 'New', url: 'https://example.com/new' });
    f.children![1]!.children!.push({ title: 'Deep', children: [{ title: 'x', url: 'https://example.com/x' }] });
    f.children!.push({ title: 'Added loose', url: 'https://example.com/loose2' });
    const r = fromFolder(f) as SyncedProject;
    expect(r.id).toBe('jira:ABC-1');
    expect(r.name).toBe('Fix login');
    expect(r.groups[0]).toEqual({ title: 'Code 2', tabs: [
      { url: 'https://github.com/acme/api/pull/5', title: 'Renamed tab' }, { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/new', title: 'New' }] });
    expect(r.groups[2]!.tabs.map((t) => t.url)).toEqual(['https://example.com/loose', 'https://example.com/loose2']);
  });

  it('finds the metadata bookmark when it was moved', () => {
    const f = toFolder(project);
    f.children = [...f.children!.slice(1), f.children![0]!];
    expect(fromFolder(f)).toEqual(project);
  });

  it('reports a folder without a metadata bookmark', () => {
    expect(fromFolder({ title: 'x', children: [{ title: 'a', url: 'https://example.com' }] })).toEqual({ error: expect.stringContaining('metadata') });
    expect(fromFolder({ title: 'empty' })).toHaveProperty('error');
  });

  it('reports metadata that does not decode or lacks required fields', () => {
    const bad = (url: string) => fromFolder({ title: 'x', children: [{ title: 'm', url }] });
    expect(bad('https://tabchef.invalid/project#!!!')).toHaveProperty('error');
    expect(bad('https://tabchef.invalid/project#' + btoa('not json'))).toHaveProperty('error');
    expect(bad(encode({ id: 'a' }))).toHaveProperty('error');
    expect(bad(encode([1]))).toHaveProperty('error');
    expect(bad(encode({ id: 'a', recipeId: 'r', key: 'k', updatedAt: 'x' }))).toHaveProperty('error');
  });

  it('drops an unknown color from the typed project (kept in extra)', () => {
    const r = fromFolder({ title: 'x', children: [{ title: 'm', url: encode({ id: 'a', recipeId: 'r', key: 'k', updatedAt: 1, color: 'mauve' }) }] });
    expect(r).toEqual({ id: 'a', recipeId: 'r', key: 'k', updatedAt: 1, groups: [], extra: { color: 'mauve' } });
  });

  it('writes back a known field it could not use, as read', () => {
    const raw = { id: 'a', recipeId: 'r', key: 'k', updatedAt: 1, color: 'mauve', name: 7, archivedAt: 'later' };
    const r = fromFolder({ title: 'x', children: [{ title: 'm', url: encode(raw) }] }) as SyncedProject;
    expect(r.extra).toEqual({ color: 'mauve', name: 7, archivedAt: 'later' });
    expect(decode(metaOf(toFolder(r)).url!)).toEqual(raw);
    expect(decode(metaOf(toFolder({ ...r, color: 'red' })).url!)).toMatchObject({ color: 'red' });
  });

  it('truncates titles over 4 KB', () => {
    const long = 'x'.repeat(5000);
    const f = toFolder({ ...project, name: long, groups: [{ title: long, tabs: [{ url: 'https://example.com', title: long }] }] });
    expect(f.title).toHaveLength(4096);
    expect(f.children![1]!.title).toHaveLength(4096);
    expect(f.children![1]!.children![0]!.title).toHaveLength(4096);
    const r = fromFolder({ ...f, children: [f.children![0]!, { title: long, children: [{ title: long, url: 'https://example.com' }] }] }) as SyncedProject;
    expect(r.groups[0]!.title).toHaveLength(4096);
    expect(r.groups[0]!.tabs[0]!.title).toHaveLength(4096);
  });

  it('keeps unicode metadata intact', () => {
    const p = { ...project, name: 'Ünï 日本 🍳' };
    expect(fromFolder(toFolder(p))).toEqual(p);
  });

  it('throws naming the project when metadata would exceed 8 KB', () => {
    expect(() => toFolder({ ...project, extra: { big: 'x'.repeat(9000) } })).toThrow('jira:ABC-1');
  });
});
