// Page adapters (M3 T10): read a page's own markup when there is no API connection. Pure; shared by the adapters,
// the registry (index.ts) and the watch config (engine/page-facts.ts).

export type AdapterId = 'github.prPage' | 'jira.issuePage';
/** One CSS selector the watch content script reads: the element's text, or the attribute `attr`. */
export interface AdapterSelector { selector: string; attr?: string }

export interface Adapter {
  id: AdapterId;
  /** Where the adapter's selectors are sent: a URL glob as in rule `url` conditions. */
  urlPattern: string;
  /** Per field, ordered fallback selectors (the first that matches wins). */
  selectors: Readonly<Record<string, readonly AdapterSelector[]>>;
  /** The parsed fields of the page.facts extracts. */
  parse(extracts: Record<string, string>): object;
  /** Per field, the key of `parse`'s result that is its value (an `{adapter, field}` extract). */
  values: Readonly<Record<string, string>>;
}

/** The page.facts extracts key the watch reports a field under (selector extracts use `<ruleKey>.<name>`). */
export const adapterKey = (id: AdapterId, field: string): string => `adapter:${id}.${field}`;

/** Whitespace runs collapsed to one space and trimmed; undefined when that leaves nothing. */
export function cleanText(v: string | undefined): string | undefined {
  const s = v?.replace(/\s+/g, ' ').trim();
  return s ? s : undefined;
}
