// Mock GitHub API for the M3 end-to-end tests (Task 18): one local HTTP server that is both the GitHub API
// (`apiBaseUrl` http://localhost:<port>) and the pull request pages the tabs open. Jira endpoints land with the Jira
// grouping test (M3-R85). The token is a dummy; nothing here logs request headers.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The dummy token the tests store for the github connection. The mock answers 401 to anything else. */
export const MOCK_TOKEN = 'ghp_e2eDummyToken0000000000000000000000';

export interface MockPr { state: 'OPEN' | 'CLOSED' | 'MERGED'; title: string; mergedAt?: string }

export interface MockServices {
  port: number;
  /** http://localhost:<port>: the github connection's apiBaseUrl and the origin of the PR pages. */
  origin: string;
  github: {
    /** `key` is 'owner/repo#number'. */
    setPr(key: string, info: MockPr): void;
    /** The next API request (any endpoint) answers `status` with `headers` instead. One-shot. */
    failNext(status: number, headers?: Record<string, string>): void;
    /** API requests received so far (/graphql and /user; page loads are not counted). */
    readonly requests: number;
  };
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The PR state query of src/core/sources/github.ts (buildPrStateQuery): `r<i>: repository(owner: $o<i>, name: $n<i>)`
 * blocks of `p<j>: pullRequest(number: $k<j>)`. Answers each alias from the PRs set with setPr (null when unknown).
 */
function answerPrQuery(query: string, variables: Record<string, unknown>, prs: Map<string, MockPr>): unknown {
  const data: Record<string, unknown> = {};
  let repo: { alias: string; key: string } | undefined;
  for (const m of query.matchAll(/(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\)|(p\d+): pullRequest\(number: \$(k\d+)\)/g)) {
    if (m[1]) {
      repo = { alias: m[1], key: `${String(variables[m[2]!])}/${String(variables[m[3]!])}` };
      data[repo.alias] = {};
      continue;
    }
    if (!repo) continue;
    const n = Number(variables[m[5]!]);
    const pr = prs.get(`${repo.key}#${n}`);
    (data[repo.alias] as Record<string, unknown>)[m[4]!] = pr
      ? {
          number: n, title: pr.title, url: `https://github.com/${repo.key}/pull/${n}`, state: pr.state,
          isDraft: false, merged: pr.state === 'MERGED', mergedAt: pr.mergedAt ?? null,
        }
      : null;
  }
  data.rateLimit = { cost: 1, remaining: 4999, limit: 5000, resetAt: new Date(Date.now() + 3_600_000).toISOString() };
  return { data };
}

export async function startMockServices(): Promise<MockServices> {
  const prs = new Map<string, MockPr>();
  const failures: { status: number; headers: Record<string, string> }[] = [];
  let requests = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/graphql' || url.pathname === '/user') {
      requests++;
      const fail = failures.shift();
      if (fail) {
        const message = fail.status === 401 ? 'Bad credentials' : fail.status === 403 ? 'You have exceeded a secondary rate limit.' : 'Error';
        json(fail.status, { message }, fail.headers);
        req.resume();
        return;
      }
      if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
        json(401, { message: 'Bad credentials' });
        req.resume();
        return;
      }
      if (url.pathname === '/user') {
        json(200, { login: 'e2e-user' });
        req.resume();
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { raw += c; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw) as { query?: unknown; variables?: unknown };
          json(200, answerPrQuery(String(body.query ?? ''), (body.variables ?? {}) as Record<string, unknown>, prs));
        } catch {
          json(400, { message: 'Problems parsing JSON' });
        }
      });
      return;
    }
    // Pages: /<owner>/<repo>/pull/<n> is titled like a real PR page; anything else after its path.
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.pathname);
    const pr = m ? prs.get(`${m[1]}/${m[2]}#${m[3]}`) : undefined;
    const title = m ? `${pr?.title ?? 'Pull request'} · Pull Request #${m[3]} · ${m[1]}/${m[2]}` : url.pathname;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${esc(title)}</title><p>tabchef e2e mock</p>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://localhost:${port}`,
    github: {
      setPr: (key, info) => { prs.set(key, info); },
      failNext: (status, headers = {}) => { failures.push({ status, headers }); },
      get requests() { return requests; },
    },
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
