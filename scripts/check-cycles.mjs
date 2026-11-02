// Import-cycle guard: fail if src/ has a cycle of runtime imports. Type-only imports (`import type`, `export type`)
// are erased at build time and ignored; `import { type A, b }` still counts (b is a runtime import).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'src');
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|svelte)$/.test(p) && !p.endsWith('.d.ts')) files.push(p);
  }
})(root);

const SPEC = /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return undefined;
}

const graph = new Map();
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  if (f.endsWith('.svelte')) src = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const deps = new Set();
  for (const m of src.matchAll(SPEC)) {
    if (m[2]) continue; // import type / export type
    const to = resolveSpec(f, m[3] ?? m[4]);
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
