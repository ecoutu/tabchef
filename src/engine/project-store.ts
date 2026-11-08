// The ProjectStore (M3 T15): stored projects in storage.local `projects` (not synced), cached after the first read.
import type { Project } from '../core/projects/types';
import type { KeyValueArea } from './connections/secret-store';

export const PROJECTS_KEY = 'projects';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isProject = (x: unknown): x is Project => isObj(x) && typeof x.id === 'string' && typeof x.recipeId === 'string'
  && typeof x.key === 'string' && Array.isArray(x.manual) && Array.isArray(x.excluded) && Array.isArray(x.linked);

const isSavedTab = (x: unknown): boolean => isObj(x) && typeof x.url === 'string' && typeof x.title === 'string'
  && (x.group === undefined || typeof x.group === 'string') && (x.pinned === undefined || typeof x.pinned === 'boolean');
const isSaved = (x: unknown): x is NonNullable<Project['saved']> => isObj(x) && Array.isArray(x.tabs) && x.tabs.every(isSavedTab)
  && typeof x.at === 'number' && (x.closed === undefined || typeof x.closed === 'boolean');

const isPlain = (x: unknown): x is Record<string, unknown> => isObj(x) && !Array.isArray(x);

/** A stored project with each malformed optional field (saved, keep, archivedAt, syncExtra) dropped: the project itself is kept. */
function sanitize(p: Project): Project {
  const q = { ...p };
  if (q.saved !== undefined && !isSaved(q.saved)) delete q.saved;
  if (q.keep !== undefined && typeof q.keep !== 'boolean') delete q.keep;
  if (q.archivedAt !== undefined && !Number.isFinite(q.archivedAt)) delete q.archivedAt;
  if (q.syncExtra !== undefined && !isPlain(q.syncExtra)) delete q.syncExtra;
  return q;
}

const isManualEntry = (m: unknown): boolean => isObj(m) && typeof m.url === 'string' && typeof m.windowId === 'number'
  && (m.tabId === undefined || typeof m.tabId === 'number');
const isLinked = (l: unknown): boolean => isObj(l) && typeof l.url === 'string' && typeof l.title === 'string' && typeof l.state === 'string';
const optString = (v: unknown): boolean => v === undefined || typeof v === 'string';

/**
 * A project from outside the store (a backup file): the store's own checks plus well-formed entries, a createdAt and
 * string name, color, summary and site, else undefined. Malformed optional fields the store drops (sanitize), and a
 * malformed status, are dropped, keeping the project.
 */
export function parseProject(x: unknown): Project | undefined {
  if (!isProject(x) || !Number.isFinite(x.createdAt) || !x.manual.every(isManualEntry) || !x.excluded.every((u) => typeof u === 'string')
    || !x.linked.every(isLinked) || ![x.name, x.color, x.summary, x.site].every(optString)) return undefined;
  const p = sanitize(structuredClone(x));
  if (!Number.isFinite(p.updatedAt)) p.updatedAt = p.createdAt;
  const st: unknown = p.status;
  if (st !== undefined && !(isObj(st) && typeof st.name === 'string' && typeof st.category === 'string' && typeof st.via === 'string')) delete p.status;
  return p;
}

/** Stored projects, cached after the first read. A failed read is retried and never overwritten. */
export class ProjectStore {
  private cache?: Promise<Map<string, Project>>;
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * id → its stored saved list that could not be read: read without it, but stored as it was until a readable list
   * replaces it, so a later write (a rename, an archive) never loses it and a new worker still sees it (unreadableSaved).
   */
  private rawSaved = new Map<string, unknown>();

  constructor(private readonly local: Pick<KeyValueArea, 'get' | 'set'>) {}

  private load(): Promise<Map<string, Project>> {
    this.cache ??= this.local.get(PROJECTS_KEY).then((r) => {
      const v = r[PROJECTS_KEY];
      // A project stored before M4 T7 has no updatedAt: it reads as createdAt (nothing is written for it).
      const ps = Array.isArray(v) ? v.filter(isProject) : [];
      for (const p of ps) if (p.saved !== undefined && !isSaved(p.saved)) this.rawSaved.set(p.id, p.saved);
      return new Map(ps.map(sanitize).map((p) => [p.id, { ...p, updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : p.createdAt }]));
    }, (e: unknown) => {
      this.cache = undefined;
      throw e;
    });
    return this.cache;
  }

  async list(): Promise<Project[]> {
    return [...(await this.load()).values()].map((p) => structuredClone(p));
  }

  /**
   * The ids of projects whose stored saved list could not be read (see rawSaved). Project sync leaves them out, or
   * their missing list would read as every tab removed.
   */
  async unreadableSaved(): Promise<Set<string>> {
    await this.load();
    return new Set(this.rawSaved.keys());
  }

  /** Stores (adds or replaces) each project, in one write. */
  put(...ps: Project[]): Promise<void> {
    return this.write((m) => {
      for (const p of ps) {
        m.set(p.id, structuredClone(p));
        if (isSaved(p.saved)) this.rawSaved.delete(p.id);
      }
    });
  }

  remove(...ids: string[]): Promise<void> {
    return this.write((m) => { for (const id of ids) { m.delete(id); this.rawSaved.delete(id); } });
  }

  private write(fn: (m: Map<string, Project>) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const m = await this.load();
      fn(m);
      await this.local.set({ [PROJECTS_KEY]: [...m.values()].map((p) => (this.rawSaved.has(p.id) && !isSaved(p.saved) ? { ...p, saved: this.rawSaved.get(p.id) } : p)) });
    });
    this.chain = next.catch(() => {});
    return next;
  }
}
