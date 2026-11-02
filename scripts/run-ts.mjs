// Runs a TypeScript script under src/'s module resolution (extensionless imports, JSON imports), through Vite's
// module runner: no extra dependency (D32). Usage: node scripts/run-ts.mjs <script.ts> [args...]
// The script's default export is `main(args: string[]): number | Promise<number>`, whose result is the exit code.
import { runnerImport } from 'vite';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/run-ts.mjs <script.ts> [args...]');
  process.exit(2);
}
const { module } = await runnerImport(script, { configFile: false, logLevel: 'error' });
process.exit(await module.default(args));
