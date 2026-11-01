import { browser } from 'wxt/browser';
import type { Request, ResponseFor } from '../engine/messages';

/** Typed request to the background worker. Resolves to an error response if the worker is unreachable. */
export async function send<R extends Request>(req: R): Promise<ResponseFor<R>> {
  try {
    return (await browser.runtime.sendMessage(req)) as ResponseFor<R>;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) } as ResponseFor<R>;
  }
}
