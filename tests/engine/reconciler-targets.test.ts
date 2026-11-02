import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

vi.mock('../../src/core/group/evaluate', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/group/evaluate')>();
  return { ...real, evaluateGroup: vi.fn(real.evaluateGroup) };
});

import { evaluateGroup } from '../../src/core/group/evaluate';
import { Reconciler } from '../../src/engine/reconciler';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import type { Config } from '../../src/core/types';
import { withGroupRules, programOf } from '../helpers/config';

const config: Config = withGroupRules([{ id: 'a', name: 'a', enabled: true, match: { url: 'https://a.com/**' }, group: { title: 'A', color: 'red' } }]);

describe('Reconciler: targets computed once per pass (CR#8)', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.mocked(evaluateGroup).mockClear(); });

  it('evaluateGroup runs once per tab per pass', async () => {
    const f = new FakeBrowserPort();
    f.addWindow(1);
    for (const id of [1, 2, 3]) {
      f.addTab({ id, windowId: 1, url: id === 3 ? 'https://b.com/' : 'https://a.com/x', title: `t${id}`, pinned: false,
        incognito: false, discarded: false, active: false, audible: false });
    }
    const snapshots = vi.spyOn(f, 'snapshot');
    await new Reconciler(f, async () => programOf(config)).flush();
    const passes = snapshots.mock.calls.length;
    expect(passes).toBe(2); // group, then a satisfied re-plan
    expect(vi.mocked(evaluateGroup).mock.calls.length).toBe(3 * passes);
  });
});
