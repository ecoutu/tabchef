// Static check for catastrophic-backtracking regexes (ruling R67). Titles are page-controlled, so a rule regex like
// `(a+)+$` would let a page hang the service worker. This is a heuristic, not a proof: it flags
//   - a group under an unbounded quantifier (`*`, `+`, `{n,}`) whose body itself contains an unbounded quantifier,
//     e.g. `(a+)+`, `(a*)*`, `(?:a+)*`, `((a+)b)+`;
//   - a group under an unbounded quantifier whose literal alternatives overlap by repetition, e.g. `(a|aa)+`, `(x|x)+`.
// It may reject some safe regexes (`(ab+)+`, `(?:[^/]+/)+`); it never needs to accept every safe one. Escapes and
// character classes are skipped as single atoms, so `(\+)+` and `([+])+` pass, and bounded `{n,m}` inner quantifiers
// are allowed.

export const SLOW_REGEX_MSG = 'regex may be too slow (nested quantifier)';

interface Frame {
  /** The body contains an unbounded quantifier (at any depth). */
  unbounded: boolean;
  /** Start of the current alternative in the source. */
  altStart: number;
  /** Source text of the finished alternatives. */
  alts: string[];
}

const QUANT = /^(?:[*+?]|\{(\d+)(,(\d*))?\})/;
const PLAIN = /^[^\\[\]().*+?{}|^$]+$/;

/** At `i` (just after an atom): the quantifier there, if any: its length and whether it is unbounded. */
function quantifierAt(src: string, i: number): { len: number; unbounded: boolean } | undefined {
  const m = QUANT.exec(src.slice(i, i + 24));
  if (!m) return undefined;
  const q = m[0];
  const unbounded = q === '*' || q === '+' || (m[2] !== undefined && m[3] === '');
  const lazy = src[i + q.length] === '?' ? 1 : 0;
  return { len: q.length + lazy, unbounded };
}

/** Index just past the escape that starts at `i` (`src[i]` is a backslash). */
function skipEscape(src: string, i: number): number {
  const c = src[i + 1];
  if ((c === 'u' || c === 'p' || c === 'P') && src[i + 2] === '{') {
    const end = src.indexOf('}', i + 3);
    return end < 0 ? src.length : end + 1;
  }
  return i + 2;
}

/** Index just past the character class that starts at `i` (`src[i]` is `[`). */
function skipClass(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') j = skipEscape(src, j);
    else if (src[j] === ']') return j + 1;
    else j++;
  }
  return j;
}

/** Literal alternatives where one is another repeated (`a|aa`, `x|x`): the group can match one string many ways. */
function overlappingAlternatives(alts: string[]): boolean {
  const lit = alts.filter((a) => PLAIN.test(a));
  for (let x = 0; x < lit.length; x++) {
    for (let y = 0; y < lit.length; y++) {
      if (x === y) continue;
      const a = lit[x] as string;
      const b = lit[y] as string;
      if (b.length % a.length === 0 && b === a.repeat(b.length / a.length) && (b.length > a.length || x < y)) return true;
    }
  }
  return false;
}

/** SLOW_REGEX_MSG when `source` has a nested unbounded quantifier (see the file header), else undefined. */
export function slowRegexProblem(source: string): string | undefined {
  const stack: Frame[] = [{ unbounded: false, altStart: 0, alts: [] }];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const top = stack[stack.length - 1] as Frame;
    if (c === '(') {
      let j = i + 1;
      if (source[j] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        if (source[j + 1] === '<' && source[j + 2] !== '=' && source[j + 2] !== '!') {
          const end = source.indexOf('>', j);
          j = end < 0 ? source.length : end + 1;
        } else j += source[j + 1] === '<' ? 3 : 2;
      }
      stack.push({ unbounded: false, altStart: j, alts: [] });
      i = j;
      continue;
    }
    if (c === ')' && stack.length > 1) {
      const g = stack.pop() as Frame;
      g.alts.push(source.slice(g.altStart, i));
      const q = quantifierAt(source, i + 1);
      if (q?.unbounded && (g.unbounded || (g.alts.length > 1 && overlappingAlternatives(g.alts)))) return SLOW_REGEX_MSG;
      const parent = stack[stack.length - 1] as Frame;
      parent.unbounded ||= g.unbounded || q?.unbounded === true;
      i += 1 + (q?.len ?? 0);
      continue;
    }
    if (c === '|') {
      top.alts.push(source.slice(top.altStart, i));
      top.altStart = i + 1;
      i++;
      continue;
    }
    // An atom: an escape, a class, or one character.
    const next = c === '\\' ? skipEscape(source, i) : c === '[' ? skipClass(source, i) : i + 1;
    const q = quantifierAt(source, next);
    if (q?.unbounded) top.unbounded = true;
    i = next + (q?.len ?? 0);
  }
  return undefined;
}
