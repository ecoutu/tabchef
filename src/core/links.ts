// Options-page hashes that the engine opens and the UI routes (R28). Kept in core so engine/ never imports ui/.

/** The conflict view of a tab ("Why is this tab here?", M2 T14). T16's context-menu item opens options at this hash. */
export function explainHash(tabId: number): string {
  return `#/explain/${tabId}`;
}

/** The kinds of pre-filled rule the context menu creates (M2 T16): group, auto-close, never dedupe. */
export type NewRuleKind = 'group' | 'close' | 'allowDup';

/** The pre-filled rule page (`#/rules/new?url=<enc>&kind=…`, M2 T16) the context menu opens. */
export function newRuleHash(url: string, kind: NewRuleKind): string {
  return `#/rules/new?${new URLSearchParams({ url, kind }).toString()}`;
}

/** A project's home page (`#/project/<id>`, M4 T3). The id (`repo:acme/web`) is one encoded segment. */
export function projectHomeHash(id: string): string {
  return `#/project/${encodeURIComponent(id)}`;
}

/** The Projects page with its New project form open for this tab (`#/projects?new=<tabId>`, M4 T6). */
export function newProjectHash(tabId: number): string {
  return `#/projects?new=${tabId}`;
}
