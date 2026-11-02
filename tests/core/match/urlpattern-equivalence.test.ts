// Equivalence oracle for R31: URL globs moved from a hand-rolled glob-to-regex translator onto URLPattern.
// `oldCompileGlob` below is a verbatim copy of the pre-R31 translator, kept here only as the oracle.
import { describe, it, expect } from 'vitest';
import raw from '../../../fixtures/auto-group-tabs.json?raw';
import { importAutoGroupTabs } from '../../../src/core/import/auto-group-tabs';
import { compilePattern } from '../../../src/core/match/pattern';

type OldMatcher = (url: string) => Record<string, string> | null;

// ---- begin pre-R31 copy (src/core/match/pattern.ts at bb7abf9) ----
function collect(groups: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (groups) for (const [k, v] of Object.entries(groups)) if (v !== undefined) out[k] = v;
  return out;
}
const HOST_PREFIX = '(?:[^/?#@]*\\.)?';
const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function translate(src: string, names: Set<string>): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === '*') out += '.*';
    else if (c === ':' && (i === 0 || src[i - 1] === '/')) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i + 1));
      if (m) {
        if (names.has(m[0])) throw new Error(`duplicate param: ${m[0]}`);
        names.add(m[0]);
        out += `(?<${m[0]}>[^/?#]+)`;
        i += m[0].length;
      } else out += ':';
    } else out += escapeRe(c);
  }
  return out;
}
function oldCompileGlob(p: string): OldMatcher {
  const names = new Set<string>();
  const sm = /^([A-Za-z*][A-Za-z0-9+.*-]*):\/\//.exec(p);
  let source: string;
  let explicit = false;
  if (sm) {
    explicit = true;
    const scheme = sm[1] === '*' ? 'https?' : escapeRe(sm[1] as string);
    let rest = p.slice(sm[0].length);
    let hostPre = '';
    if (rest.startsWith('*.')) {
      hostPre = HOST_PREFIX;
      rest = rest.slice(2);
    }
    source = `${scheme}://${hostPre}${translate(rest, names)}`;
  } else if (p.startsWith('*.')) {
    source = `${HOST_PREFIX}${translate(p.slice(2), names)}`;
  } else {
    source = translate(p, names);
  }
  const re = new RegExp(`^${source}$`, 'i');
  return (url) => {
    let target = url;
    if (!explicit) {
      const m = /^https?:\/\//i.exec(url);
      if (!m) return null;
      target = url.slice(m[0].length);
    }
    const m = re.exec(target);
    return m ? collect(m.groups) : null;
  };
}
// ---- end pre-R31 copy ----

// Chrome hands Tabchef canonical tab URLs (WHATWG serialization), so the corpus is canonical apart from letter case,
// which both matchers ignore. Equivalence is claimed over that domain.

/** Variants of one URL: deeper paths, query strings, fragments, uppercase, http vs https, subdomains, near-misses. */
function variants(base: string): string[] {
  const u = new URL(base);
  const host = u.host;
  const path = u.pathname;
  const out = new Set<string>();
  const paths = [path, path.replace(/\/$/, '') || '/', `${path}${path.endsWith('/') ? '' : '/'}deeper/x`, `${path}0`, `${path}-fork/pull/3`];
  const tails = ['', '?', '?q=1', '?q=a/b?c', '#', '#frag', '#a/b?c', '?q=1#frag', '?next=/x#/y'];
  const hosts = [host, host.toUpperCase(), `www.${host}`, `a.b.${host}`, `evil${host}`, `${host}.evil.com`, `${host}:8080`, `user@${host}`, `${host}@evil.com`, `user:pw@${host}`];
  for (const scheme of ['https', 'http', 'ftp'])
    for (const h of hosts)
      for (const p of paths)
        for (const t of tails) {
          const s = `${scheme}://${h}${p.startsWith('/') ? p : `/${p}`}${t}`;
          try {
            const href = new URL(s).href;
            out.add(href);
            if (scheme === 'https') out.add(href.toUpperCase());
          } catch { /* not a URL */ }
        }
  return [...out];
}

