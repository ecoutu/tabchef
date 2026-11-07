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

/** A stored project with each malformed optional field (saved, keep, archivedAt) dropped: the project itself is kept. */
function sanitize(p: Project): Project {
  const q = { ...p };
  if (q.saved !== undefined && !isSaved(q.saved)) delete q.saved;
  if (q.keep !== undefined && typeof q.keep !== 'boolean') delete q.keep;
  if (q.archivedAt !== undefined && !Number.isFinite(q.archivedAt)) delete q.archivedAt;
  return q;
}

/** Stored projects, cached after the first read. A failed read is retried and never overwritten. */
export class ProjectStore {
  private cache?: Promise<Map<string, Project>>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly local: Pick<KeyValueArea, 'get' | 'set'>) {}

  private load(): Promise<Map<string, Project>> {
    this.cache ??= this.local.get(PROJECTS_KEY).then((r) => {
      const v = r[PROJECTS_KEY];
      // A project stored before M4 T7 has no updatedAt: it reads as createdAt (nothing is written for it).
      return new Map((Array.isArray(v) ? v.filter(isProject).map(sanitize) : []).map((p) => [p.id, { ...p, updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : p.createdAt }]));
    }, (e: unknown) => {
      this.cache = undefined;
      throw e;
    });
    return this.cache;
  }

  async list(): Promise<Project[]> {
    return [...(await this.load()).values()].map((p) => structuredClone(p));
  }

  /** Stores (adds or replaces) each project, in one write. */
  put(...ps: Project[]): Promise<void> {
    return this.write((m) => { for (const p of ps) m.set(p.id, structuredClone(p)); });
  }

  remove(...ids: string[]): Promise<void> {
    return this.write((m) => { for (const id of ids) m.delete(id); });
  }

  private write(fn: (m: Map<string, Project>) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const m = await this.load();
      fn(m);
      await this.local.set({ [PROJECTS_KEY]: [...m.values()] });
    });
    this.chain = next.catch(() => {});
    return next;
  }
}
