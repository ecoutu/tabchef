import { describe, expect, it, vi } from 'vitest';
import { syncWatchRegistration, WATCH_FILE, WATCH_SCRIPT_ID, watchOrigins, type WatchRegistrationApi } from '../../src/engine/watch-registration';

function fakeApi(initial: { id: string; matches?: string[] }[] = []) {
  let scripts = [...initial];
  const api: WatchRegistrationApi = {
    getRegistered: vi.fn(async () => scripts.filter((s) => s.id === WATCH_SCRIPT_ID)),
    register: vi.fn(async (s) => { scripts.push(...s); }),
    update: vi.fn(async (s) => { scripts = scripts.map((x) => s.find((y: { id: string }) => y.id === x.id) ?? x); }),
    unregister: vi.fn(async (ids) => { scripts = scripts.filter((x) => !ids.includes(x.id)); }),
  };
  return { api, scripts: () => scripts };
}

describe('watch script registration (seam for M2 T8)', () => {
  it('watchOrigins keeps only http(s) host patterns', () => {
    expect(watchOrigins(['https://*/*', 'http://localhost/*', 'chrome://favicon/*', '<all_urls>'])).toEqual(['https://*/*', 'http://localhost/*']);
  });

  it('registers for the granted hosts, updates on change, unregisters when none remain', async () => {
    const f = fakeApi();
    await syncWatchRegistration(f.api, ['https://github.com/*']);
    expect(f.scripts()).toEqual([{
      id: WATCH_SCRIPT_ID, js: [WATCH_FILE], matches: ['https://github.com/*'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
    }]);
    await syncWatchRegistration(f.api, ['https://github.com/*']);
    expect(f.api.update).not.toHaveBeenCalled(); // unchanged: no churn
    await syncWatchRegistration(f.api, ['https://github.com/*', 'https://meet.google.com/*']);
    expect(f.scripts()[0]!.matches).toEqual(['https://github.com/*', 'https://meet.google.com/*']);
    await syncWatchRegistration(f.api, []);
    expect(f.scripts()).toEqual([]);
    await syncWatchRegistration(f.api, []);
    expect(f.api.unregister).toHaveBeenCalledTimes(1);
  });
});
