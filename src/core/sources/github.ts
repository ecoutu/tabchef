// GitHub GraphQL query builders and response parsers (M3 T8). Pure: no fetch, no chrome.*.
// User data (owner, repo, number, search terms) only ever travels in `variables`; the query text is fixed text + aliases.
import type { ConnErrorKind } from '../connections/types';
import { extractJiraKeys, type JiraKeyOptions } from '../keys/jira-key';
import { issueKey } from '../keys/github-issue';
import type { PrInfo, PrState } from './types';

export const MAX_PR_BATCH = 50;
export const MAX_SEARCH_KEYS = 10;
export interface PrRef { owner: string; repo: string; number: number }
export interface GqlBuild { query: string; variables: Record<string, unknown>; aliases: Map<string, string> }
export interface PrStateResult {
  prs: Map<string, PrInfo>;
  rate?: { remaining: number; limit: number; resetAt: string };
  errors: { key: string; kind: ConnErrorKind; sso?: { org: string; url: string } }[];
  /** A PR that was read had its closingIssuesReferences refused for lack of the GitHub App's Issues permission (issuesForbidden). */
  issuesForbidden?: true;
  /**
   * An error's path ends in closingIssuesReferences: 'forbidden' when it is the Issues-permission refusal, else 'error'.
   * GitHub may null the PR (or all `data`) for it instead of the field alone, so an unread PR may be lost to that
   * field only: fetchPrs asks again without it.
   */
  closingFailed?: 'forbidden' | 'error';
  /** Keys of the unread PRs a closingIssuesReferences error may have lost: those it names, every unread PR when `data` is null. */
  closingLost?: string[];
}

const BASE_PR_FIELDS = 'state merged mergedAt isDraft title headRefName reviewDecision url';
const CLOSING_FIELD = 'closingIssuesReferences(first: 5) { nodes { number repository { owner { login } name } } }';
export const prKey = (p: PrRef): string => `${p.owner}/${p.repo}#${p.number}`;
export const ssoUrl = (owner: string): string => `https://github.com/orgs/${owner}/sso`;

/**
 * One `repository` alias (r<i>) per repo holding a `pullRequest` alias (p<j>) per PR. `aliases` maps r<i> to
 * 'owner/repo' and p<j> to 'owner/repo#n'. `closing: false` leaves closingIssuesReferences out. Throws over 50 PRs.
 */
