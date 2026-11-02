// Import-cycle guard: fail if src/ has a cycle of runtime imports. Type-only imports (`import type`, `export type`)
// are erased at build time and ignored; `import { type A, b }` still counts (b is a runtime import).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.argv[2] ?? 'src');
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|svelte)$/.test(p) && !p.endsWith('.d.ts')) files.push(p);
  }
})(root);

/** A relative specifier as the bundler resolves it: the file, +.ts, /index.ts, or a NodeNext-style ./x.js naming x.ts. */
function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(from), spec);
  const candidates = [base, `${base}.ts`, join(base, 'index.ts')];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return undefined;
}

/**
 * The runtime import specifiers of a module, read from its TypeScript AST (comments, strings and regex literals are
 * the parser's problem): import declarations (not `import type`), re-exports with a source (not `export type`) and
 * `import('…')` calls with a literal argument. `import { type A, b }` still counts; `import('…').T` types do not.
 */
function runtimeSpecs(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out = [];
  const literal = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) {
      if (!n.importClause?.isTypeOnly) out.push(literal(n.moduleSpecifier));
    } else if (ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && !n.isTypeOnly) out.push(literal(n.moduleSpecifier));
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push(literal(n.arguments[0]));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.filter((x) => x !== undefined);
}

const graph = new Map();
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  if (f.endsWith('.svelte')) src = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const deps = new Set();
  for (const spec of runtimeSpecs(f, src)) {
    const to = resolveSpec(f, spec);
    if (to && /\.(ts|svelte)$/.test(to)) deps.add(to);
  }
  graph.set(f, deps);
}

// Tarjan's strongly connected components: any component with more than one module (or a self-import) is a cycle.
let index = 0;
const idx = new Map(); const low = new Map(); const stack = []; const on = new Set(); const cycles = [];
function connect(v) {
  idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1 || graph.get(v)?.has(v)) cycles.push(comp);
  }
}
for (const v of graph.keys()) if (!idx.has(v)) connect(v);

for (const c of cycles) console.error(`import cycle: ${c.map((f) => relative(process.cwd(), f)).sort().join(' <-> ')}`);
console.log(`scanned ${files.length} modules in ${relative(process.cwd(), root) || '.'}`);
process.exit(cycles.length ? 1 : 0);
