export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

export type Matcher = (url: string) => Record<string, string> | null;

const MAX_REGEX_LEN = 500;
const cache = new Map<string, Matcher>();

function collect(groups: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (groups) for (const [k, v] of Object.entries(groups)) if (v !== undefined) out[k] = v;
  return out;
}

function compileRegex(p: string): Matcher {
  const end = p.lastIndexOf('/');
  const body = p.slice(1, end);
  const flags = p.slice(end + 1).replace(/[gy]/g, '');
  if (p.length > MAX_REGEX_LEN) throw new PatternError('pattern too long');
  let re: RegExp;
  try {
    re = new RegExp(body, flags);
  } catch (e) {
    throw new PatternError(`invalid regex: ${(e as Error).message}`);
  }
  return (url) => {
    const m = re.exec(url);
    return m ? collect(m.groups) : null;
  };
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Translate glob/param source into regex source; `*` => `.*`, `:name` at a segment start => named group. */
function translate(src: string, names: Set<string>): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === '*') out += '.*';
    else if (c === ':' && (i === 0 || src[i - 1] === '/')) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i + 1));
      if (m) {
        if (names.has(m[0])) throw new PatternError(`duplicate param: ${m[0]}`);
        names.add(m[0]);
        out += `(?<${m[0]}>[^/?#]+)`;
        i += m[0].length;
      } else out += ':';
    } else out += escapeRe(c);
  }
  return out;
}

function compileGlob(p: string): Matcher {
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
      hostPre = '(?:.*\\.)?';
      rest = rest.slice(2);
    }
    source = `${scheme}://${hostPre}${translate(rest, names)}`;
  } else if (p.startsWith('*.')) {
    source = `(?:.*\\.)?${translate(p.slice(2), names)}`;
  } else {
    source = translate(p, names);
  }
  let re: RegExp;
  try {
    re = new RegExp(`^${source}$`, 'i');
  } catch (e) {
    throw new PatternError(`invalid pattern: ${(e as Error).message}`);
  }
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

/** Compile a glob, `/regex/flags`, or `:param` pattern. Cached per pattern string. */
export function compilePattern(p: string): Matcher {
  const hit = cache.get(p);
  if (hit) return hit;
  const isRegex = p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0;
  const fn = isRegex ? compileRegex(p) : compileGlob(p);
  cache.set(p, fn);
  return fn;
}