export function buildPrStateQuery(prs: PrRef[], o: { closing?: boolean } = {}): GqlBuild {
  const fields = o.closing === false ? BASE_PR_FIELDS : `${BASE_PR_FIELDS} ${CLOSING_FIELD}`;
  if (prs.length > MAX_PR_BATCH) throw new Error(`too many PRs in one query: ${prs.length} > ${MAX_PR_BATCH}`);
  const variables: Record<string, unknown> = {};
  const aliases = new Map<string, string>();
  const decls: string[] = [];
  const repos = new Map<string, { i: number; prs: { j: number; number: number }[] }>();
  let j = 0;
  for (const p of prs) {
    const rk = `${p.owner}/${p.repo}`;
    let r = repos.get(rk);
    if (!r) {
      r = { i: repos.size, prs: [] };
      repos.set(rk, r);
      variables[`o${r.i}`] = p.owner;
      variables[`n${r.i}`] = p.repo;
      decls.push(`$o${r.i}: String!`, `$n${r.i}: String!`);
      aliases.set(`r${r.i}`, rk);
    }
    variables[`k${j}`] = p.number;
    decls.push(`$k${j}: Int!`);
    aliases.set(`p${j}`, prKey(p));
    r.prs.push({ j, number: p.number });
    j++;
  }
  const body = [...repos.values()].map((r) =>
    `r${r.i}: repository(owner: $o${r.i}, name: $n${r.i}) { ${r.prs.map((x) => `p${x.j}: pullRequest(number: $k${x.j}) { ${fields} }`).join(' ')} }`).join(' ');
  const query = `query(${decls.join(', ')}) { ${body} rateLimit { cost remaining limit resetAt } }`;
  return { query, variables, aliases };
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function mapState(n: Record<string, unknown>): PrState {
  if (n.state === 'MERGED' || n.merged === true) return 'merged';
  if (n.state === 'CLOSED') return 'closed';
  if (n.state === 'OPEN' && n.isDraft === true) return 'draft';
  return 'open';
}

export function splitKey(k: string): PrRef {
  const m = /^(.*?)\/(.*)#(\d+)$/.exec(k);
  return { owner: m?.[1] ?? '', repo: m?.[2] ?? '', number: Number(m?.[3] ?? 0) };
}
const unknownPr = (k: string, sso?: { org: string; url: string }): PrInfo => {
  const r = splitKey(k);
  return { ...r, state: 'unknown', url: `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`, ...(sso ? { ssoRequired: sso } : {}) };
};

/** SAML = FORBIDDEN plus `extensions.saml_failure` or a SAML message (M3-R27). */
function isSaml(e: Record<string, unknown>): boolean {
  if (e.type !== 'FORBIDDEN') return false;
  const ext = isObj(e.extensions) ? e.extensions : {};
  return Boolean(ext.saml_failure) || /SAML/i.test(str(e.message) ?? '');
}

/**
 * Whether `root` has an error refusing a field for lack of the GitHub App's Issues permission: a non-SAML FORBIDDEN
 * `Resource not accessible by integration` whose path satisfies `at`.
 */
export function issuesForbidden(root: Record<string, unknown>, at: (path: unknown[]) => boolean): boolean {
  return (Array.isArray(root.errors) ? root.errors : []).some((e) => isObj(e) && e.type === 'FORBIDDEN' && !isSaml(e)
    && /Resource not accessible by integration/i.test(str(e.message) ?? '') && Array.isArray(e.path) && at(e.path as unknown[]));
}

/** GraphQL errors by where they hit: path[0] (a repo / search alias), path[1] (a PR alias), or no path (whole response).
 * Errors with a 3+ segment path (a field inside an item, e.g. closingIssuesReferences without the Issues permission)
 * land in `item` under path[1] as before, but parsers only read `item` when the item node itself is missing, so
 * a present item is never failed by one of its fields. */
export interface Errs { repo: Map<string, ConnErrorKind>; item: Map<string, ConnErrorKind>; global?: ConnErrorKind }
export function collectErrors(root: Record<string, unknown>): Errs {
  const out: Errs = { repo: new Map(), item: new Map() };
  for (const e of Array.isArray(root.errors) ? root.errors : []) {
    if (!isObj(e)) continue;
    // Per-item errors must never produce 'unauthorized' (the 401 / re-auth kind, which would flag the whole connection).
    // A non-SAML FORBIDDEN (app not installed, private repo) is a per-item failure; GitHub hides such repos as not found.
    const kind: ConnErrorKind = isSaml(e) ? 'sso-required' : e.type === 'NOT_FOUND' || e.type === 'FORBIDDEN' ? 'not-found' : e.type === 'RATE_LIMITED' ? 'rate-limited' : 'server';
    const [a, b] = Array.isArray(e.path) ? (e.path as unknown[]) : [];
    if (typeof a !== 'string') { if (out.global !== 'rate-limited') out.global = e.type === 'RATE_LIMITED' ? 'rate-limited' : 'server'; }
    else if (typeof b === 'string') out.item.set(b, kind);
    else out.repo.set(a, kind);
  }
  return out;
}

/** Issue keys from a `closingIssuesReferences` connection; undefined when absent (null when the app lacks Issues access). */
function closingIssues(v: unknown): string[] | undefined {
  if (!isObj(v) || !Array.isArray(v.nodes)) return undefined;
  const keys: string[] = [];
  for (const n of v.nodes) {
    if (!isObj(n) || typeof n.number !== 'number' || !isObj(n.repository)) continue;
    const owner = isObj(n.repository.owner) ? str(n.repository.owner.login) : undefined;
    const repo = str(n.repository.name);
    if (owner && repo) keys.push(issueKey({ owner, repo, number: n.number }));
  }
  return keys;
}

export function parsePrStateResponse(body: unknown, aliases: Map<string, string>): PrStateResult {
  const out: PrStateResult = { prs: new Map(), errors: [] };
  const root = isObj(body) ? body : {};
  const data = isObj(root.data) ? root.data : {};
  const rl = data.rateLimit;
  if (isObj(rl) && typeof rl.remaining === 'number' && typeof rl.limit === 'number' && typeof rl.resetAt === 'string') {
    out.rate = { remaining: rl.remaining, limit: rl.limit, resetAt: rl.resetAt };
  }
  const errs = collectErrors(root);
  // Only a PR that was read: an unread one may be lost to that field alone (closingFailed), and counts once read again.
  const closingOf = (p: unknown[]) => p.length >= 3 && p.at(-1) === 'closingIssuesReferences';
  const read = (p: unknown[]) => { const r = data[String(p[0])]; return isObj(r) && isObj(r[String(p[1])]); };
  if (issuesForbidden(root, (p) => closingOf(p) && read(p))) out.issuesForbidden = true;
  if (issuesForbidden(root, closingOf)) out.closingFailed = 'forbidden';
  else if ((Array.isArray(root.errors) ? root.errors : []).some((e) => isObj(e) && Array.isArray(e.path) && closingOf(e.path as unknown[]))) out.closingFailed = 'error';
  const closingAt = new Set((Array.isArray(root.errors) ? root.errors : [])
    .flatMap((e) => (isObj(e) && Array.isArray(e.path) && closingOf(e.path as unknown[]) ? [String((e.path as unknown[])[1])] : [])));
  const lost = (alias: string) => out.closingFailed !== undefined && (!isObj(root.data) || closingAt.has(alias));
  const repoOf = new Map<string, string>(); // p alias -> r alias, from the response shape
  for (const [ra, rv] of Object.entries(data)) if (isObj(rv)) for (const pa of Object.keys(rv)) repoOf.set(pa, ra);
  const repoAliasOfRepo = new Map<string, string>();
  for (const [a, v] of aliases) if (a.startsWith('r')) repoAliasOfRepo.set(v, a);

  for (const [alias, key] of aliases) {
    if (!alias.startsWith('p')) continue;
    const ra = repoAliasOfRepo.get(key.slice(0, key.lastIndexOf('#'))) ?? repoOf.get(alias) ?? '';
    const repoNode = data[ra];
    const node = isObj(repoNode) ? repoNode[alias] : undefined;
    if (isObj(node)) {
      const pr = splitKey(key);
      const info: PrInfo = { ...pr, state: mapState(node), url: str(node.url) ?? unknownPr(key).url };
      const mergedAt = str(node.mergedAt); if (mergedAt) info.mergedAt = mergedAt;
      const title = str(node.title); if (title !== undefined) info.title = title;
      const head = str(node.headRefName); if (head !== undefined) info.headRefName = head;
      const rd = str(node.reviewDecision); if (rd) info.reviewDecision = rd;
      const closing = closingIssues(node.closingIssuesReferences); if (closing) info.closingIssues = closing;
      out.prs.set(key, info);
      continue;
    }
    const kind = errs.item.get(alias) ?? errs.repo.get(ra) ?? errs.global ?? 'not-found';
    const { owner } = splitKey(key);
    const sso = kind === 'sso-required' ? { org: owner, url: ssoUrl(owner) } : undefined;
    out.prs.set(key, unknownPr(key, sso));
    out.errors.push({ key, kind, ...(sso ? { sso } : {}) });
    if (lost(alias)) (out.closingLost ??= []).push(key);
  }
  return out;
}

/**
 * Per key, a title search (alias s<2i>) and a head-branch search (s<2i+1>); at most 10 keys. Search text lives in
 * `variables` ($q<n>) only, so the query string is fixed (M3-R28). No orgs searches `involves:@me`.
 */
export function buildKeySearchQuery(keys: string[], orgs: string[]): GqlBuild {
  if (keys.length > MAX_SEARCH_KEYS) throw new Error(`too many keys in one query: ${keys.length} > ${MAX_SEARCH_KEYS}`);
  const scope = orgs.length ? orgs.map((o) => `org:${o}`).join(' ') : 'involves:@me';
  const variables: Record<string, unknown> = {};
  const aliases = new Map<string, string>();
  const decls: string[] = [];
  const parts: string[] = [];
  keys.forEach((key, i) => {
    for (const [n, q] of [[2 * i, `"${key}" in:title is:pr ${scope}`], [2 * i + 1, `head:${key} is:pr ${scope}`]] as const) {
      variables[`q${n}`] = q;
      decls.push(`$q${n}: String!`);
      aliases.set(`s${n}`, key);
      parts.push(`s${n}: search(type: ISSUE, first: 20, query: $q${n}) { nodes { ... on PullRequest { number title url state isDraft merged mergedAt headRefName repository { owner { login } name } } } }`);
    }
  });
  return { query: `query(${decls.join(', ')}) { ${parts.join(' ')} }`, variables, aliases };
}

export interface KeySearchResult {
  byKey: Map<string, PrInfo[]>;
  /** Keys with at least one failed alias: callers must treat them as unknown, not as "no PR". */
  errors: { key: string; kind: ConnErrorKind; sso?: { org: string; url: string } }[];
}

/**
 * Keep a hit only when its title or branch really contains the exact key (drops ABC-12 for ABC-1). A failed alias is
 * reported in `errors` (its key is still in `byKey` with whatever the other alias found). `orgs` names the SSO org when
 * the search was scoped to exactly one.
 */
export function parseKeySearchResponse(body: unknown, aliases: Map<string, string>, keyOpts: JiraKeyOptions = {}, orgs: string[] = []): KeySearchResult {
  const byKey = new Map<string, PrInfo[]>();
  const errors: KeySearchResult['errors'] = [];
  const root = isObj(body) ? body : {};
  const data = isObj(root.data) ? root.data : {};
  const errs = collectErrors(root);
  for (const key of new Set(aliases.values())) byKey.set(key, []);
  for (const [alias, key] of aliases) {
    const s = data[alias];
    if (!isObj(s) || !Array.isArray(s.nodes)) {
      const kind = errs.repo.get(alias) ?? errs.item.get(alias) ?? errs.global ?? 'not-found';
      if (errors.some((x) => x.key === key)) continue;
      const org = orgs.length === 1 ? orgs[0] : undefined;
      errors.push({ key, kind, ...(kind === 'sso-required' && org ? { sso: { org, url: ssoUrl(org) } } : {}) });
      continue;
    }
    const list = byKey.get(key)!;
    for (const n of s.nodes) {
      if (!isObj(n) || typeof n.number !== 'number' || !isObj(n.repository)) continue;
      const owner = isObj(n.repository.owner) ? str(n.repository.owner.login) : undefined;
      const repo = str(n.repository.name);
      if (!owner || !repo) continue;
      const title = str(n.title) ?? '';
      const head = str(n.headRefName) ?? '';
      const want = key.toUpperCase();
      const hit = extractJiraKeys(title, keyOpts).some((k) => k.toUpperCase() === want)
        || extractJiraKeys(head, { ...keyOpts, branch: true }).some((k) => k.toUpperCase() === want);
      if (!hit) continue;
      const id = prKey({ owner, repo, number: n.number });
      if (list.some((p) => prKey(p) === id)) continue;
      const info: PrInfo = { owner, repo, number: n.number, state: mapState(n), title, headRefName: head, url: str(n.url) ?? `https://github.com/${owner}/${repo}/pull/${n.number}` };
      const mergedAt = str(n.mergedAt); if (mergedAt) info.mergedAt = mergedAt;
      list.push(info);
    }
  }
  return { byKey, errors };
}
