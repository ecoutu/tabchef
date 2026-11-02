// The needs level test (M3-R12). Pure: compileProgram stays free of permission and connection state (R45); T12 wires
// this into PermissionsManager with the granted origins, permissions and usable connections.
//
// A needs entry's base needs (origins, permissions, connections) must all be granted. With `anyOf`, the level is the
// index of the first alternative (ordered best first) whose needs are all granted; none → paused, and the reason
// names every alternative. Without `anyOf` the level is 0. Grants are compared exactly; the caller passes effective
// needs (a host need implies `scripting`, engine/permissions.ts effectiveNeeds) and resolves broader host grants.
import type { NeedsAlt, NeedsEntry } from './types';

/** What is granted: origins (match patterns), optional permissions and the ids of connections that are usable. */
export interface Granted { origins: readonly string[]; permissions: readonly string[]; connections: readonly string[] }

export type NeedsLevel = { ok: true; level: number } | { ok: false; reason: string };

/** The host a match pattern names (`https://github.com/*` → `github.com`); the pattern itself otherwise. */
export const hostOf = (pattern: string): string => /^[^:]+:\/\/([^/:]+)/.exec(pattern)?.[1] ?? pattern;

/** What of `n` is not granted; undefined when all of it is. */
function missingOf(n: NeedsAlt, g: Granted): { origins: string[]; permissions: string[]; connections: string[] } | undefined {
  const origins = n.origins.filter((o) => !g.origins.includes(o));
  const permissions = n.permissions.filter((p) => !g.permissions.includes(p));
  const connections = (n.connections ?? []).filter((c) => !g.connections.includes(c));
  return origins.length || permissions.length || connections.length ? { origins, permissions, connections } : undefined;
}

/**
 * The one copy of the pause wording (spec §6.10, M3-R16), without the "Paused: " prefix: `needs access to <host>`
 * when origins are missing, else `needs the <permission> permission`. engine/permissions.ts pausedReason uses it.
 */
export function accessText(missing: { origins: readonly string[]; permissions: readonly string[] }): string {
  if (missing.origins.length > 0) return `needs access to ${missing.origins.map(hostOf).join(', ')}`;
  return `needs the ${missing.permissions.join(', ')} permission`;
}

/** "needs …" for one alternative: a connection first (`needs the <label> connection`), else accessText. */
function needsText(m: NonNullable<ReturnType<typeof missingOf>>, labels: Record<string, string>): string {
  if (m.connections.length) return `needs the ${m.connections.map((c) => (Object.hasOwn(labels, c) ? labels[c] : c)).join(', ')} connection`;
  return accessText(m);
}

/**
 * The level of needs entry `n` given what is granted, or the pause reason ("Paused: needs the GitHub connection, or
 * needs access to github.com"). `labels` maps connection ids to their labels (default: the id).
 */
export function needsLevel(n: NeedsEntry, granted: Granted, labels: Record<string, string> = {}): NeedsLevel {
  const base = missingOf(n, granted);
  if (base) return { ok: false, reason: `Paused: ${needsText(base, labels)}` };
  if (!n.anyOf || n.anyOf.length === 0) return { ok: true, level: 0 };
  const texts: string[] = [];
  for (const [level, alt] of n.anyOf.entries()) {
    const m = missingOf(alt, granted);
    if (!m) return { ok: true, level };
    texts.push(needsText(m, labels));
  }
  return { ok: false, reason: `Paused: ${texts.join(', or ')}` };
}
