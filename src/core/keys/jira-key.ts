// Jira issue key extraction (M3 T2). Pure; never throws. Imports the regex limits from core/match only (M3-R25).
import { MAX_MATCH_INPUT, MAX_REGEX_LEN } from '../match/pattern';
import { slowRegexProblem } from '../match/regex-safety';

export const DEFAULT_KEY_PATTERN = '[A-Z][A-Z0-9]+-\\d+';
/** Prefixes that look like keys but are not (UTF-8, SHA-256, ...); a recipe param the user can edit. */
export const DEFAULT_IGNORED_PREFIXES = ['UTF', 'ISO', 'SHA', 'RFC', 'CVE', 'GPT', 'COVID', 'HTTP', 'TLS', 'SSL', 'MD', 'AES', 'RSA', 'ES', 'PEP', 'WCAG', 'IPV', 'X86', 'ARM', 'CP', 'KB', 'JSR'];

export interface JiraKeyOptions {
  pattern?: string; allow?: string[]; ignore?: string[]; prefer?: Set<string>;
  /** The text is a branch name (headRefName): case-insensitive, keys uppercased, `_` separates (M3-R23), a key may follow `-` (M3-R105). */
  branch?: boolean;
}

const cache = new Map<string, RegExp | null>();

/** The global matcher for a key pattern, or null when it is too long, too slow or does not compile. */
function matcher(pattern: string, branch: boolean): RegExp | null {
  const id = `${branch ? 'b' : 't'}${pattern}`;
  let re = cache.get(id);
  if (re === undefined) {
    re = null;
    if (pattern.length <= MAX_REGEX_LEN && slowRegexProblem(pattern) === undefined) {
      try {
        // M3-R105: in a branch name `-`, `/` and `_` separate words, so a key may follow any of them
        // (`feature-abc-12-login`); in a title a key never follows `-` or `_`.
        const before = branch ? '(?<![A-Za-z0-9])' : '(?<![A-Za-z0-9_-])';
        re = new RegExp(`${before}(?:${pattern})${branch ? '(?![A-Za-z0-9])' : '(?![A-Za-z0-9_])'}`, branch ? 'gi' : 'g');
      } catch { /* uncompilable: no keys */ }
    }
    cache.set(id, re);
  }
  return re;
}

/** The key's prefix: everything before the last `-`, uppercased. */
const prefixOf = (key: string): string => {
  const i = key.lastIndexOf('-');
  return (i < 0 ? key : key.slice(0, i)).toUpperCase();
};

/** Unique keys in text order, those in `prefer` first. The text is capped at MAX_MATCH_INPUT characters. */
export function extractJiraKeys(text: string, o: JiraKeyOptions = {}): string[] {
  const re = matcher(o.pattern ?? DEFAULT_KEY_PATTERN, o.branch === true);
  if (!re) return [];
  const allow = new Set((o.allow ?? []).map((p) => p.toUpperCase()));
  const ignore = new Set((o.ignore ?? DEFAULT_IGNORED_PREFIXES).map((p) => p.toUpperCase()));
  const found: string[] = [];
  re.lastIndex = 0;
  for (const m of text.slice(0, MAX_MATCH_INPUT).matchAll(re)) {
    const key = o.branch ? m[0].toUpperCase() : m[0];
    const prefix = prefixOf(key);
    if (allow.size > 0 ? !allow.has(prefix) : ignore.has(prefix)) continue;
    if (!found.includes(key)) found.push(key);
  }
  const prefer = o.prefer;
  return prefer ? [...found.filter((k) => prefer.has(k)), ...found.filter((k) => !prefer.has(k))] : found;
}
