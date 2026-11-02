import { describe, expect, it, vi } from 'vitest';
import { ProgramCache } from '../../src/engine/program-cache';
import { defaultConfig } from '../../src/core/config/defaults';
import { withGroupRules } from '../helpers/config';
import type { Config } from '../../src/core/types';

const rule = (id: string) => ({ id, name: id, enabled: true, match: { url: `${id}.com/*` }, group: { title: id, color: 'blue' as const } });

describe('ProgramCache (R4)', () => {
  it('compiles once per config revision and paused set; recompiles when either changes', async () => {
    let cfg: Config = withGroupRules([rule('a')]);
    let paused: string[] = [];
    const compile = vi.fn();
    const cache = new ProgramCache(async () => cfg, { paused: () => paused, onCompile: compile });
    const p1 = await cache.get();
    expect(p1.rules.map((r) => r.key)).toEqual(['user/a']);
    expect(await cache.get()).toBe(p1);
    cfg = structuredClone(cfg); // same content, new object (a store reload)
    expect(await cache.get()).toBe(p1);
    expect(compile).toHaveBeenCalledTimes(1);

    cfg = withGroupRules([rule('a'), rule('b')]);
    const p2 = await cache.get();
    expect(p2.rules.map((r) => r.key)).toEqual(['user/a', 'user/b']);

    paused = ['user/a'];
    const p3 = await cache.get();
    expect(p3.rules.map((r) => r.key)).toEqual(['user/b']);
    expect(await cache.get()).toBe(p3);
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it('uses the built-in recipe bodies: the default program carries the github-prs PR transform', async () => {
    const p = await new ProgramCache(async () => defaultConfig()).get();
    expect(p.dedupe.urlTransforms.length).toBe(1);
    expect(p.dedupe.canonicalizers).toEqual([]);
  });

  it('reports compile errors once per compile', async () => {
    const cfg: Config = { ...defaultConfig(), recipes: [...defaultConfig().recipes, { id: 'ghost', enabled: true, params: {}, source: 'builtin' }] };
    const warn = vi.fn();
    const cache = new ProgramCache(async () => cfg, { warn });
    await cache.get();
    await cache.get();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ghost');
  });
});
