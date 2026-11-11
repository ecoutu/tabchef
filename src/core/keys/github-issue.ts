// GitHub issue key extraction. Pure; never throws. Keys look like `owner/repo#N`, owner and repo lower-cased.
import { MAX_MATCH_INPUT, MAX_REGEX_LEN } from '../match/pattern';
import { slowRegexProblem } from '../match/regex-safety';

/** A branch name such as `fix/179`, `feat/#179-dark-mode`: a conventional type, then the issue number (case-insensitive). */
export const DEFAULT_BRANCH_PATTERN =
  '^(?:feat|fix|perf|refactor|test|docs|build|ci|chore|style|revert|bugfix|hotfix|issue)/#?(?<n>[1-9]\\d{0,9})(?=-|$)';

export interface IssueRef { owner: string; repo: string; number: number }

const NUMBER = '[1-9]\\d{0,9}';
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const KEY_RE = new RegExp(`^([^/#\\s]+)/([^/#\\s]+)#(${NUMBER})$`);
const URL_RE = new RegExp(`^https://github\\.com/([^/?#\\s]+)/([^/?#\\s]+)/issues/(${NUMBER})/?(?:[?#].*)?$`, 'i');
const TAB_REPO_RE = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)(?:[/?#]|$)/i;

export const issueKey = (r: IssueRef): string => `${r.owner}/${r.repo}#${r.number}`.toLowerCase();

const validRepo = (owner: string, repo: string): boolean => OWNER_RE.test(owner) && REPO_RE.test(repo);

/** Parse a `owner/repo#N` key (lower-cased), or undefined when it is not one. */
export function parseIssueKey(key: string): IssueRef | undefined {
  const [, owner = '', repo = '', n = ''] = KEY_RE.exec(key) ?? [];
  if (!validRepo(owner, repo)) return undefined;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number: Number(n) };
}

/**
 * One segment of a glob against one segment of text, `*` matching any run of characters: greedy with one backtrack
 * point (the last star), so at worst glob length × text length, never exponential however many stars it has.
 */
function segmentMatch(glob: string, text: string): boolean {
  let g = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] === '*') { star = g++; mark = t; }
    else if (g < glob.length && glob[g] === text[t]) { g++; t++; }
    else if (star >= 0) { g = star + 1; t = ++mark; }
    else return false;
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/** `owner/repo` glob test, case-insensitive; `*` matches within one segment. */
function globMatch(glob: string, ownerRepo: string): boolean {
  const gs = glob.toLowerCase().split('/');
  const ts = ownerRepo.toLowerCase().split('/');
  return gs.length === ts.length && gs.every((g, i) => segmentMatch(g, ts[i]!));
}

/** Allowed when it matches `allow` (empty = all) and does not match `ignore`. */
export function repoAllowed(ownerRepo: string, allow: string[] = [], ignore: string[] = []): boolean {
  if (allow.length > 0 && !allow.some((g) => globMatch(g, ownerRepo))) return false;
  return !ignore.some((g) => globMatch(g, ownerRepo));
}

export interface GithubIssueOptions { pattern?: string; allow?: string[]; ignore?: string[]; tabUrl?: string }

const cache = new Map<string, RegExp | null>();
/** The case-insensitive matcher for a custom pattern, or null when too long, too slow or uncompilable. */
function matcher(pattern: string): RegExp | null {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = null;
    if (pattern.length <= MAX_REGEX_LEN && slowRegexProblem(pattern) === undefined) {
      try { re = new RegExp(pattern, 'i'); } catch { /* uncompilable: no issue */ }
    }
    cache.set(pattern, re);
  }
  return re;
}

function fromPattern(text: string, pattern: string, tabUrl: string | undefined): IssueRef | undefined {
  const re = matcher(pattern);
  if (!re) return undefined;
  const g = re.exec(text.slice(0, MAX_MATCH_INPUT))?.groups;
  if (!g || !new RegExp(`^${NUMBER}$`).test(g.n ?? '')) return undefined;
  let owner = g.owner ?? '';
  let repo = g.repo ?? '';
  if (!owner || !repo) {
    const t = tabUrl ? TAB_REPO_RE.exec(tabUrl) : null;
    if (!t) return undefined;
    owner = t[1] ?? '';
    repo = t[2] ?? '';
  }
  return validRepo(owner, repo) ? { owner, repo, number: Number(g.n) } : undefined;
}

/** The issue key in `text` (an issue URL, an `owner/repo#N` reference, or — with `pattern` — a branch name), or undefined. */
export function extractGithubIssue(text: string | undefined, o: GithubIssueOptions = {}): string | undefined {
  try {
    if (!text) return undefined;
    let ref: IssueRef | undefined;
    if (o.pattern !== undefined) ref = fromPattern(text, o.pattern, o.tabUrl);
    else {
      const t = text.slice(0, MAX_MATCH_INPUT).trim();
      const u = URL_RE.exec(t);
      ref = u ? parseIssueKey(`${u[1]}/${u[2]}#${u[3]}`) : parseIssueKey(t);
    }
    if (!ref) return undefined;
    const key = issueKey(ref);
    return repoAllowed(key.slice(0, key.indexOf('#')), o.allow, o.ignore) ? key : undefined;
  } catch { return undefined; }
}
