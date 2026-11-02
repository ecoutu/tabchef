// Source query result types (M3 T8). SourceQueryKind is defined once, in core/lang/types (the rule language names it).
import type { ConnErrorKind } from '../connections/types';
export type { SourceQueryKind } from '../lang/types';

export type PrState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';
export interface PrInfo {
  owner: string; repo: string; number: number; state: PrState; mergedAt?: string; title?: string;
  headRefName?: string; reviewDecision?: string; url: string; ssoRequired?: { org: string; url: string };
}
export interface JiraIssue { key: string; summary?: string; status?: string; statusCategory?: 'new' | 'indeterminate' | 'done'; url: string }
/** `retryAt` / `sso`: from the failed request that set `error` (M3-R60); no request is sent before `retryAt`. */
export interface SourceEntry<T = unknown> {
  data?: T; fetchedAt: number; via: 'api' | 'page' | 'none'; final: boolean; stale: boolean; error?: ConnErrorKind;
  retryAt?: number; sso?: { org: string; url: string };
}
