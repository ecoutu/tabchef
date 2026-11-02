import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { requestNeeds } from '../../src/ui/permissions';

describe('requestNeeds', () => {
  it('requests the needs with scripting added for host needs, synchronously (user gesture)', async () => {
    const request = vi.fn(async () => true);
    (browser.permissions as unknown as { request: typeof request }).request = request;
    const p = requestNeeds({ origins: ['https://meet.google.com/*'], permissions: [] });
    expect(request).toHaveBeenCalledWith({ origins: ['https://meet.google.com/*'], permissions: ['scripting'] }); // before any await
    expect(await p).toBe(true);
  });

  it('nothing to request resolves true without a prompt', async () => {
    const request = vi.fn(async () => false);
    (browser.permissions as unknown as { request: typeof request }).request = request;
    expect(await requestNeeds({ origins: [], permissions: [] })).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
