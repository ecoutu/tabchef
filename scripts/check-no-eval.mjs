// MV3 CSP guard: fail if built extension JS contains eval / new Function.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.output/chrome-mv3';
const bad = [/\bnew Function\s*\(/, /\beval\s*\(/];
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(dir);

let failed = false;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const re of bad) {
    if (re.test(src)) { console.error(`${f}: matches ${re}`); failed = true; }
  }
}
console.log(`scanned ${files.length} js files in ${dir}`);
process.exit(failed ? 1 : 0);
