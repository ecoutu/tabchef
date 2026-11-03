// A content script's one-way message to the worker that never throws (banner choices). After the extension is
// reloaded or updated, the old script keeps running in open pages: its runtime.sendMessage throws "Extension context
// invalidated" synchronously, or rejects while the worker is unreachable. Either way the answer is undefined.
export function sendQuietly(send: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(send()).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}
