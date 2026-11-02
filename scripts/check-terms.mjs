// Wording guard: the store listing and the extension's own text must use the same words. Checks docs/store/*.md and
// the markup of every .svelte file (script and style blocks are skipped) for: the product name spelled any other way,
// a reference to a page or view that doesn't exist ("under Dedupe" when the page is called Duplicates), the banned
// words in docs/store/terms.json, and store sections headed "(max N characters)" that run over. Page names come from
// the options routes; view names from the built-in recipes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const terms = JSON.parse(readFileSync('docs/store/terms.json', 'utf8'));
const walk = (d, ext) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
});

const pages = new Set([...readFileSync('src/entrypoints/options/App.svelte', 'utf8').matchAll(/label: '([^']+)'/g)].map((m) => m[1]));
for (const f of walk('src/recipes/builtin', '.yaml')) {
  const m = /^name: (.+)$/m.exec(readFileSync(f, 'utf8'));
  if (m) pages.add(m[1].trim());
}

const sources = [
  ...walk('docs/store', '.md').map((f) => ({ f, kind: 'store', text: readFileSync(f, 'utf8') })),
  ...walk('src/entrypoints', '.svelte').map((f) => ({
    f, kind: 'ui', text: readFileSync(f, 'utf8').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, (s) => s.replace(/[^\n]/g, ' ')),
  })),
];

const problems = [];
const report = (src, index, msg) => {
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
    const name = m[1] ?? m[2];
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
    const text = m[2].trim();
    if (text.length > Number(m[1])) report(src, m.index, `${text.length} characters, the limit is ${m[1]}`);
  }
}

if (problems.length) {
  console.error(`check:terms: ${problems.length} wording problem(s)\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`check:terms: ${sources.length} files use the same words (${pages.size} page and view names)`);
