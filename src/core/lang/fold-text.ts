// Text folding for pageText matching (ruling R65), shared by the watch content script (page-watch) and the
// evaluator (cond.ts) so both sides agree: typographic quotes become ASCII, then the text is lower-cased.
const SINGLE = /[‘’‚‛′]/g; // ‘ ’ ‚ ‛ ′
const DOUBLE = /[“”„‟″]/g; // “ ” „ ‟ ″

/** Fold typographic quotes to ' and " and lower-case, for a case-insensitive, quote-insensitive substring test. */
export function foldText(s: string): string {
  return s.replace(SINGLE, "'").replace(DOUBLE, '"').toLowerCase();
}
