export const DRAG_ERROR = 'user may be dragging a tab';
export const DEFAULT_DRAG_DELAYS = [250, 500, 1000, 2000];

export class DragRetryExhausted extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DragRetryExhausted';
  }
}

const isDragError = (e: unknown): boolean =>
  (e instanceof Error ? e.message : String(e)).includes(DRAG_ERROR);

export async function withDragRetry<T>(fn: () => Promise<T>, delays: number[] = DEFAULT_DRAG_DELAYS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isDragError(e)) throw e;
      const delay = delays[attempt];
      if (delay === undefined) {
        throw new DragRetryExhausted(`Tab edit still blocked after ${attempt + 1} attempts`, { cause: e });
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
