// #195: the projects Done by fresh data (M3-R90) as of the last listing (ProjectService.cards), which the popup's
// Finished tab lists beside the close suggestions, and the Done prompts the user answered Keep to (keepDone), which
// neither the card nor the Finished tab shows again. Kept in storage.session `projects.done` (survives worker restarts,
// cleared on browser restart); the background recounts the badge, and the popup refreshes, when it changes.
import type { DoneProject, ProjectCardData } from '../core/projects/types';

export const DONE_PROJECTS_KEY = 'projects.done';

/** `projects`: the done projects listed (never a kept one); `kept`: the ids whose Done prompt was answered Keep. */
interface State { projects: DoneProject[]; kept: string[] }
type Session = { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };

const EMPTY: State = { projects: [], kept: [] };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isDone = (x: unknown): x is DoneProject => isObj(x) && typeof x.id === 'string' && typeof x.key === 'string'
  && typeof x.title === 'string' && typeof x.tabCount === 'number';

function parse(v: unknown): State {
  if (!isObj(v)) return EMPTY;
  return {
    projects: Array.isArray(v.projects) ? v.projects.filter(isDone) : [],
    kept: Array.isArray(v.kept) ? v.kept.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** The Finished tab's row for a done card: what it shows, without the tabs (their titles change, the count does not). */
function slim(c: ProjectCardData): DoneProject {
  return {
    id: c.id, key: c.key, title: c.title, ...(c.summary !== undefined && { summary: c.summary }),
    ...(c.prTitle !== undefined && { prTitle: c.prTitle }), ...(c.status && { status: c.status }), tabCount: c.tabs.length,
    ...(c.keep === true && { keep: true as const }),
  };
}

export class DoneProjects {
  private state?: Promise<State>;
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by each drop and retain; `removed` holds, per id, the generation that last took it off the list. */
  private gen = 0;
  private readonly removed = new Map<string, number>();

  /** Without `session` the state lives in memory. */
  constructor(private readonly session?: Session) {}

  private load(): Promise<State> {
    this.state ??= (this.session?.get(DONE_PROJECTS_KEY) ?? Promise.resolve(undefined)).then(parse, () => EMPTY);
    return this.state;
  }

  /** One change at a time; stored only when something changed, so an unchanged listing wakes no listener. */
  private change(fn: (s: State) => State): Promise<State> {
    const run = this.chain.then(async () => {
      const cur = await this.load();
      const next = fn(cur);
      if (JSON.stringify(next) === JSON.stringify(cur)) return cur;
      this.state = Promise.resolve(next);
      await this.session?.set(DONE_PROJECTS_KEY, next);
      return next;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Read before a listing collects its cards, and passed to noteListing (see there). */
  generation(): number {
    return this.gen;
  }

  /** Takes the ids `keep` rejects off the list, noting them as removed at generation `g`. */
  private remove(g: number, keep: (p: DoneProject) => boolean): Promise<unknown> {
    return this.change((cur) => {
      for (const p of cur.projects) if (!keep(p)) this.removed.set(p.id, g);
      return { ...cur, projects: cur.projects.filter(keep) };
    });
  }

  /** The done projects the Finished tab lists, as of the last listing. */
  async list(): Promise<DoneProject[]> {
    await this.chain;
    return (await this.load()).projects;
  }

  /**
   * A full listing (every open project): the done ones not kept replace the list, and a kept prompt whose project now
   * has a status that is not done (the ticket was reopened) is forgotten, so its next Done prompts again. Returns the
   * kept ids, which the cards carry as `doneKept`. `since` is the generation() read before the cards were collected: a
   * project dropped or retained off the list after that was seen by this listing before its tabs closed, so it is not
   * listed again (R5-M1); the next listing lists it if its tabs are still open.
   */
  async noteListing(cards: ProjectCardData[], since?: number): Promise<Set<string>> {
    const s = await this.change((cur) => {
      const reopened = new Set(cards.filter((c) => c.status !== undefined && c.status.category !== 'done').map((c) => c.id));
      const kept = cur.kept.filter((id) => !reopened.has(id));
      const gone = (id: string) => since !== undefined && (this.removed.get(id) ?? -1) > since;
      return { projects: cards.filter((c) => c.done && !kept.includes(c.id) && !gone(c.id)).map(slim), kept };
    });
    return new Set(s.kept);
  }

  /** After a pass: only projects still open stay listed. */
  retain(open: ReadonlySet<string>): Promise<unknown> {
    return this.remove(++this.gen, (p) => open.has(p.id));
  }

  /** Its tabs were closed (Close group, Close and save, Close and archive): off the list until a listing finds it again. */
  drop(id: string): Promise<unknown> {
    return this.remove(++this.gen, (p) => p.id !== id);
  }

  /** Keep on its Done prompt: off the list, and no prompt again until it is reopened. */
  keep(id: string): Promise<unknown> {
    return this.change((cur) => ({
      projects: cur.projects.filter((p) => p.id !== id), kept: cur.kept.includes(id) ? cur.kept : [...cur.kept, id],
    }));
  }
}
