const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks)(?:\/.*)?)?\/?$/;

/** Maps github.com PR sub-pages (files/commits/checks) to the PR root. Query is untouched. */
function githubPr(u: URL): URL {
  if (u.hostname !== 'github.com') return u;
  const m = PR_PATH.exec(u.pathname);
  if (!m) return u;
  const out = new URL(u.href);
  out.pathname = `/${m[1]}/${m[2]}/pull/${m[3]}`;
  return out;
}

export const canonicalizers: Record<string, (u: URL) => URL> = { githubPr };
