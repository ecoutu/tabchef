import { describe, expect, it } from 'vitest';
import raw from '../../../fixtures/auto-group-tabs.json?raw';
import { importAutoGroupTabs } from '../../../src/core/import/auto-group-tabs';
import { fillConfigDefaults, groupRuleToRule, migrateConfig, sanitizeRuleId, RULE_ID_PATTERN } from '../../../src/core/config/migrate';
import { defaultConfig } from '../../../src/core/config/defaults';
import { validateConfig } from '../../../src/core/config/schema';
import type { ConfigV2, GroupRule } from '../../../src/core/types';
import { v1Config } from '../../helpers/config';

const gr = (id: string, o: Partial<GroupRule> = {}): GroupRule => ({
  id, name: `Rule ${id}`, enabled: true, match: { url: `https://${id}.example/*` }, group: { title: id, color: 'blue' }, ...o,
});
const ok = (input: unknown): { config: ConfigV2; migratedFrom?: 1 } => {
  const r = migrateConfig(input);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r;
};

describe('migrateConfig v1 -> v2', () => {
  it('migrates the M1 importer output of the AGT fixture: 13 user rules, same order, options kept', async () => {
    const { rules } = await importAutoGroupTabs(JSON.parse(raw));
    const r = ok(v1Config(rules));
    expect(r.migratedFrom).toBe(1);
    expect(r.config.version).toBe(2);
    expect(r.config.rules).toHaveLength(13);
    expect(r.config.rules.map((x) => x.id)).toEqual(rules.map((x) => x.id));
    const first = r.config.rules[0]!;
    expect(first.match).toEqual({ url: rules[0]!.match.url });
    expect(first.actions).toEqual([{ group: { title: rules[0]!.group.title, color: rules[0]!.group.color, strict: true, merge: true } }]);
    expect(r.config.order[0]).toBe(`user/${rules[0]!.id}`);
    expect(r.config.order.slice(0, 13)).toEqual(rules.map((x) => `user/${x.id}`));
    expect(validateConfig(r.config).ok).toBe(true);
  });

  it('maps every GroupRule field, and a per-rule dedupe override to a dedupe action', () => {
    const g = gr('a', { group: { title: 'A', color: 'red', collapsed: true }, sortGroups: 'alphabetical', dedupe: 'off', strict: false, merge: true });
    expect(groupRuleToRule(g)).toEqual({
      id: 'a', name: 'Rule a', enabled: true, match: { url: 'https://a.example/*' },
      actions: [{ group: { title: 'A', color: 'red', collapsed: true, sortGroups: 'alphabetical', strict: false, merge: true } }, { dedupe: { mode: 'off' } }],
    });
  });

  it('copies dedupe and adds the new fields with defaults; tables empty; dryRun false', () => {
    const r = ok(v1Config([], { stripParams: ['x'], mode: 'ask' }));
    expect(r.config.dedupe).toMatchObject({ stripParams: ['x'], mode: 'ask', fragmentOverrides: [], matchTitle: false, titleOverrides: [] });
    expect(r.config.tables).toEqual({});
    expect(r.config.dryRun).toBe(false);
  });

  it('an older v1 without canonicalizers gets the M1 default (githubPr) and so github-prs; githubPr is dropped (M2 T6)', () => {
    const v = v1Config() as unknown as { dedupe: Record<string, unknown> };
    delete v.dedupe.canonicalizers;
    const r = ok(v).config;
    expect(r.recipes.find((x) => x.id === 'github-prs')?.enabled).toBe(true);
    expect(r.dedupe.canonicalizers).toEqual([]);
    expect(ok(v1Config([], { canonicalizers: ['githubPr', 'other'] })).config.dedupe.canonicalizers).toEqual(['other']);
  });

  it('enables github-prs only when v1 had the githubPr canonicalizer', () => {
    const on = ok(v1Config([], { canonicalizers: ['githubPr'] })).config.recipes;
    const off = ok(v1Config([], { canonicalizers: [] })).config.recipes;
    expect(on.find((x) => x.id === 'github-prs')?.enabled).toBe(true);
    expect(off.find((x) => x.id === 'github-prs')?.enabled).toBe(false);
    expect(off.find((x) => x.id === 'duplicates')?.enabled).toBe(true);
    expect(off.find((x) => x.id === 'finished')?.enabled).toBe(false);
  });

  it('fills dedupe fields missing from an older v1 before validating it', () => {
    const v = v1Config() as unknown as { dedupe: Record<string, unknown> };
    delete v.dedupe.alwaysSwitchSites;
    expect(ok(v).config.dedupe.alwaysSwitchSites).toEqual([]);
  });

  it('sanitizes v1 ids to the v2 pattern, de-duplicated, and applies the id map to order', () => {
    const r = ok(v1Config([gr('Foo Bar!'), gr('foo-bar'), gr('ok'), gr('/'), gr('ok')]));
    const ids = r.config.rules.map((x) => x.id);
    expect(ids).toEqual(['foo-bar', 'foo-bar-2', 'ok', 'rule', 'ok-2']);
    for (const id of ids) expect(id).toMatch(RULE_ID_PATTERN);
    expect(r.config.order).toEqual(ids.map((id) => `user/${id}`));
    expect(validateConfig(r.config).ok).toBe(true);
  });

  it('sanitizeRuleId truncates long ids and keeps valid ones', () => {
    expect(sanitizeRuleId('9ff676fe-3457-5e15-bcb0-4bd9b62ed494', new Set())).toBe('9ff676fe-3457-5e15-bcb0-4bd9b62ed494');
    expect(sanitizeRuleId('x'.repeat(100), new Set()).length).toBeLessThanOrEqual(64);
  });

  it('a v2 config passes through unchanged (no migratedFrom)', () => {
    const c = defaultConfig();
    const r = ok(c);
    expect(r.migratedFrom).toBeUndefined();
    expect(r.config).toEqual(c);
  });

  it('invalid v1 -> ok:false', () => {
    expect(migrateConfig({ version: 1, groupRules: 'nope' }).ok).toBe(false);
    expect(migrateConfig({ version: 1, groupRules: [{ id: 'a' }] }).ok).toBe(false);
  });

  it('unknown version or non-object -> ok:false', () => {
    expect(migrateConfig({ version: 3 }).ok).toBe(false);
    expect(migrateConfig(null).ok).toBe(false);
    expect(migrateConfig('x').ok).toBe(false);
  });
});

