import { slowRegexProblem } from './regex-safety';

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

export type Matcher = (url: string) => Record<string, string> | null;

/** Regex-safety cap: every user or recipe regex is at most this many characters. */
export const MAX_REGEX_LEN = 500;
/** Regex-safety cap on matched input: titles and URLs are truncated to this many characters before matching. */
export const MAX_MATCH_INPUT = 2048;
const cache = new Map<string, Matcher>();
const textCache = new Map<string, Matcher>();

function collect(groups: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (groups) for (const [k, v] of Object.entries(groups)) if (v !== undefined) out[k] = v;
  return out;
}

function compileRegex(p: string): Matcher {
  const end = p.lastIndexOf('/');
  const body = p.slice(1, end);
  const flags = p.slice(end + 1).replace(/[gy]/g, '');
  let re: RegExp;
  try {
    re = new RegExp(body, flags);
  } catch (e) {
    throw new PatternError(`invalid regex: ${(e as Error).message}`);
  }
  const slow = slowRegexProblem(body); // R67: a nested quantifier could hang the worker on a page-controlled title
  if (slow) throw new PatternError(slow);
  return (url) => {
    const m = re.exec(url);
    return m ? collect(m.groups) : null;
  };
}

// ---- URL globs on URLPattern (ruling R31) ----
// A glob is one string spanning host + path + query + fragment. It keeps the pre-R31 meaning exactly (on canonical
// URLs, which is what Chrome reports for tabs): `*` is any run of characters (it may cross `/ ? #`), `:name` at a
// segment start captures `[^/?#]+`, `*.host` is the host or any subdomain, no scheme means http(s), `*://` means
// http(s), and matching ignores case. The string is mapped onto URLPattern components; where a `*` may span a
// component boundary the glob becomes a small union of URLPatterns, one per placement of that boundary. Anything that
// cannot be mapped faithfully throws a PatternError instead of silently changing meaning.

type Tok = { k: 'lit'; c: string } | { k: 'star' } | { k: 'param'; name: string };
type Comp = 'protocol' | 'username' | 'password' | 'hostname' | 'port' | 'pathname' | 'search' | 'hash';
interface Branch { pattern: URLPattern; query?: boolean; hash?: boolean }

/** Upper bound on URLPatterns per glob (a glob with many `*` expands to one URLPattern per boundary placement). */
const MAX_BRANCHES = 256;
const PARAM_RE = '([^\\/?#]+)';
const STAR = '(.*)';

/** Escape fixed text for URLPattern syntax (every non-alphanumeric is escaped; `\x` is always fixed text). */
const escUP = (s: string) => s.replace(/[^A-Za-z0-9]/g, '\\$&');

/** Split glob source into tokens. `:name` is a param only at `atStart` or right after `/` (as before R31). */
function tokenize(src: string, names: Set<string>, atStart: boolean): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === '*') out.push({ k: 'star' });
    else if (c === ':' && ((i === 0 && atStart) || src[i - 1] === '/')) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i + 1));
      if (m) {
        if (names.has(m[0])) throw new PatternError(`duplicate param: ${m[0]}`);
        names.add(m[0]);
        out.push({ k: 'param', name: m[0] });
        i += m[0].length;
      } else out.push({ k: 'lit', c });
    } else out.push({ k: 'lit', c });
  }
  return out;
}

/** Fixed text must survive URLPattern's canonicalization unchanged (else the literal would mean something else). */
function checkCanonical(comp: Comp, text: string): void {
  if (!text) return;
  let canon: string;
  try {
    canon = new URLPattern({ [comp]: escUP(text) })[comp].replace(/\\(.)/g, '$1');
  } catch {
    canon = '';
  }
  if (canon.toLowerCase() !== text.toLowerCase()) throw new PatternError(`"${text}" is not in canonical URL form`);
}

/** Render tokens as one URLPattern component, checking each fixed-text run. */
function render(comp: Comp, toks: Tok[]): string {
  let out = '';
  let run = '';
  const flush = () => {
    checkCanonical(comp, run);
    out += escUP(run);
    run = '';
  };
  for (const t of toks) {
    // Chrome drops a leading `?` from fixed text in search, so a literal `?` there is emitted as a regex group.
    if (t.k === 'lit' && t.c === '?' && comp === 'search') {
      flush();
      out += '(\\?)';
    } else if (t.k === 'lit') run += t.c;
    else {
      flush();
      out += t.k === 'star' ? STAR : `:${t.name}${PARAM_RE}`;
    }
  }
  flush();
  return out;
}

