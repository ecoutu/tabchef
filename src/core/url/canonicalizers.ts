/**
 * Code canonicalizers for dedupe keys, by id (DedupeSettings.canonicalizers). Empty since M2 T6: M1's `githubPr` is
 * now the github-prs recipe's urlTransform. Unknown ids (including a stale 'githubPr') are ignored. Kept for future
 * built-ins that a regex cannot express.
 */
export const canonicalizers: Record<string, (u: URL) => URL> = {};
