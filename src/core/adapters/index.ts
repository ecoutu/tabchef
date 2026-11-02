// Page adapter registry (M3 T10). An `{adapter, field}` extract reads one adapter field from the page facts; T11's
// SourceService uses the parsers as its page fallback. Pure.
import { GITHUB_PR_PAGE } from './github-pr-page';
import { JIRA_ISSUE_PAGE } from './jira-issue-page';
import type { Adapter, AdapterId } from './types';

export { adapterKey, type Adapter, type AdapterId, type AdapterSelector } from './types';

// Whole objects only, no property reads at module level: the bundler keeps those (they could run getters), and with
// them these selectors in every bundle that imports this module's chunk, content scripts included.
export const ADAPTERS: Record<AdapterId, Adapter> = { 'github.prPage': GITHUB_PR_PAGE, 'jira.issuePage': JIRA_ISSUE_PAGE };

/** The adapter named `id`, or undefined (an id that is not an own key, e.g. from an unvalidated rule). */
export const adapterOf = (id: string): Adapter | undefined => (Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id as AdapterId] : undefined);

/**
 * The value of an `{adapter, field}` extract in page.facts `extracts`, or undefined. PrState 'unknown' is never a
 * value (M3-R45): a `field` condition sees it as missing, so `!= 'merged'` stays unknown for an unreadable PR.
 */
export function adapterValue(id: AdapterId, field: string, extracts: Record<string, string>): string | undefined {
  const a = adapterOf(id);
  const k = a && Object.hasOwn(a.values, field) ? a.values[field] : undefined;
  if (!a || k === undefined) return undefined;
  const v = (a.parse(extracts) as Record<string, unknown>)[k];
  return typeof v === 'string' && v !== '' && !(k === 'state' && v === 'unknown') ? v : undefined;
}
