// GitHub issue query builder and response parser. Pure: no fetch, no chrome.*.
// Like github.ts, user data (owner, repo, number) only ever travels in `variables`; the query text is fixed text + aliases.
import type { ConnErrorKind } from '../connections/types';
import { issueKey, type IssueRef } from '../keys/github-issue';
import { collectErrors, issuesForbidden, isObj, mapState, splitKey, ssoUrl, str, type GqlBuild } from './github';
import { SOURCE_QUERIES } from './registry';
import type { GithubIssueInfo, PrInfo } from './types';

const ISSUE_FIELDS = 'title state stateReason url closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number title url state isDraft merged mergedAt headRefName repository { owner { login } name } } }';

export interface IssueResult {
  issues: Map<string, GithubIssueInfo>;
  errors: { key: string; kind: ConnErrorKind; sso?: { org: string; url: string } }[];
  rate?: { remaining: number; limit: number; resetAt: string };
  /** An issue was refused for lack of the GitHub App's Issues permission (see issuesForbidden in ./github). */
  issuesForbidden?: true;
}

/**
 * One `repository` alias (r<i>) per repo holding an `issue` alias (i<j>) per issue. `aliases` maps r<i> to
 * 'owner/repo' and i<j> to the issue key, both lower-cased. Throws over the batch size.
 */
export function buildIssueQuery(issues: IssueRef[]): GqlBuild {
  const max = SOURCE_QUERIES['github.issue'].batch;
  if (issues.length > max) throw new Error(`too many issues in one query: ${issues.length} > ${max}`);
  const variables: Record<string, unknown> = {};
  const aliases = new Map<string, string>();
  const decls: string[] = [];
  const repos = new Map<string, { i: number; issues: { j: number }[] }>();
  let j = 0;
  for (const x of issues) {
    const rk = `${x.owner}/${x.repo}`.toLowerCase(); // as issueKey: parseIssueResponse finds the repo alias by the key's repo
    let r = repos.get(rk);
    if (!r) {
      r = { i: repos.size, issues: [] };
      repos.set(rk, r);
      variables[`o${r.i}`] = x.owner;
      variables[`n${r.i}`] = x.repo;
      decls.push(`$o${r.i}: String!`, `$n${r.i}: String!`);
      aliases.set(`r${r.i}`, rk);
    }
    variables[`k${j}`] = x.number;
    decls.push(`$k${j}: Int!`);
    aliases.set(`i${j}`, issueKey(x));
    r.issues.push({ j });
    j++;
  }
  const body = [...repos.values()].map((r) =>
    `r${r.i}: repository(owner: $o${r.i}, name: $n${r.i}) { ${r.issues.map((x) => `i${x.j}: issue(number: $k${x.j}) { ${ISSUE_FIELDS} }`).join(' ')} }`).join(' ');
  return { query: `query(${decls.join(', ')}) { ${body} rateLimit { cost remaining limit resetAt } }`, variables, aliases };
}

const unknownIssue = (key: string, sso?: { org: string; url: string }): GithubIssueInfo => {
  const r = splitKey(key);
  return { ...r, state: 'unknown', url: `https://github.com/${r.owner}/${r.repo}/issues/${r.number}`, ...(sso ? { ssoRequired: sso } : {}) };
};

function linkedPrs(v: unknown): PrInfo[] | undefined {
  if (!isObj(v) || !Array.isArray(v.nodes)) return undefined;
  const out: PrInfo[] = [];
  for (const n of v.nodes) {
    if (!isObj(n) || typeof n.number !== 'number' || !isObj(n.repository)) continue;
    const owner = isObj(n.repository.owner) ? str(n.repository.owner.login) : undefined;
    const repo = str(n.repository.name);
    if (!owner || !repo) continue;
    const info: PrInfo = { owner, repo, number: n.number, state: mapState(n), url: str(n.url) ?? `https://github.com/${owner}/${repo}/pull/${n.number}` };
    const title = str(n.title); if (title !== undefined) info.title = title;
    const head = str(n.headRefName); if (head !== undefined) info.headRefName = head;
    const mergedAt = str(n.mergedAt); if (mergedAt) info.mergedAt = mergedAt;
    out.push(info);
  }
  return out;
}

export function parseIssueResponse(body: unknown, aliases: Map<string, string>): IssueResult {
  const out: IssueResult = { issues: new Map(), errors: [] };
  const root = isObj(body) ? body : {};
  const data = isObj(root.data) ? root.data : {};
  const rl = data.rateLimit;
  if (isObj(rl) && typeof rl.remaining === 'number' && typeof rl.limit === 'number' && typeof rl.resetAt === 'string') {
    out.rate = { remaining: rl.remaining, limit: rl.limit, resetAt: rl.resetAt };
  }
  const errs = collectErrors(root);
  // The issue itself ([r<i>, i<j>]): a refused field inside an issue that was read is no missing Issues permission.
  if (issuesForbidden(root, (p) => p.length === 2 && aliases.has(String(p[1])) && String(p[1]).startsWith('i'))) out.issuesForbidden = true;
  const repoAliasOfRepo = new Map<string, string>();
  for (const [a, v] of aliases) if (a.startsWith('r')) repoAliasOfRepo.set(v, a);

  for (const [alias, key] of aliases) {
    if (!alias.startsWith('i')) continue;
    const ra = repoAliasOfRepo.get(key.slice(0, key.lastIndexOf('#'))) ?? '';
    const repoNode = data[ra];
    const node = isObj(repoNode) ? repoNode[alias] : undefined;
    if (isObj(node)) {
      const closed = node.state === 'CLOSED';
      const info: GithubIssueInfo = {
        ...splitKey(key),
        state: closed ? 'closed' : node.state === 'OPEN' ? 'open' : 'unknown',
        url: str(node.url) ?? unknownIssue(key).url,
      };
      if (closed) { info.status = 'Closed'; info.statusCategory = 'done'; }
      else if (node.state === 'OPEN') { info.status = 'Open'; info.statusCategory = 'new'; }
      const title = str(node.title); if (title !== undefined) info.summary = title;
      const reason = str(node.stateReason); if (reason) info.stateReason = reason;
      const prs = linkedPrs(node.closedByPullRequestsReferences); if (prs) info.linkedPrs = prs;
      out.issues.set(key, info);
      continue;
    }
    const kind = errs.item.get(alias) ?? errs.repo.get(ra) ?? errs.global ?? 'not-found';
    const { owner } = splitKey(key);
    const sso = kind === 'sso-required' ? { org: owner, url: ssoUrl(owner) } : undefined;
    out.issues.set(key, unknownIssue(key, sso));
    out.errors.push({ key, kind, ...(sso ? { sso } : {}) });
  }
  return out;
}