type Auth = Pick<Record<Comp, string>, 'username' | 'password' | 'hostname' | 'port'>;
const ANY_AUTH: Auth = { username: '*', password: '*', hostname: '*', port: '*' };
const HOST_CHARS = /^[A-Za-z0-9._-]+$/;

/**
 * Case-insensitive regex group for host-ish text ([A-Za-z0-9._-] only). URLPattern's ignoreCase covers only pathname,
 * search and hash, while non-special schemes (chrome://) keep the host's case and userinfo is never lowercased.
 */
const ciGroup = (text: string, tail = '') =>
  `(${text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&').replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)}${tail})`;

/** Split `host[:port]` (IPv6 `[...]` hosts keep their colons). */
function splitHostPort(a: string): { host: string; port?: string } {
  const m = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/s.exec(a) as RegExpExecArray;
  return { host: m[1] as string, port: m[2] };
}

/** `host[:port]` for a host that a `*` extends: plain DNS-ish text only, in canonical form, else fail closed. */
function hostPort(a: string): { host: string; port?: string } {
  const { host, port } = splitHostPort(a);
  if (!HOST_CHARS.test(host)) throw new PatternError(`unsupported host in URL glob: "${a}"`);
  checkCanonical('hostname', host);
  if (port !== undefined) {
    if (!/^\d*$/.test(port)) throw new PatternError(`unsupported port in URL glob host: "${a}"`);
    checkCanonical('port', port);
  }
  return { host, port };
}

/**
 * An exact `host[:port]`, or null when no canonical URL of `scheme` can have it (e.g. `123` is `0.0.0.123`, `:0080` is
 * `:80`, a space is invalid). Such globs never matched before R31 either, so they compile to a matcher that never
 * matches instead of failing.
 */
function exactHostPort(a: string, scheme: string): { host: string; port?: string } | null {
  const { host, port } = splitHostPort(a);
  if (port !== undefined && !/^\d+$/.test(port)) return null;
  let u: URL;
  try {
    u = new URL(`${scheme}://${host}${port !== undefined ? `:${port}` : ''}/`);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== host.toLowerCase() || u.port !== (port ?? '')) return null;
  return { host, port };
}

/**
 * Every placement of the path|query (b1) and query|fragment (b2) boundaries over the tokens of the part of the glob
 * after the host. A boundary sits on the first literal `?` / `#`, inside a `*`, or nowhere (the component is absent).
 * Ordered so the first matching branch reproduces the old regex's leftmost-greedy captures.
 */
function pathBranches(toks: Tok[]): { pathname: string; search: string; hash: string; query: boolean; frag: boolean }[] {
  const firstLit = (c: string) => {
    const i = toks.findIndex((t) => t.k === 'lit' && t.c === c);
    return i < 0 ? Infinity : i;
  };
  const q = firstLit('?');
  const h = firstLit('#');
  const stars = toks.flatMap((t, i) => (t.k === 'star' ? [i] : []));
  type Cut = { at: number; star: boolean } | null; // null: boundary absent
  const b1s: Cut[] = [...stars.filter((i) => i < Math.min(q, h)).map((at) => ({ at, star: true })), ...(q < h ? [{ at: q, star: false }] : []), null];
  const out: ReturnType<typeof pathBranches> = [];
  for (const b1 of b1s) {
    const from = b1 ? b1.at : -1;
    const b2s: Cut[] = [
      ...stars.filter((i) => i < h && (b1 ? (b1.star ? i >= from : i > from) : true)).map((at) => ({ at, star: true })),
      ...(h < Infinity && h > from ? [{ at: h, star: false }] : []),
      ...(h === Infinity ? [null] : []),
    ];
    for (const b2 of b2s) {
      const end2 = b2 ? b2.at : toks.length;
      const end1 = b1 ? b1.at : end2;
      // A literal `?` can't sit in the path (the first `?` before `#` starts the query).
      if (toks.slice(0, end1).some((t) => t.k === 'lit' && t.c === '?')) continue;
      const cut = (c: Cut, s: number, e: number) => toks.slice(s, e).concat(c?.star ? [{ k: 'star' }] : []);
      const pathToks = cut(b1 ?? b2, 0, end1);
      const queryToks = b1 ? cut(b2, b1.star ? b1.at : b1.at + 1, end2) : [];
      const hashToks = b2 ? toks.slice(b2.star ? b2.at : b2.at + 1) : [];
      out.push({
        pathname: render('pathname', b1 || b2 ? pathToks : toks),
        search: b1 ? render('search', queryToks) : '',
        hash: b2 ? render('hash', hashToks) : '',
        query: b1 !== null,
        frag: b2 !== null,
      });
      if (out.length > MAX_BRANCHES) throw new PatternError('URL glob has too many wildcards');
    }
  }
  return out;
}

