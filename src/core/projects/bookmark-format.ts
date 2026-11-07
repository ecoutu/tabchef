// Project ↔ bookmark folder tree (M4 T12, slice 4.3). Pure: no chrome.* use. T13 merges `SyncedProject`s and T14 reads and
// writes the folders under the `Tabchef` bookmark folder.
//
// A project is one folder: a metadata bookmark (identity and settings as base64url JSON in its URL, M4-R26), one subfolder
// per tab group, then the ungrouped tabs as plain bookmarks. `fromFolder` tolerates hand edits made in Chrome's bookmark
// manager (the metadata wins for identity, never the folder title). Metadata fields this build doesn't know are kept in
// `extra` and written back (D6).
import { COLORS } from '../config/schema';
import type { GroupColor } from '../types';

export interface FolderNode { id?: string; title: string; url?: string; children?: FolderNode[] }

export interface SyncedProject {
  id: string; recipeId: string; key: string; name?: string; color?: GroupColor; updatedAt: number; archivedAt?: number;
  groups: { title: string; tabs: { url: string; title: string }[] }[];
  /** Metadata JSON fields this build doesn't know (M4-R22): parsed here and written back unchanged. */
  extra?: Record<string, unknown>;
}

export const ROOT_TITLE = 'Tabchef';

const META_URL_PREFIX = 'https://tabchef.invalid/project#';
const META_TITLE = "Tabchef project data (don't edit)";
const MAX_TITLE = 4096;
const MAX_META_URL = 8192;

const clip = (s: string): string => {
  if (s.length <= MAX_TITLE) return s;
  const end = s.charCodeAt(MAX_TITLE - 1);
  // Don't cut a surrogate pair in half.
  return s.slice(0, end >= 0xd800 && end <= 0xdbff ? MAX_TITLE - 1 : MAX_TITLE);
};

const encode = (o: unknown): string => {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(o))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const decode = (s: string): unknown => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};

const KNOWN = ['id', 'recipeId', 'key', 'name', 'color', 'updatedAt', 'archivedAt'];

/** Throws an Error naming the project when its metadata bookmark would exceed 8 KB. */
export function toFolder(p: SyncedProject): FolderNode {
  const meta: Record<string, unknown> = { ...p.extra };
  // A known key this build couldn't use is kept in `extra` as read; it stays unless the typed field is set.
  for (const k of ['id', 'recipeId', 'key', 'updatedAt']) delete meta[k];
  Object.assign(meta, { id: p.id, recipeId: p.recipeId, key: p.key, updatedAt: p.updatedAt });
  if (p.name !== undefined) meta.name = clip(p.name);
  if (p.color !== undefined) meta.color = p.color;
  if (p.archivedAt !== undefined) meta.archivedAt = p.archivedAt;
  const url = META_URL_PREFIX + encode(meta);
  if (url.length > MAX_META_URL) throw new Error(`project ${p.id}: metadata is ${url.length} chars, over the ${MAX_META_URL} limit`);
  const tab = (t: { url: string; title: string }): FolderNode => ({ title: clip(t.title), url: t.url });
  const children: FolderNode[] = [{ title: META_TITLE, url }];
  for (const g of p.groups) if (g.title !== '') children.push({ title: clip(g.title), children: g.tabs.map(tab) });
  for (const g of p.groups) if (g.title === '') children.push(...g.tabs.map(tab));
  return { title: clip(p.name ?? p.key), children };
}

export function fromFolder(n: FolderNode): SyncedProject | { error: string } {
  const kids = n.children ?? [];
  const metaNode = kids.find((c) => c.url?.startsWith(META_URL_PREFIX));
  if (!metaNode) return { error: `folder "${n.title}" has no project metadata bookmark` };
  let meta: unknown;
  try { meta = decode(metaNode.url!.slice(META_URL_PREFIX.length)); } catch {
    return { error: `folder "${n.title}": project metadata does not decode` };
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return { error: `folder "${n.title}": project metadata is not an object` };
  const m = meta as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.recipeId !== 'string' || typeof m.key !== 'string' || typeof m.updatedAt !== 'number') {
    return { error: `folder "${n.title}": project metadata lacks id, recipeId, key or updatedAt` };
  }
  const p: SyncedProject = { id: m.id, recipeId: m.recipeId, key: m.key, updatedAt: m.updatedAt, groups: [] };
  if (typeof m.name === 'string') p.name = clip(m.name);
  if (typeof m.color === 'string' && COLORS.has(m.color)) p.color = m.color as GroupColor;
  if (typeof m.archivedAt === 'number') p.archivedAt = m.archivedAt;
  const used: Record<string, boolean> = { name: p.name !== undefined, color: p.color !== undefined, archivedAt: p.archivedAt !== undefined };
  const extra = Object.fromEntries(Object.entries(m).filter(([k]) => !KNOWN.includes(k) || (k in used && !used[k])));
  if (Object.keys(extra).length) p.extra = extra;
  const tab = (c: FolderNode) => ({ url: c.url!, title: clip(c.title) });
  const loose: { url: string; title: string }[] = [];
  for (const c of kids) {
    if (c === metaNode) continue;
    if (c.url !== undefined) loose.push(tab(c));
    else if (c.children) p.groups.push({ title: clip(c.title), tabs: c.children.filter((t) => t.url !== undefined).map(tab) });
  }
  if (loose.length) p.groups.push({ title: '', tabs: loose });
  return p;
}
