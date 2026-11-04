import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const CODE = "import { SecretStore } from '../../engine/connections/secret-store';\nvoid SecretStore;\n";

// One ESLint for every case: the first lint loads the whole typed config (typescript-eslint builds a program), which
// took 18 s on a loaded machine and blew Vitest's 5 s default. Later lints reuse it and take milliseconds.
const eslint = new ESLint();
const restricted = async (filePath: string): Promise<boolean> => {
  const [r] = await eslint.lintText(CODE, { filePath });
  return r!.messages.some((m) => m.ruleId === 'no-restricted-imports');
};

describe('eslint content-script restriction (M3-R88)', { timeout: 60_000 }, () => {
  it.each([
    'src/entrypoints/watch.content.ts',
    'src/entrypoints/watch.content.tsx',
    'src/entrypoints/watch.content/index.ts',
    'src/entrypoints/watch.content/index.tsx',
    'src/entrypoints/watch.content/sub/helper.ts',
  ])('forbids engine/connections imports in %s', async (filePath) => {
    expect(await restricted(filePath)).toBe(true);
  });
  it('does not restrict background.ts', async () => {
    expect(await restricted('src/entrypoints/background.ts')).toBe(false);
  });
});