function compileGlob(p: string): Matcher {
  if (/[(){}]/.test(p)) throw new PatternError('URL globs do not support ( ) or { } groups; use a /regex/ pattern');
  const names = new Set<string>();
  const sm = /^([A-Za-z*][A-Za-z0-9+.*-]*):\/\//.exec(p);
  let protocol = 'http{s}?';
  let rest = p;
  if (sm) {
    const scheme = sm[1] as string;
    if (scheme.includes('*') && scheme !== '*') throw new PatternError(`unsupported scheme in URL glob: "${scheme}" (use * or a literal scheme)`);
    if (scheme !== '*') protocol = escUP(scheme.toLowerCase());
    rest = p.slice(sm[0].length);
  }
  const prefix = rest.startsWith('*.');
  if (prefix) rest = rest.slice(2);
  const di = rest.search(/[/?#]/);
  const a = di < 0 ? rest : rest.slice(0, di);
  const tail = di < 0 ? '' : rest.slice(di);
  if (a.startsWith(':') && /^:[A-Za-z_]/.test(a)) throw new PatternError('URL glob params are not supported in the host');
  if (a.includes('@')) throw new PatternError('URL glob host must not contain userinfo (@)');

  let auths: Auth[];
  let toks: Tok[] | null; // null: everything after the host is unconstrained
  if (a === '*' && !prefix) {
    auths = [ANY_AUTH];
    // `*` + rest: the `*` covers the whole host (rest starts with / ? or #) and runs on into the path.
    toks = tail ? [{ k: 'star' }, ...tokenize(tail, names, false)] : null;
  } else if (a.endsWith('*') && a.indexOf('*') === a.length - 1 && !tail && !prefix) {
    // `host*`: the trailing `*` may run on through port, path, query and fragment, or the literal may be userinfo.
    const { host, port } = hostPort(a.slice(0, -1));
    const more = (s: string) => escUP(s) + (s ? STAR : '(.+)');
    auths = port === undefined
      ? [{ username: '', password: '', hostname: ciGroup(host, '.*'), port: '*' }, { username: ciGroup(host, '.*'), password: '*', hostname: '*', port: '*' }]
      : [{ username: '', password: '', hostname: ciGroup(host), port: more(port) }, { username: ciGroup(host), password: more(port), hostname: '*', port: '*' }];
    toks = null;
  } else if (a.endsWith(':*') && a.indexOf('*') === a.length - 1 && tail && !prefix) {
    // Port wildcard `host:*` + path (R36): a literal ':' after the host, then a `*` that may run on into the path. On a
    // canonical URL the text after `host:` is a non-empty port (a default port is dropped, so `host/` has no ':'), or
    // the literal is userinfo `host:password@` (a non-empty password; `/ ? #` are percent-encoded there). Either way
    // the tail starts in the path, so the `*` becomes a leading path `*` after any port, as for a bare `*` host.
    const { host, port } = hostPort(a.slice(0, -2));
    if (port !== undefined) throw new PatternError(`unsupported port in URL glob host: "${a}"`);
    auths = [
      { username: '', password: '', hostname: ciGroup(host), port: '(.+)' },
      { username: ciGroup(host), password: '(.+)', hostname: '*', port: '*' },
    ];
    toks = [{ k: 'star' }, ...tokenize(tail, names, false)];
  } else if (a.includes('*')) {
    throw new PatternError(`a * in a URL glob host can only end the pattern or be the whole host: "${a}"`);
  } else {
    // An empty host, an empty path or a path not starting with / is kept as written: it matches only the URLs that
    // really have that shape (e.g. none for http(s)), exactly as before.
    let hp: { host: string; port?: string } | null = { host: '' };
    if (prefix) {
      hp = hostPort(a);
      if (hp.port === '') hp = null;
    } else if (a) hp = exactHostPort(a, sm && sm[1] !== '*' ? (sm[1] as string).toLowerCase() : 'https');
    toks = tokenize(tail, names, false);
    if (!hp) return () => null;
    auths = [{ username: '', password: '', hostname: (prefix ? '{(.*)\\.}?' : '') + (hp.host ? ciGroup(hp.host) : ''), port: hp.port ?? '' }];
  }

  const rests = toks ? pathBranches(toks) : [{ pathname: '*', search: '*', hash: '*', query: undefined, frag: undefined }];
  if (auths.length * rests.length > MAX_BRANCHES) throw new PatternError('URL glob has too many wildcards');
  const branches: Branch[] = [];
  for (const au of auths)
    for (const r of rests) {
      let pattern: URLPattern;
      try {
        pattern = new URLPattern({ protocol, ...au, pathname: r.pathname, search: r.search, hash: r.hash }, { ignoreCase: true });
      } catch (e) {
        throw new PatternError(`invalid pattern: ${(e as Error).message}`);
      }
      branches.push({ pattern, query: r.query, hash: r.frag });
    }
  return (url) => {
    try {
      new URL(url);
    } catch {
      return null;
    }
    const hi = url.indexOf('#');
    const hasHash = hi >= 0;
    const hasQuery = (hasHash ? url.slice(0, hi) : url).includes('?');
    for (const b of branches) {
      if ((b.query !== undefined && b.query !== hasQuery) || (b.hash !== undefined && b.hash !== hasHash)) continue;
      if (!b.pattern.test(url)) continue; // test() is much cheaper than exec(); exec only when there is something to capture
      const out: Record<string, string> = {};
      if (!names.size) return out;
      const r = b.pattern.exec(url);
      if (!r) continue;
      for (const k of names) {
        const v = r.pathname.groups[k] ?? r.search.groups[k] ?? r.hash.groups[k];
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    return null;
  };
}

/** Param names of a glob (same tokenization as compileGlob). */
function globParams(p: string): Set<string> {
  const names = new Set<string>();
  const sm = /^([A-Za-z*][A-Za-z0-9+.*-]*):\/\//.exec(p);
  let rest = sm ? p.slice(sm[0].length) : p;
  if (rest.startsWith('*.')) rest = rest.slice(2);
  const di = rest.search(/[/?#]/);
  if (di >= 0) tokenize(rest.slice(di), names, false);
  return names;
}

/** Compile a glob, `/regex/flags`, or `:param` pattern. Cached per pattern string. Input is truncated to MAX_MATCH_INPUT. */
export function compilePattern(p: string): Matcher {
  const hit = cache.get(p);
  if (hit) return hit;
  if (p.length > MAX_REGEX_LEN) throw new PatternError('pattern too long');
  const isRegex = p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0;
  const inner = isRegex ? compileRegex(p) : compileGlob(p);
  const fn: Matcher = (url) => inner(url.slice(0, MAX_MATCH_INPUT));
  cache.set(p, fn);
  return fn;
}

/**
 * Linear-time anchored wildcard match (`*` = any run of characters), case-insensitive, no captures. Literal segments
 * are matched leftmost-first with indexOf, which is exact for globs and never backtracks (ReDoS-safe).
 */
function compileWildcard(p: string): Matcher {
  const segs = p.toLowerCase().split('*');
  const first = segs[0] as string;
  if (segs.length === 1) return (s) => (s.toLowerCase() === first ? {} : null);
  const last = segs[segs.length - 1] as string;
  const mid = segs.slice(1, -1).filter((x) => x !== '');
  return (input) => {
    const s = input.toLowerCase();
    if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return null;
    let at = first.length;
    const end = s.length - last.length;
    for (const m of mid) {
      const i = s.indexOf(m, at);
      if (i < 0 || i + m.length > end) return null;
      at = i + m.length;
    }
    return {};
  };
}

/** Whether `url` matches pattern `p`; a pattern that does not compile is a non-match, never a throw. */
export function matchesPattern(p: string, url: string): boolean {
  try {
    return compilePattern(p)(url) !== null;
  } catch {
    return false;
  }
}

/**
 * Compile a title pattern (R6): a glob where `*` is `.*`, anchored and case-insensitive, with no scheme or host
 * handling and no `:param`s (use a regex named group), or `/regex/flags` as in compilePattern. Cached per pattern.
 * Input longer than MAX_MATCH_INPUT is truncated before matching.
 */
export function compileTextPattern(p: string): Matcher {
  const hit = textCache.get(p);
  if (hit) return hit;
  if (p.length > MAX_REGEX_LEN) throw new PatternError('pattern too long');
  const isRegex = p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0;
  const inner = isRegex ? compileRegex(p) : compileWildcard(p);
  const fn: Matcher = (s) => inner(s.slice(0, MAX_MATCH_INPUT));
  textCache.set(p, fn);
  return fn;
}

/**
 * Variable names a pattern can capture (`:param`s or regex named groups), or null if the pattern does not compile.
 * Regex groups inside an optional part may still be missing at match time.
 */
export function patternCaptures(p: string): Set<string> | null {
  try {
    compilePattern(p);
  } catch (e) {
    if (e instanceof PatternError) return null;
    throw e;
  }
  const isRegex = p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0;
  if (isRegex) return new Set([...p.slice(1, p.lastIndexOf('/')).matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((m) => m[1] as string));
  return globParams(p);
}
