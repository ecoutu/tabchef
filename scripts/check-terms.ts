// Wording guard: the store listing and the extension's own text must use the same words. Checks docs/store/*.md and
// the markup of every .svelte file (script and style blocks, {expressions} and component names are skipped) for: the
// product name spelled any other way, a reference to a page or view that doesn't exist ("under Dedupe" when the page
// is called Duplicates), the banned words in docs/store/terms.json, and store sections headed "(max N characters)"
// that run over. Page names come from OPTIONS_ROUTES; view names from the built-in recipes.
// Usage: npm run check:terms. Prints `file:line: message` per problem and exits 1 on any.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { OPTIONS_ROUTES } from '../src/ui/routes';

interface Terms { name: string; banned: { pattern: string; flags?: string; use: string; why?: string; where: 'store' | 'ui' | 'all' }[] }
interface Source { f: string; kind: 'store' | 'ui'; text: string }

const walk = (d: string, ext: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
});

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

/** The text of a .svelte file a user can read: script and style blocks and component tag names blanked, and inside
 * {expressions} only the string literals that read as prose (contain a space) kept: `help={"The group's name…"}` is
 * shown to users, while `{form.dedupe}` and `page === 'dedupe'` are code. Line breaks stay, so lines stay right. */
function markup(src: string): string {
  const text = src.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, blank).replace(/<\/?[A-Z][\w.]*/g, blank);
  let out = '';
  let depth = 0;
  let quote = '';
  let lit = '';
  for (const c of text) {
    if (depth === 0) {
      if (c === '{') depth = 1;
      out += c === '{' ? ' ' : c;
    } else if (quote) {
      if (c !== quote) { lit += c; continue; }
      out += ' ' + (/\s/.test(lit) ? lit : blank(lit)) + ' ';
      quote = '';
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
      lit = '';
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c === '\n' ? c : ' ';
    }
  }
  return out;
}

export default function main(): number {
  const terms = JSON.parse(readFileSync('docs/store/terms.json', 'utf8')) as Terms;
  const pages = new Set(OPTIONS_ROUTES.map((r) => r.label));
  for (const f of walk('src/recipes/builtin', '.yaml')) {
    const name = (parse(readFileSync(f, 'utf8')) as { name?: unknown }).name;
    if (typeof name === 'string') pages.add(name);
  }

  const sources: Source[] = [
    ...walk('docs/store', '.md').map((f) => ({ f, kind: 'store' as const, text: readFileSync(f, 'utf8') })),
    ...walk('src/entrypoints', '.svelte').map((f) => ({ f, kind: 'ui' as const, text: markup(readFileSync(f, 'utf8')) })),
  ];

  const problems: string[] = [];
  const report = (src: Source, index: number, msg: string) => {
    const line = src.text.slice(0, index).split('\n').length;
    problems.push(`${relative('.', src.f)}:${line}: ${msg}`);
  };

  const loose = new RegExp(terms.name.split('').join('[\\s_-]?'), 'gi');
  const PAGE_REF = /\b(?:on|under|in|from|to) the ([A-Z][\w ]*?) (?:page|view|tab)\b|\bunder ([A-Z]\w*)\b/g;
  for (const src of sources) {
    for (const m of src.text.matchAll(loose)) {
      if (m[0] !== terms.name && !/^[a-z]+$/.test(m[0])) report(src, m.index, `"${m[0]}": the name is spelled ${terms.name}`);
    }
    for (const m of src.text.matchAll(PAGE_REF)) {
      const name = m[1] ?? m[2] ?? '';
      if (!pages.has(name)) report(src, m.index, `"${m[0]}": no page or view is called ${name} (have: ${[...pages].join(', ')})`);
    }
    for (const b of terms.banned) {
      if (b.where !== 'all' && b.where !== src.kind) continue;
      for (const m of src.text.matchAll(new RegExp(b.pattern, `g${b.flags ?? ''}`))) {
        report(src, m.index, `"${m[0]}": use ${b.use}${b.why ? `. ${b.why}` : ''}`);
      }
    }
  }

  // A "## Heading (max N characters)" section is store text with a length limit: the text under it must fit.
  for (const src of sources.filter((s) => s.kind === 'store')) {
    for (const m of src.text.matchAll(/^## .*\(max (\d+) characters\)\n+([\s\S]*?)\n*(?=^## |(?![\s\S]))/gm)) {
      const text = (m[2] ?? '').trim();
      if (text.length > Number(m[1])) report(src, m.index, `${text.length} characters, the limit is ${m[1]}`);
    }
  }

  if (problems.length) {
    console.error(`check:terms: ${problems.length} wording problem(s)\n${problems.join('\n')}`);
    return 1;
  }
  console.log(`check:terms: ${sources.length} files use the same words (${pages.size} page and view names)`);
  return 0;
}