const EXTRA = [
  'https://github.com/', 'https://github.com/acme', 'https://github.com/acme/', 'https://github.com/acme/repo-1',
  'https://github.com/acme/repo-10/issues', 'https://github.com/acmecorp/x', 'https://github.com/ACME/REPO-2/pull/7',
  'https://evilgithub.com/acme/repo-1', 'https://github.com.evil.com/acme/repo-1', 'https://github.com@evil.com/',
  'https://console.cloud.google.com/', 'https://console.cloud.google.com/run?project=p', 'https://console.cloud.google.com.evil.com/',
  'https://evilconsole.cloud.google.com/x', 'https://cloud.google.com/console', 'http://console.cloud.google.com/home#section',
  'chrome://newtab/', 'about:blank', 'file:///home/x', '', 'not a url',
];

function corpusFor(patterns: string[]): string[] {
  const out = new Set<string>(EXTRA);
  for (const p of patterns) {
    const lit = p.replace(/^\*:\/\//, 'https://').replace(/^(?!\w[\w+.-]*:\/\/)/, 'https://').replace(/\*\./g, '').replace(/:[A-Za-z_]\w*/g, 'seg').replace(/\*/g, '');
    for (const base of [lit, lit.replace(/\?.*$/, '')]) {
      if (!URL.canParse(base)) continue;
      for (const v of variants(base)) out.add(v);
    }
  }
  return [...out];
}

describe('R31 equivalence: Auto-Group Tabs fixture', () => {
  it('routes the URL corpus identically under the old translator and the URLPattern matcher', async () => {
    const r = await importAutoGroupTabs(JSON.parse(raw));
    expect(r.rules.length).toBe(13);
    expect(r.warnings).toEqual([]);
    const patterns = r.rules.flatMap((x) => [x.match.url].flat());
    const corpus = corpusFor(patterns);
    expect(corpus.length).toBeGreaterThan(1000);
    const route = (fn: (p: string) => OldMatcher, url: string) => {
      const hits: string[] = [];
      for (const rule of r.rules) if ([rule.match.url].flat().some((p) => fn(p)(url))) hits.push(rule.id);
      return hits;
    };
    let matched = 0;
    const diffs: string[] = [];
    for (const url of corpus) {
      const old = route(oldCompileGlob, url);
      const now = route(compilePattern, url);
      if (old.join() !== now.join()) diffs.push(`${url}: old [${old}] new [${now}]`);
      if (old.length) matched++;
    }
    expect(diffs).toEqual([]);
    expect(matched).toBeGreaterThan(100); // the corpus exercises real matches, not just misses
    // every rule both matches and rejects something
    for (const rule of r.rules) {
      const p = [rule.match.url].flat()[0] as string;
      expect(corpus.some((u) => oldCompileGlob(p)(u)), p).toBe(true);
      expect(corpus.some((u) => !oldCompileGlob(p)(u)), p).toBe(true);
    }
  }, 60_000);
});

describe('R31 equivalence: synthetic patterns (match and captures)', () => {
  const PATTERNS = [
    'github.com/*', 'github.com/acme', 'github.com/:owner/:repo*', 'github.com/:owner/:repo', 'github.com/:org/:repo/*',
    '*.atlassian.net/browse/*', '*.example.com/*', 'https://*.example.com/*', 'https://github.com*', 'https://github.com/acme/api*',
    '*://github.com/*', 'https://console.cloud.google.com/*', 'cache.test/*', 'github.com/pulls?q=*', 'github.com/pulls?*',
    'github.com/*/pull/*', 'github.com/*/*/pull/:n', 'a.com/*/:id*', 'a.com/x#*', 'a.com/x?*#*', 'a.com/:x-*', 'localhost:3000/*',
    'localhost:3000*', 'localhost*', '*', '*/login*', '*://*/*', 'github.com*', 'http://github.com/*', 'a.com/*?*', 'a.com/*#*',
    'a.com/x?a=:b', 'a.com/:a/*/:b?c=*#*', 'meet.google.com/*-*-*', 'chrome://settings/*', 'file:///home/*',
    'localhost:*', 'CHROME://Settings/*', 'chrome://*', '*.Example.COM/*', 'Github.com/Acme/*', 'github.com', 'github.com?x',
    '/foo*', '123/*', 'a.com:0080/*', 'localhost:/x', 'Foo Bar!.example/*', '[::1]:8080/*', 'https:///.example/*', 'a!b.example/*', 'a.com/x?y?z*', 'a.com/x#y?z*', 'a.com/:p:q/*', 'a.com/:/*', 'a.com/%41*',
    // Port wildcard `host:*` + path (R36): a literal ':' after the host, then `*` runs on through the port into the path.
    'http://localhost:*/*callback*', 'http://127.0.0.1:*/*callback*', 'example.com:*/x', 'example.com:*/:seg/*', 'Example.COM:*/x?*',
  ];
  const base = [
    ...corpusFor(PATTERNS.filter((p) => !p.startsWith('chrome') && !p.startsWith('file') && !p.startsWith('*') && !p.startsWith('localhost'))),
    ...variants('http://localhost:3000/x'), ...variants('http://localhost/x'), ...variants('https://meet.google.com/abc-defg-hij'),
    'chrome://settings/privacy', 'chrome://settings/', 'chrome://newtab/', 'file:///home/me/a.txt', 'file:///etc/x',
    'https://a.com/x', 'https://a.com/x?', 'https://a.com/x#', 'https://a.com/x?#', 'https://a.com/x?y#z', 'https://a.com/p?r/s',
    'https://a.com/p-q-r', 'https://a.com/a/b/c?c=1#h', 'https://a.com/a/b?c=1', 'https://a.com/x?a=/v', 'https://a.com/x?a=v',
    'https://a.com/x?y?z', 'https://a.com/x#y?z1', 'https://a.com/pq:q/r', 'https://a.com/:/x', 'https://a.com/%41b', 'https://a.com/Ab',
    // Ports for R36: with and without a port, port-like userinfo (`host:pw@other`), and the path just after the port.
    ...variants('http://localhost:8080/auth/callback?code=x'), ...variants('http://127.0.0.1:5173/oauth/callback'),
    ...variants('https://example.com:8443/x'), ...variants('https://example.com/x'), ...variants('https://example.com:8443/a/x'),
    'http://localhost/callback', 'http://localhost:1/callback', 'http://localhost:8080/', 'http://localhost:8080/x/callbacks/y',
    'http://localhost:8080/?next=callback', 'http://localhost:8080/#callback', 'http://localhost:pw@evil.com/callback',
    'http://LOCALHOST:pw@evil.com:9/a/callback', 'http://localhost@evil.com/callback', 'http://localhostx:1/callback',
    'http://127.0.0.1:8080/callback', 'http://127.0.0.1:pw@evil.com/callback', 'http://127.0.0.10:80/callback',
    'https://example.com:1/x', 'https://example.com:1/x/', 'https://example.com:1/xx', 'https://example.com:1/a/x',
    'https://example.com:pw@evil.com/x', 'https://example.com:pw@evil.com:8/x', 'https://example.com:1/x?q', 'https://example.com:1/seg/x',
    'https://example.com.evil.com:1/x', 'https://www.example.com:1/x', 'ftp://example.com:21/x', 'http://example.com:8080/x',
    'http://[::1]:8080/x', 'http://0.0.0.123/x', 'https://a!b.example/x', 'http://a.com:80/x', 'http://localhost/x', 'https://www.example.com/x', 'https://u@www.example.com/x', 'chrome://settings', 'chrome://extensions/?id=x',
  ];
  const canon = (u: string) => (URL.canParse(u) ? new URL(u).href : u);
  const corpus = [...new Set([...base, ...base.map((u) => u.toUpperCase())].map(canon))];
  it.each(PATTERNS)('%s', (p) => {
    const oldM = oldCompileGlob(p);
    const newM = compilePattern(p);
    const show = (r: Record<string, string> | null) => JSON.stringify(r && Object.entries(r));
    const diffs = corpus.filter((u) => show(newM(u)) !== show(oldM(u))).map((u) => `${u}: old ${show(oldM(u))} new ${show(newM(u))}`);
    expect(diffs).toEqual([]);
  }, 60_000);
  it.each(PATTERNS.filter((p) => /:\*\//.test(p)))('port wildcard %s: the corpus has both matches and misses', (p) => {
    const m = compilePattern(p);
    expect(corpus.filter((u) => m(u)).length).toBeGreaterThan(3);
    expect(corpus.some((u) => !m(u))).toBe(true);
  });
});
