import { describe, it, expect } from 'vitest';
import committed from '../../../src/core/config/validate-config.generated.js?raw';
// @ts-expect-error plain .mjs script without types
import { generate } from '../../../scripts/gen-validator.mjs';

describe('generated validator', () => {
  it('matches the committed file (run `npm run gen:validator` after editing config.schema.json)', () => {
    expect(generate()).toBe(committed);
  });
  it('is self-contained: no require() of ajv runtime helpers (the extension bundles it as ESM)', () => {
    expect(committed).not.toMatch(/\brequire\(/);
  });
});
