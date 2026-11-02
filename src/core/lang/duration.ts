/** Durations: an integer and a unit (ms, s, m, h, d), e.g. '500ms', '30s', '15m', '2d'. The one grammar for config and runtime. */
export const DURATION = /^\d+(ms|s|m|h|d)$/;

export class DurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurationError';
  }
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse a duration string to milliseconds. Throws DurationError on anything outside the grammar. */
export function parseDuration(s: string): number {
  if (!DURATION.test(s)) throw new DurationError(`invalid duration: ${JSON.stringify(s)}`);
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(s) as RegExpExecArray;
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number);
}
