// URL-pattern suggestions for a page (M2 T16, the context menu's pre-filled rules): globs from most specific to
// broadest, with no scheme, query or fragment (a glob with no scheme means http(s)).

/** Second-level labels under a two-letter country TLD that are public suffixes in practice (co.uk, com.au, ...). */
const CC_SECOND = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go']);
/** An id-like path segment (a number, or a long hex / uuid): a folder ending in one is one item, not a section. */
const ID_SEG = /^(\d+|[0-9a-f-]{16,})$/i;
/** Segments the glob syntax would read as syntax (`*`, `:param` at a segment start): no candidate reaches past one. */
const UNSAFE_SEG = /\*|^:/;

/** The registrable-ish domain of `hostname` (last two labels; three under co.uk-like suffixes), or null for IPs. */
function registrable(hostname: string): string | null {
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith('[')) return null;
  const labels = hostname.split('.');
  const tld = labels.at(-1) ?? '';
  const n = tld.length === 2 && labels.length >= 3 && CC_SECOND.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-n).join('.');
}

/**
 * Candidate URL globs for `url`, most specific first. Path candidates are the folders above the page itself (the last
 * segment), skipping folders that end in an id-like segment; then `<host>/*`; then `*.<registrable domain>/*` when the
 * host has more labels than that domain. Non-web URLs (chrome://, file:, ...) give none.
 */
export function suggestPatterns(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '') return [];
  const host = u.host.toLowerCase();
  const segs = u.pathname.split('/').filter((s) => s !== '');
  const out: string[] = [];
  const unsafe = segs.findIndex((s) => UNSAFE_SEG.test(s));
  const maxLen = Math.min(segs.length - 1, unsafe < 0 ? Infinity : unsafe);
  for (let n = maxLen; n >= 1; n--) {
    if (ID_SEG.test(segs[n - 1]!)) continue;
    out.push(`${host}/${segs.slice(0, n).join('/')}/*`);
  }
  out.push(`${host}/*`);
  const reg = registrable(u.hostname.toLowerCase());
  if (reg !== null && reg !== u.hostname.toLowerCase()) out.push(`*.${reg}${u.port ? `:${u.port}` : ''}/*`);
  return out;
}
