// Jira REST query builders and response parsers (M3 T9). Pure: no fetch, no chrome.*.
import type { ApiRequest, ConnErrorKind } from '../connections/types';
import { DEFAULT_KEY_PATTERN } from '../keys/jira-key';
import { SOURCE_QUERIES } from './registry';
import type { JiraIssue } from './types';

const KEY_RE = new RegExp(`^${DEFAULT_KEY_PATTERN}$`);
const CATEGORIES: ReadonlySet<string> = new Set(['new', 'indeterminate', 'done']);
const PROJECT_PAGE = 100;

/** `key in (A-1,B-2)`. Keys must fully match the default key pattern (no JQL injection); throws over the batch size. */
export function buildIssueSearch(keys: string[]): ApiRequest {
  const max = SOURCE_QUERIES['jira.issue'].batch;
  if (keys.length > max) throw new Error(`too many keys in one query: ${keys.length} > ${max}`);
  for (const k of keys) if (!KEY_RE.test(k)) throw new Error(`not a Jira issue key: ${JSON.stringify(k)}`);
  return {
    method: 'GET', path: '/rest/api/3/search/jql',
    query: { jql: `key in (${keys.join(',')})`, fields: 'summary,status', maxResults: String(keys.length) },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** `site` is a hostname ('acme.atlassian.net'). An unknown statusCategory key leaves statusCategory unset (M3-R32). */
export function parseIssueSearch(body: unknown, site: string): Map<string, JiraIssue> {
  const out = new Map<string, JiraIssue>();
  const issues = isObj(body) && Array.isArray(body.issues) ? body.issues : [];
  for (const n of issues) {
    if (!isObj(n)) continue;
    const key = str(n.key);
    if (!key) continue;
    const f = isObj(n.fields) ? n.fields : {};
    const issue: JiraIssue = { key, url: `https://${site}/browse/${key}` };
    const summary = str(f.summary); if (summary !== undefined) issue.summary = summary;
    if (isObj(f.status)) {
      const status = str(f.status.name); if (status !== undefined) issue.status = status;
      const cat = isObj(f.status.statusCategory) ? str(f.status.statusCategory.key) : undefined;
      if (cat !== undefined && CATEGORIES.has(cat)) issue.statusCategory = cat as JiraIssue['statusCategory'];
    }
    out.set(key, issue);
  }
  return out;
}

/** Halves of a key list, the first being the larger. */
export function splitOnBadRequest(keys: string[]): [string[], string[]] {
  const mid = Math.ceil(keys.length / 2);
  return [keys.slice(0, mid), keys.slice(mid)];
}

export type IssueExec = (keys: string[]) => Promise<{ ok: true; issues: Map<string, JiraIssue> } | { ok: false; kind: ConnErrorKind }>;
export interface ResolveResult { issues: Map<string, JiraIssue>; errors: Map<string, ConnErrorKind> }

/**
 * Run `exec` on the keys; on `bad-request` bisect until the offending key stands alone and mark it `not-found` (M3-R31).
 * Keys absent from a successful response are `not-found` too. Any other failure applies to every key of that call.
 */
export async function resolveInHalves(keys: string[], exec: IssueExec): Promise<ResolveResult> {
  const out: ResolveResult = { issues: new Map(), errors: new Map() };
  const run = async (ks: string[]): Promise<void> => {
    if (ks.length === 0) return;
    const r = await exec(ks);
    if (r.ok) {
      for (const k of ks) {
        const i = r.issues.get(k);
        if (i) out.issues.set(k, i); else out.errors.set(k, 'not-found');
      }
    } else if (r.kind === 'bad-request') {
      if (ks.length === 1) { out.errors.set(ks[0]!, 'not-found'); return; }
      const [a, b] = splitOnBadRequest(ks);
      await run(a);
      await run(b);
    } else {
      for (const k of ks) out.errors.set(k, r.kind);
    }
  };
  await run(keys);
  return out;
}

export function buildProjectKeysRequest(startAt = 0): ApiRequest {
  return { method: 'GET', path: '/rest/api/3/project/search', query: { maxResults: String(PROJECT_PAGE), startAt: String(startAt) } };
}

/** `next` is the startAt of the following page, absent on the last (or an empty) page. */
export function parseProjectKeys(body: unknown): { keys: string[]; next?: number } {
  const root = isObj(body) ? body : {};
  const keys: string[] = [];
  for (const v of Array.isArray(root.values) ? root.values : []) {
    const k = isObj(v) ? str(v.key) : undefined;
    if (k) keys.push(k);
  }
  const count = Array.isArray(root.values) ? root.values.length : 0;
  const startAt = typeof root.startAt === 'number' ? root.startAt : 0;
  return root.isLast === false && count > 0 ? { keys, next: startAt + count } : { keys };
}
