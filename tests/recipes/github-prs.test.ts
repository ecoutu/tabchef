import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/defaults';
import { migrateConfig } from '../../src/core/config/migrate';
import { canonicalizers } from '../../src/core/url/canonicalizers';
import { normalizeUrl } from '../../src/core/url/normalize';
import { evaluateGroupRules } from '../../src/core/group/evaluate';
import { builtinRecipes } from '../../src/recipes/load';
import type { Config, TabSnap } from '../../src/core/types';
import type { Recipe } from '../../src/core/lang/types';
import { programOf, v1Config } from '../helpers/config';

const PR = 'https://github.com/o/r/pull/123';
const withPrs = (enabled: boolean, dedupe: Partial<Config['dedupe']> = {}): Config => {
  const c = defaultConfig();
  return { ...c, dedupe: { ...c.dedupe, ...dedupe }, recipes: c.recipes.map((r) => (r.id === 'github-prs' ? { ...r, enabled } : r)) };
};
const keyWith = (c: Config) => (u: string) => normalizeUrl(u, programOf(c).dedupe)?.key;
const tab = (url: string): TabSnap => ({
  id: 1, windowId: 1, index: 0, url, title: 't', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false,
});

describe('github-prs recipe: PR canonicalization via p.dedupe', () => {
  it('the M1 PR equivalence vectors share a key when github-prs is enabled', () => {
    const key = keyWith(withPrs(true));
    expect(key(PR)).toBe(PR);
    for (const u of [`${PR}/files`, `${PR}/files/abc`, `${PR}/checks`, `${PR}/commits`, `${PR}/`, `${PR}#discussion_r456`]) expect(key(u), u).toBe(PR);
    expect(keyWith(withPrs(true, { stripParams: ['w'] }))(`${PR}/commits?w=1`)).toBe(PR);
    expect(normalizeUrl(`${PR}#discussion_r456`, programOf(withPrs(true)).dedupe)?.fragment).toBe('discussion_r456');
  });

  it('keeps the query (as M1 did) and leaves non-PR paths and other hosts alone', () => {
    const key = keyWith(withPrs(true));
    expect(key(`${PR}/files?diff=split`)).toBe(`${PR}?diff=split`);
    expect(key(`${PR}/other`)).toBe(`${PR}/other`);
    expect(key(`${PR}/filesx`)).toBe(`${PR}/filesx`);
    expect(key('https://example.com/o/r/pull/123/files')).toBe('https://example.com/o/r/pull/123/files');
    expect(key('https://evilgithub.com/o/r/pull/123/files')).toBe('https://evilgithub.com/o/r/pull/123/files');
    expect(key('https://a.com/?u=https://github.com/o/r/pull/1/files')).toBe('https://a.com/?u=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1%2Ffiles');
  });

  it('with github-prs disabled, /pull/123/files is not /pull/123', () => {
    const key = keyWith(withPrs(false));
    expect(key(`${PR}/files`)).not.toBe(key(PR));
  });

  it('no code canonicalizer is left: the registry is empty and defaults name none', () => {
    expect(Object.keys(canonicalizers)).toEqual([]);
    expect(defaultConfig().dedupe.canonicalizers).toEqual([]);
  });

  it('a v1 config with githubPr migrates to github-prs enabled and no githubPr canonicalizer', () => {
    const r = migrateConfig(v1Config());
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.config.dedupe.canonicalizers).toEqual([]);
    expect(r.config.recipes.find((x) => x.id === 'github-prs')?.enabled).toBe(true);
    expect(keyWith(r.config)(`${PR}/files`)).toBe(PR);
  });
});

describe('github-prs recipe: group-by-repo', () => {
  const body = () => builtinRecipes()['github-prs'] as Recipe;

  it('ships group-by-repo disabled; the program has no rule from it', () => {
    expect(body().rules.map((r) => [r.id, r.enabled])).toEqual([['group-by-repo', false]]);
    expect(programOf(withPrs(true)).rules.map((r) => r.key)).toEqual([]);
  });

  it('when enabled, groups by {repo} in grey with merge', () => {
    const b = structuredClone(body());
    b.rules[0]!.enabled = true;
    const p = programOf(withPrs(true), { ...builtinRecipes(), 'github-prs': b });
    expect(p.rules.map((r) => r.key)).toEqual(['github-prs/group-by-repo']);
    expect(evaluateGroupRules(tab('https://github.com/acme/widgets/pull/9'), p)).toMatchObject({
      key: 'github-prs/group-by-repo', ruleId: 'github-prs/group-by-repo', title: 'widgets', color: 'grey', merge: true,
    });
    expect(evaluateGroupRules(tab('https://github.com/acme/widgets'), p)?.title).toBe('widgets');
  });
});
