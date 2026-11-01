import { describe, expect, it } from 'vitest';
import { mergeDedupe } from '../../../src/core/import/merge';
import { defaultConfig } from '../../../src/core/config/defaults';

describe('mergeDedupe', () => {
  it('keeps existing list entries, unions and de-dupes, and reports changes', () => {
    const cur = { ...defaultConfig().dedupe, allowDuplicates: ['keep.com*', 'a.com*'], urlTransforms: [{ pattern: 'x', replacement: 'y' }] };
    const { merged, changes } = mergeDedupe(cur, {
      allowDuplicates: ['a.com*', 'new.com*'],
      urlTransforms: [{ pattern: 'x', replacement: 'y' }, { pattern: 'p', replacement: 'q', flags: 'g' }],
    });
    expect(merged.allowDuplicates).toEqual(['keep.com*', 'a.com*', 'new.com*']);
    expect(merged.urlTransforms).toEqual([{ pattern: 'x', replacement: 'y' }, { pattern: 'p', replacement: 'q', flags: 'g' }]);
    expect(changes.join('\n')).toMatch(/allowDuplicates/);
    expect(changes.join('\n')).toMatch(/urlTransforms/);
  });

  it('changes scalars only when set and different, reporting old -> new', () => {
    const cur = defaultConfig().dedupe;
    const { merged, changes } = mergeDedupe(cur, { scope: 'same-window', stripFragment: true });
    expect(merged.scope).toBe('same-window');
    expect(changes).toEqual(['scope: all-windows \u2192 same-window']);
    expect(mergeDedupe(cur, {}).changes).toEqual([]);
  });
});
