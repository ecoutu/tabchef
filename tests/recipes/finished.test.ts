import { describe, expect, it } from 'vitest';
import { compileProgram } from '../../src/core/lang/compile';
import { evaluateTab } from '../../src/core/lang/evaluate';
import { defaultConfig } from '../../src/core/config/defaults';
import { PermissionsManager, type WatchScripting } from '../../src/engine/permissions';
import { ProgramCache } from '../../src/engine/program-cache';
import { FakeBrowserPort } from '../../src/platform/fake-port';
import { builtinRecipes } from '../../src/recipes/load';
import type { Config, TabSnap } from '../../src/core/types';
import type { Recipe, TabFacts } from '../../src/core/lang/types';
import { programOf } from '../helpers/config';

const MEET = 'https://meet.google.com/*';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const body = () => builtinRecipes().finished as Recipe;
const withFinished = (params: Record<string, unknown> = {}): Config => {
  const c = defaultConfig();
  return { ...c, recipes: c.recipes.map((r) => (r.id === 'finished' ? { ...r, enabled: true, params } : r)) };
};
const tab = (url: string): TabSnap => ({
  id: 1, windowId: 1, index: 0, url, title: 't', pinned: false, groupId: -1, incognito: false, discarded: false, active: false, audible: false,
});
const facts = (url: string, texts?: string[]): TabFacts => ({
  tab: tab(url), ...(texts ? { page: { texts, extracts: {}, formEdited: false } } : {}),
});
const evalUrl = (c: Config, url: string, texts?: string[], paused?: Set<string>) => {
  const { program, errors } = compileProgram(c, builtinRecipes(), { paused });
  if (errors.length) throw new Error(JSON.stringify(errors));
  return evaluateTab(program, facts(url, texts), 0);
};

describe('finished recipe: shape', () => {
  it('ships the plan params, per-rule needs on meet-ended only, and the Finished view', () => {
    const b = body();
    expect(b.params).toEqual({
      delay: expect.objectContaining({ type: 'duration', default: '3s' }),
      mode: expect.objectContaining({ type: 'string', default: 'auto', enum: ['auto', 'suggest'] }),
      callbackPatterns: expect.objectContaining({
        type: 'string[]',
        default: ['http://localhost:*/*callback*', 'http://127.0.0.1:*/*callback*', '*/oauth/*/success*', '*/oauth2/*/callback*'],
      }),
      meetEndedTexts: expect.objectContaining({ type: 'string[]', default: ['You left the meeting', "You've left the call", 'The call has ended'] }),
      redirectPatterns: expect.objectContaining({ type: 'string[]', default: [] }),
    });
    expect(b.needs).toBeUndefined(); // R5: no recipe-level needs, so enabling never waits on Meet
    expect(b.rules.map((r) => [r.id, r.needs])).toEqual([
      ['oauth-callback', undefined], ['meet-ended', { hosts: [MEET] }], ['redirect', undefined],
    ]);
    expect(b.views).toEqual([{ id: 'finished', tab: 'Finished', kind: 'list', actions: ['focus', 'close', 'keep'] }]);
  });

  it('compiles: list params land as whole arrays; needs are keyed by recipe id and by rule key', () => {
    const p = programOf(withFinished());
    expect(p.rules.filter((r) => r.recipeId === 'finished').map((r) => r.key)).toEqual(['finished/oauth-callback', 'finished/meet-ended', 'finished/redirect']);
    const rule = (k: string) => p.rules.find((r) => r.key === k)!.rule;
    expect(rule('finished/oauth-callback').match).toEqual({ url: body().params!.callbackPatterns!.default });
    expect(rule('finished/meet-ended').match).toEqual({ all: [{ url: 'meet.google.com/*' }, { pageText: body().params!.meetEndedTexts!.default }] });
    expect(rule('finished/redirect').match).toEqual({ url: [] });
    expect(p.needs.finished).toEqual({ origins: [], permissions: [] });
    expect(p.needs['finished/meet-ended']).toEqual({ origins: [MEET], permissions: [] });
    expect(p.views.filter((v) => v.recipeId === 'finished')).toEqual([{ ...body().views![0], recipeId: 'finished' }]);
  });

  it('is disabled by default', () => {
    expect(defaultConfig().recipes.find((r) => r.id === 'finished')?.enabled).toBe(false);
  });
});

