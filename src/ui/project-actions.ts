// Project page actions shared by the popup's Projects tab, the dashboard's Projects page and the dashboard / side panel
// Project home (M4 P2): send an action and surface its error, the close actions' summary toast with its Undo, the
// lifecycle actions (M4 T9: reopen, Keep, archive, unarchive, delete) and the live refresh. Each surface passes
// its own reload and state setters, so nothing here knows about a component.
import { browser } from 'wxt/browser';
import { isConfigChangedMessage, type Request } from '../engine/messages';
import { send } from './send';

export const LIVE_MS = 5000;

/** After Close group: the closed tabs' recently-closed entries, which Undo reopens (recent.undo). */
export interface Toast { text: string; ids: string[] }

export interface ProjectActionsHost {
  /** After an action: re-read the surface (and, in the popup, refresh its counts). */
  reload: () => Promise<void>;
  setError: (message: string) => void;
  getToast: () => Toast | undefined;
  setToast: (toast: Toast | undefined) => void;
}

export function createProjectActions(host: ProjectActionsHost) {
  /** Runs a request; a failure is shown as the error. Resolves to whether it succeeded. */
  async function act(run: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
    const r = await run();
    if (!r.ok) { host.setError(r.error ?? 'Something went wrong'); return false; }
    host.setError('');
    return true;
  }

  const focus = (tabId: number) => void act(() => send({ type: 'tab.focus', tabId }));

  async function openLinked(projectId: string, url: string): Promise<void> {
    if (await act(() => send({ type: 'projects.openLinked', projectId, url }))) await host.reload();
  }

  /** Close group, Close and save (M4 T7) and Close and archive (M4 T9): the summary toast with its Undo, then reload. */
  async function closeTabs(type: 'projects.closeGroup' | 'projects.closeAndSave' | 'projects.closeAndArchive', projectId: string): Promise<void> {
    const r = await send({ type, projectId });
    if (!r.ok) { host.setError(r.error); return; }
    host.setError('');
    const { closed, skipped, ids } = r.data;
    const text = `Closed ${closed} ${closed === 1 ? 'tab' : 'tabs'}${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
    host.setToast(closed > 0 || skipped > 0 ? { text, ids } : undefined);
    await host.reload();
  }

  const closeGroup = (projectId: string) => closeTabs('projects.closeGroup', projectId);
  const closeAndSave = (projectId: string) => closeTabs('projects.closeAndSave', projectId);
  const closeAndArchive = (projectId: string) => closeTabs('projects.closeAndArchive', projectId);

  /** Runs a lifecycle request, then reloads when it succeeded. Resolves to whether it did. */
  async function lifecycle(req: Extract<Request, { type: 'projects.setKeep' | 'projects.archive' | 'projects.unarchive' | 'projects.delete' }>): Promise<boolean> {
    if (!(await act(() => send(req)))) return false;
    await host.reload();
    return true;
  }
  /** Reopen (M4 T7): when Chrome refused some saved tabs, a toast (no Undo) says how many could not be opened. */
  async function reopen(projectId: string): Promise<boolean> {
    const r = await send({ type: 'projects.reopen', projectId });
    if (!r.ok) { host.setError(r.error); return false; }
    host.setError('');
    const { opened, failed = 0 } = r.data;
    const text = opened > 0 ? `Opened ${opened} ${opened === 1 ? 'tab' : 'tabs'} · ${failed} could not be opened`
      : `${failed} saved ${failed === 1 ? 'tab' : 'tabs'} could not be opened`;
    if (failed > 0) host.setToast({ text, ids: [] });
    await host.reload();
    return true;
  }
  const setKeep = (projectId: string, keep: boolean) => lifecycle({ type: 'projects.setKeep', projectId, keep });
  const archive = (projectId: string) => lifecycle({ type: 'projects.archive', projectId });
  const unarchive = (projectId: string) => lifecycle({ type: 'projects.unarchive', projectId });
  /** Delete for good (M4 T9): the caller asks first (M4-R9). */
  const remove = (projectId: string) => lifecycle({ type: 'projects.delete', projectId });

  /** Restores the entries in turn; on a failure the ones not restored stay behind Undo. */
  async function undo(ids: string[]): Promise<void> {
    const text = host.getToast()?.text ?? '';
    for (const [i, id] of ids.entries()) {
      if (!(await act(() => send({ type: 'recent.undo', id })))) { host.setToast({ text, ids: ids.slice(i) }); await host.reload(); return; }
    }
    host.setToast(undefined);
    await host.reload();
  }

  return { act, focus, openLinked, closeGroup, closeAndSave, closeAndArchive, reopen, setKeep, archive, unarchive, remove, undo };
}

/** Calls `load` on config.changed, on becoming visible and every LIVE_MS while visible. Returns the stop function. */
export function startLiveRefresh(load: () => Promise<void>): () => void {
  const onMessage = (m: unknown) => { if (isConfigChangedMessage(m)) void load(); };
  const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
  browser.runtime.onMessage.addListener(onMessage);
  const timer = setInterval(onVisible, LIVE_MS);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    browser.runtime.onMessage.removeListener(onMessage);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
