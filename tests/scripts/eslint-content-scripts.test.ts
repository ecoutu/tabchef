import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const CODE = "import { SecretStore } from '../../engine/connections/secret-store';\nvoid SecretStore;\n";

describe('eslint content-script restriction (M3-R88)', () => {
  it.each([
    'src/entrypoints/watch.content.ts',
    'src/entrypoints/watch.content.tsx',
    'src/entrypoints/watch.content/index.ts',
    'src/entrypoints/watch.content/index.tsx',
    'src/entrypoints/watch.content/sub/helper.ts',
  ])('forbids engine/connections imports in %s', async (filePath) => {
    const [r] = await new ESLint().lintText(CODE, { filePath });
    expect(r!.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });
  it('does not restrict background.ts', async () => {
    const [r] = await new ESLint().lintText(CODE, { filePath: 'src/entrypoints/background.ts' });
    expect(r!.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(false);
  });
});
