import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

// Layering: core is pure; engine/storage/platform/recipes may use core but never the UI or entrypoints.
const UPWARD = { group: ['**/ui', '**/ui/**', '**/entrypoints', '**/entrypoints/**'], message: 'Lower layers must not import ui/ or entrypoints/.' };
const FROM_CORE = { group: ['**/engine', '**/engine/**', '**/storage', '**/storage/**', '**/platform', '**/platform/**', '**/recipes', '**/recipes/**'], message: 'core/ must not import engine/, storage/, platform/ or recipes/.' };

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
    rules: { 'no-restricted-imports': ['error', { patterns: [UPWARD] }] },
  },
  {
    files: ['src/core/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [UPWARD, FROM_CORE] }] },
  },
);
