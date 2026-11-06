// Project page actions shared by the popup's Projects tab and the dashboard / side panel Project home (M4 P2): send an
// action and surface its error, Close group's summary toast with its Undo, and the live refresh. Each surface passes
// its own reload and state setters, so nothing here knows about a component.
import { browser } from 'wxt/browser';
import { isConfigChangedMessage } from '../engine/messages';
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

  async function closeGroup(projectId: string): Promise<void> {
    const r = await send({ type: 'projects.closeGroup', projectId });
    if (!r.ok) { host.setError(r.error); return; }
    host.setError('');
    const { closed, skipped, ids } = r.data;
    const text = `Closed ${closed} ${closed === 1 ? 'tab' : 'tabs'}${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
    host.setToast(closed > 0 || skipped > 0 ? { text, ids } : undefined);
    await host.reload();
  }

  /** Restores the entries in turn; on a failure the ones not restored stay behind Undo. */
  async function undo(ids: string[]): Promise<void> {
    const text = host.getToast()?.text ?? '';
    for (const [i, id] of ids.entries()) {
      if (!(await act(() => send({ type: 'recent.undo', id })))) { host.setToast({ text, ids: ids.slice(i) }); await host.reload(); return; }
    }
    host.setToast(undefined);
    await host.reload();
  }

  return { act, focus, openLinked, closeGroup, undo };
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
