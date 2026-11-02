import { describe, it, expect } from 'vitest';
import { needsLevel } from '../../../src/core/lang/needs';

const GH = 'https://github.com/*';
const none = { origins: [], permissions: [], connections: [] };

describe('needsLevel (M3-R12: the pure level test T12 wires in)', () => {
  const entry = { origins: [], permissions: [], anyOf: [{ origins: [], permissions: [], connections: ['github'] }, { origins: [GH], permissions: [] }] };
  it('the level is the index of the first satisfied alternative', () => {
    expect(needsLevel(entry, { ...none, connections: ['github'], origins: [GH] })).toEqual({ ok: true, level: 0 });
    expect(needsLevel(entry, { ...none, origins: [GH] })).toEqual({ ok: true, level: 1 });
  });
  it('no satisfied alternative pauses, and the reason names every alternative', () => {
    const r = needsLevel(entry, none, { github: 'GitHub' });
    expect(r).toEqual({ ok: false, reason: 'Paused: needs the GitHub connection, or needs access to github.com' });
  });
  it('a connection without a label is named by its id', () => {
    expect(needsLevel({ origins: [], permissions: [], connections: ['jira'] }, none)).toEqual({ ok: false, reason: 'Paused: needs the jira connection' });
  });
  it('no anyOf: level 0 when the base needs are met; otherwise the pausedReason wording', () => {
    expect(needsLevel({ origins: [GH], permissions: ['scripting'] }, { ...none, origins: [GH], permissions: ['scripting'] })).toEqual({ ok: true, level: 0 });
    expect(needsLevel({ origins: [GH], permissions: [] }, none)).toEqual({ ok: false, reason: 'Paused: needs access to github.com' });
    expect(needsLevel({ origins: [], permissions: ['notifications'] }, none)).toEqual({ ok: false, reason: 'Paused: needs the notifications permission' });
  });
  it('unmet base needs pause even when an alternative is met', () => {
    expect(needsLevel({ ...entry, permissions: ['notifications'] }, { ...none, origins: [GH] })).toEqual({ ok: false, reason: 'Paused: needs the notifications permission' });
  });
});
