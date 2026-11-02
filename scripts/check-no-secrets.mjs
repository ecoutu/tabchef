// Secrets guard: fail if the source or built bundle contains client secrets, token literals, the e2e localhost flag
// switched on, or connection-secret keys inside content scripts. Usage: node scripts/check-no-secrets.mjs [dir...]
// (default: src .output/chrome-mv3). Tests and fixtures are skipped. Do NOT run against the WXT_E2E_LOCALHOST=1 build.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Mirror of TOKEN_PATTERN in src/core/connections/redact.ts (minus the g flag); tests/scripts pins them equal (M3-R87).
// The regex's own source text never matches it (the bracket class and `)` break the literal prefixes).
const TOKEN_PATTERN = /(gh[oprsu]_|github_pat_)[A-Za-z0-9_]{10,}|ATATT[A-Za-z0-9_\-=]{10,}/;
const CHECKS = [
  { name: 'client_secret', re: /client_secret/ },
  { name: 'token literal', re: TOKEN_PATTERN },
  // Content scripts are identified by their absolute path, so `.output/chrome-mv3/content-scripts` works as a root too (M3-R93).
  { name: 'connection secret key in a content script', re: /conn\.(secret|access)\./, only: (abs) => abs.split(sep).includes('content-scripts') },
];
const EXT = /\.(js|mjs|cjs|ts|tsx|svelte|json|html|css)$/;
const SKIP_DIR = new Set(['tests', 'fixtures', '__tests__', 'node_modules']);
// WXT_E2E_LOCALHOST === '1' is inlined by the bundler as allowLocalhost:!0 (production: !1). A built output dir (it has a
// top-level background.js) must contain the property (positive control) and every occurrence must be the production literal.
const FLAG = /allowLocalhost\s*:\s*([^,}\s;)]*)/g;
const PROD_FLAG = new Set(['!1', 'false']);
const isTest = (n) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(n);

const roots = process.argv.length > 2 ? process.argv.slice(2) : ['src', '.output/chrome-mv3'];
let failed = false;
let scanned = 0;
for (const root of roots) {
  if (!existsSync(root)) { console.error(`${root}: not found`); failed = true; continue; }
  const built = existsSync(join(root, 'background.js'));
  if (built && !FLAG.test(readFileSync(join(root, 'background.js'), 'utf8'))) {
    console.error(`${root}/background.js: e2e flag not found (allowLocalhost property missing; the guard cannot tell if it is off)`);
    failed = true;
  }
  FLAG.lastIndex = 0;
  const files = [];
  // Test/fixture dirs are skipped under src only, never inside a built bundle (M3-R93).
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (built || !SKIP_DIR.has(n)) walk(p); }
      else if (EXT.test(n) && (built || !isTest(n))) files.push(p);
    }
  })(root);
  for (const f of files) {
    scanned++;
    const src = readFileSync(f, 'utf8');
    const abs = resolve(f);
    for (const { name, re, only } of CHECKS) {
      if ((!only || only(abs)) && re.test(src)) { console.error(`${f}: ${name} (${re})`); failed = true; }
    }
    if (built) {
      for (const m of src.matchAll(FLAG)) {
        if (!PROD_FLAG.has(m[1])) { console.error(`${f}: e2e localhost flag not off: allowLocalhost:${m[1]}`); failed = true; }
      }
    }
  }
}
console.log(`scanned ${scanned} files in ${roots.join(', ')}`);
process.exit(failed ? 1 : 0);
