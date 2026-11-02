import { FILTERS, type Tables } from '../lang/filters';

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export interface FilterCall { name: string; args: string[] }
export type TemplatePart = { lit: string } | { name: string; filters: FilterCall[] };
interface Parsed { parts: TemplatePart[]; error?: string }

const WORD = /\w/;

/**
 * Parse one `{name|filter:arg:arg|...}` token starting at `i` (which is '{'). Inside an argument a backslash
 * escapes the next character (`\:`, `\|`, `\}`, `\\`). Returns null if it is not a well-formed token.
 */
function parseToken(t: string, i: number): { part: TemplatePart; end: number } | null {
  let j = i + 1;
  const readWord = (): string => {
    const s = j;
    while (j < t.length && WORD.test(t[j] as string)) j++;
    return t.slice(s, j);
  };
  const name = readWord();
  if (!name) return null;
  const filters: FilterCall[] = [];
  while (t[j] === '|') {
    j++;
    const fname = readWord();
    if (!fname) return null;
    const args: string[] = [];
    while (t[j] === ':') {
      j++;
      let a = '';
      while (j < t.length && t[j] !== ':' && t[j] !== '|' && t[j] !== '}') {
        if (t[j] === '\\' && j + 1 < t.length) j++;
        a += t[j];
        j++;
      }
      args.push(a);
    }
    filters.push({ name: fname, args });
  }
  if (t[j] !== '}') return null;
  return { part: { name, filters }, end: j + 1 };
}

const cache = new Map<string, Parsed>();

function parse(t: string): Parsed {
  const hit = cache.get(t);
  if (hit) return hit;
  const parts: TemplatePart[] = [];
  let lit = '';
  let error: string | undefined;
  for (let i = 0; i < t.length; ) {
    const tok = t[i] === '{' ? parseToken(t, i) : null;
    if (!tok) { lit += t[i]; i++; continue; }
    if (lit) { parts.push({ lit }); lit = ''; }
    parts.push(tok.part);
    if ('filters' in tok.part) {
      for (const f of tok.part.filters) {
        const def = Object.prototype.hasOwnProperty.call(FILTERS, f.name) ? FILTERS[f.name] : undefined;
        if (!def) error ??= `unknown filter: ${f.name}`;
        else if (f.args.length !== def.arity) error ??= `filter ${f.name} takes ${def.arity} argument(s), got ${f.args.length}`;
      }
    }
    i = tok.end;
  }
  if (lit) parts.push({ lit });
  const out: Parsed = error ? { parts, error } : { parts };
  cache.set(t, out);
  return out;
}

/** Parse a template into literal and variable parts (cached). Throws TemplateError for an unknown filter or wrong argument count. */
export function parseTemplate(t: string): TemplatePart[] {
  const p = parse(t);
  if (p.error) throw new TemplateError(p.error);
  return p.parts;
}

/** Like parseTemplate but never throws: bad filters stay in the parts and are skipped when rendering. */
export function parseTemplateLenient(t: string): TemplatePart[] {
  return parse(t).parts;
}

/**
 * Renders `{name}` and `{name|filter:arg|...}`. Unknown vars render as ''. Never throws: a bad filter (which
 * validation rejects at save) is skipped and the value passes through unchanged.
 */
export function renderTemplate(t: string, vars: Record<string, string>, tables: Tables = {}): string {
  let out = '';
  for (const p of parseTemplateLenient(t)) {
    if ('lit' in p) { out += p.lit; continue; }
    let v = Object.prototype.hasOwnProperty.call(vars, p.name) ? (vars[p.name] ?? '') : '';
    for (const f of p.filters) {
      const def = Object.prototype.hasOwnProperty.call(FILTERS, f.name) ? FILTERS[f.name] : undefined;
      if (def && f.args.length === def.arity) v = def.apply(v, f.args, tables);
    }
    out += v;
  }
  return out;
}

/** Distinct variable names used by a template, in first-use order. */
export function templateVars(t: string): string[] {
  return [...new Set(parseTemplateLenient(t).flatMap((p) => ('name' in p ? [p.name] : [])))];
}

/** Table names referenced by `map:` filters. */
export function templateTables(t: string): string[] {
  return [...new Set(parseTemplateLenient(t).flatMap((p) => ('name' in p ? p.filters.filter((f) => f.name === 'map').map((f) => f.args[0] as string) : [])))];
}
