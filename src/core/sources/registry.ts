// Source query registry (M3 T8): per-kind connection, batching, finality and cache TTL. Pure.
import type { ConnectionKind } from '../connections/types';
import type { SourceQueryKind } from './types';

export interface SourceQueryInfo { connectionKind: ConnectionKind; batch: number; final: (data: unknown) => boolean; ttlMs: number }
const MIN = 60_000;
const HOUR = 60 * MIN;

/** [call] values: open-PR TTL 5 min, key search 15 min, batch 50 PRs / 10 keys; Jira issue 5 min batch 50, projects 24 h. */
export const SOURCE_QUERIES: Record<SourceQueryKind, SourceQueryInfo> = {
  'github.pull_request': { connectionKind: 'github', batch: 50, final: (d) => (d as { state?: unknown } | null)?.state === 'merged', ttlMs: 5 * MIN },
  'github.search_prs_by_key': { connectionKind: 'github', batch: 10, final: () => false, ttlMs: 15 * MIN },
  'github.issue': { connectionKind: 'github', batch: 50, final: () => false, ttlMs: 5 * MIN },
  'jira.issue': { connectionKind: 'jira', batch: 50, final: () => false, ttlMs: 5 * MIN },
  'jira.projects': { connectionKind: 'jira', batch: 1, final: () => false, ttlMs: 24 * HOUR },
};

/**
 * Project `fields` (name -> dot path) out of a query result. A missing value is omitted, and so is PrState
 * 'unknown' (M3-R45), so a `field` condition sees it as missing and evaluates to unknown.
 */
export function pickFields(data: unknown, fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(fields)) {
    const segs = path.split('.');
    let v: unknown = data;
    for (const s of segs) {
      if (typeof v !== 'object' || v === null || !Object.hasOwn(v, s)) { v = undefined; break; }
      v = (v as Record<string, unknown>)[s];
    }
    if (v === undefined || v === null) continue;
    if (segs[segs.length - 1] === 'state' && v === 'unknown') continue;
    out[name] = v;
  }
  return out;
}
