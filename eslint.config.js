import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

// Layering: core is pure; engine/storage/platform/recipes may use core but never the UI or entrypoints.
const UPWARD = { group: ['**/ui', '**/ui/**', '**/entrypoints', '**/entrypoints/**'], message: 'Lower layers must not import ui/ or entrypoints/.' };
const FROM_CORE = { group: ['**/engine', '**/engine/**', '**/storage', '**/storage/**', '**/platform', '**/platform/**', '**/recipes', '**/recipes/**'], message: 'core/ must not import engine/, storage/, platform/ or recipes/.' };
// no-restricted-imports sees only static imports: the same layers for `import('…')` and `import('…').T` types. A
// specifier matches when one of its path segments is the layer (as the globs above); `\x2F` is "/" (esquery regex).
const segment = (dirs) => `/(^|\\x2F)(${dirs.join('|')})(\\x2F|$)/`;
const dynamicImports = ({ dirs, message }) => [
  { selector: `ImportExpression[source.value=${segment(dirs)}]`, message },
  // A template-literal specifier (import(`../ui/${x}`)): any of its literal parts naming the layer.
  { selector: `ImportExpression > TemplateLiteral > TemplateElement[value.cooked=${segment(dirs)}]`, message },
  { selector: `TSImportType[argument.literal.value=${segment(dirs)}]`, message },
];
const UPWARD_DYNAMIC = dynamicImports({ dirs: ['ui', 'entrypoints'], message: UPWARD.message });
const FROM_CORE_DYNAMIC = dynamicImports({ dirs: ['engine', 'storage', 'platform', 'recipes'], message: FROM_CORE.message });

export default tseslint.config(
  { ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'fixtures/**', 'scripts/**', 'spikes/**', '**/*.generated.js'] },
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ['src/engine/**', 'src/storage/**', 'src/platform/**', 'src/recipes/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [UPWARD] }],
      'no-restricted-syntax': ['error', ...UPWARD_DYNAMIC],
    },
  },
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [UPWARD, FROM_CORE] }],
      'no-restricted-syntax': ['error', ...UPWARD_DYNAMIC, ...FROM_CORE_DYNAMIC],
    },
  },
  {
    // Content scripts run in web pages; they never touch connection secrets or the code that reads them.
    files: ['src/entrypoints/*.content.{ts,tsx}', 'src/entrypoints/*.content/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/engine/connections', '**/engine/connections/**'], message: 'Content scripts must not import engine/connections/ (secrets).' }],
      }],
    },
  },
);