describe('defaultConfig v2', () => {
  it('validates, with duplicates, github-prs and manual-project enabled, finished, merged-prs and the jira-ticket variants disabled, dryRun false', () => {
    const c = defaultConfig();
    expect(validateConfig(c).ok).toBe(true);
    expect(c.version).toBe(2);
    expect(c.rules).toEqual([]);
    expect(c.dryRun).toBe(false);
    expect(c.recipes.map((r) => [r.id, r.enabled, r.source])).toEqual([
      ['duplicates', true, 'builtin'], ['github-prs', true, 'builtin'], ['finished', false, 'builtin'], ['merged-prs', false, 'builtin'],
      ['jira-ticket-title', false, 'builtin'], ['jira-ticket-branch', false, 'builtin'], ['jira-ticket-either', false, 'builtin'],
      ['manual-project', true, 'builtin'],
    ]);
    expect(c.dedupe).toMatchObject({ fragmentOverrides: [], matchTitle: false, titleOverrides: [] });
  });
});

describe('fillConfigDefaults: built-in recipes added later (M2, R68)', () => {
  it('appends each missing built-in ref, disabled, after the stored refs, in built-in order', () => {
    const d = defaultConfig();
    const user = { id: 'mine', enabled: true, params: {}, source: 'user' as const, body: {} };
    const out = fillConfigDefaults({ ...d, recipes: [user, d.recipes.find((r) => r.id === 'finished')!] }) as ConfigV2;
    expect(out.recipes.map((r) => [r.id, r.enabled])).toEqual([['mine', true], ['finished', false], ['duplicates', false], ['github-prs', false], ['merged-prs', false],
      ['jira-ticket-title', false], ['jira-ticket-branch', false], ['jira-ticket-either', false], ['manual-project', false]]);
    expect(out.recipes[2]).toEqual({ id: 'duplicates', enabled: false, params: {}, source: 'builtin' });
  });
  it('returns the stored recipes array untouched when none is missing, and never mutates the input', () => {
    const d = defaultConfig();
    const input = { ...d, recipes: d.recipes.slice(0, 2) };
    fillConfigDefaults(input);
    expect(input.recipes).toHaveLength(2);
    const full = { ...d };
    expect((fillConfigDefaults(full) as ConfigV2).recipes).toBe(full.recipes);
  });
  it('a missing recipes key still gets the default refs (with their default enabled state)', () => {
    const d = defaultConfig() as unknown as Record<string, unknown>;
    delete d.recipes;
    expect((fillConfigDefaults(d) as ConfigV2).recipes).toEqual(defaultConfig().recipes);
  });
});