describe('finished recipe: oauth-callback', () => {
  it('closes a localhost callback after 3 s (auto)', () => {
    expect(evalUrl(withFinished(), 'http://localhost:8080/auth/callback?code=x').close)
      .toEqual({ key: 'finished/oauth-callback', afterMs: 3000, mode: 'auto', dryRun: false });
  });

  it('matches the other default patterns; leaves other pages alone', () => {
    const c = withFinished();
    for (const u of ['http://127.0.0.1:53682/oauth/callback', 'https://id.example.com/oauth/google/success?x=1', 'https://a.example/oauth2/x/callback']) {
      expect(evalUrl(c, u).close?.key, u).toBe('finished/oauth-callback');
    }
    for (const u of ['http://localhost:8080/app', 'https://example.com/callback', 'https://localhost.evil.com/callback']) {
      expect(evalUrl(c, u).close, u).toBeUndefined();
    }
  });

  it("mode 'suggest' and delay come from the params", () => {
    expect(evalUrl(withFinished({ mode: 'suggest', delay: '10s' }), 'http://localhost:8080/auth/callback').close)
      .toMatchObject({ afterMs: 10000, mode: 'suggest' });
  });

  it("mode outside the enum ('off') is a compile error for the recipe (R14)", () => {
    const { program, errors } = compileProgram(withFinished({ mode: 'off' }), builtinRecipes());
    expect(errors).toEqual([{ key: 'finished', error: 'param mode: must be one of ["auto","suggest"]' }]);
    expect(program.rules.some((r) => r.recipeId === 'finished')).toBe(false);
  });
});

describe('finished recipe: meet-ended', () => {
  it('closes an ended Meet call after 2 s', () => {
    expect(evalUrl(withFinished(), MEET_URL, ['You left the meeting']).close)
      .toEqual({ key: 'finished/meet-ended', afterMs: 2000, mode: 'auto', dryRun: false });
    expect(evalUrl(withFinished({ mode: 'suggest' }), MEET_URL, ['The call has ended']).close?.mode).toBe('suggest');
  });

  it('without page facts: needsPage, no close; a live call is not closed', () => {
    const r = evalUrl(withFinished(), MEET_URL);
    expect(r.needsPage).toBe(true);
    expect(r.close).toBeUndefined();
    expect(evalUrl(withFinished(), MEET_URL, ['Leave call']).close).toBeUndefined();
  });

  it('redirect with its default [] never matches (inert until configured, R36)', () => {
    expect(evalUrl(withFinished(), 'https://example.com/landed').matched).toEqual([]);
    expect(evalUrl(withFinished({ redirectPatterns: ['example.com/landed*'] }), 'https://example.com/landed').close)
      .toMatchObject({ key: 'finished/redirect', afterMs: 3000 });
  });
});

describe('finished recipe: without the Meet grant (R5)', () => {
  const scripting: WatchScripting = { register: async () => [], unregister: async () => [] };
  async function managed() {
    const cfg = withFinished();
    const holder: { pm?: PermissionsManager } = {};
    const programs = new ProgramCache(async () => cfg, { builtins: builtinRecipes(), paused: () => holder.pm?.paused() ?? [], warn: () => {} });
    const pm = new PermissionsManager(new FakeBrowserPort(), () => programs.get(), scripting);
    holder.pm = pm;
    await pm.onChanged();
    return { pm, program: await programs.get() };
  }

  it('pauses meet-ended only; the recipe is ok and the oauth rule still closes', async () => {
    const { pm, program } = await managed();
    expect([...pm.paused()]).toEqual(['finished/meet-ended']);
    const st = await pm.status();
    expect(st.finished!.ok).toBe(true);
    expect(st['finished/meet-ended']).toMatchObject({ ok: false, reason: 'Paused: needs access to meet.google.com' });
    expect(program.rules.map((r) => r.key)).not.toContain('finished/meet-ended');
    expect(program.needs['finished/meet-ended']).toEqual({ origins: [MEET], permissions: [] }); // listed while paused
    expect(evaluateTab(program, facts('http://localhost:8080/auth/callback?code=x'), 0).close?.key).toBe('finished/oauth-callback');
    expect(evaluateTab(program, facts(MEET_URL, ['You left the meeting']), 0).close).toBeUndefined();
  });
});
