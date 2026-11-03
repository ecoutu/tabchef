import { describe, expect, it } from 'vitest';
import { sendQuietly } from '../../src/engine/send-quietly';

describe('sendQuietly (content scripts after an extension reload)', () => {
  it('passes the answer through', async () => {
    expect(await sendQuietly(() => Promise.resolve({ ok: true }))).toEqual({ ok: true });
  });
  it('a synchronous "Extension context invalidated" throw and a rejection both become undefined, never uncaught', async () => {
    expect(await sendQuietly(() => { throw new Error('Extension context invalidated.'); })).toBeUndefined();
    expect(await sendQuietly(() => Promise.reject(new Error('Could not establish connection.')))).toBeUndefined();
  });
});
