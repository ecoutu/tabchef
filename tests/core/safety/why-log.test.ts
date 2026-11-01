import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { WhyLog } from '../../../src/core/safety/why-log';

const e = (i: number, o: { tabId?: number; ruleId?: string } = {}) => ({ action: 'a', detail: `d${i}`, at: i, ...o });

describe('WhyLog', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('keeps the last 1000 entries', () => {
    const log = new WhyLog();
    for (let i = 0; i < 1005; i++) log.add(e(i));
    expect(log.all()).toHaveLength(1000);
    expect(log.all()[0]!.detail).toBe('d5');
    expect(log.all().at(-1)!.detail).toBe('d1004');
  });

  it('counts hits per rule and filters by tab', () => {
    const log = new WhyLog();
    log.add(e(1, { ruleId: 'r1', tabId: 7 }));
    log.add(e(2, { ruleId: 'r1', tabId: 8 }));
    log.add(e(3, { ruleId: 'r2', tabId: 7 }));
    expect(log.hits('r1')).toBe(2);
    expect(log.hits('nope')).toBe(0);
    expect(log.forTab(7).map((x) => x.at)).toEqual([1, 3]);
  });

  it('persists to storage.local key whyLog, debounced 1 s', async () => {
    const log = new WhyLog();
    log.add(e(1));
    await vi.advanceTimersByTimeAsync(900);
    log.add(e(2));
    await vi.advanceTimersByTimeAsync(900);
    expect((await browser.storage.local.get('whyLog')).whyLog).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(((await browser.storage.local.get('whyLog')).whyLog as unknown[]).length).toBe(2);
  });

  it('flushes within 5 s even under steady activity (max wait)', async () => {
    const log = new WhyLog();
    for (let i = 0; i < 12; i++) {
      log.add(e(i));
      await vi.advanceTimersByTimeAsync(500);
    }
    const stored = (await browser.storage.local.get('whyLog')).whyLog as unknown[] | undefined;
    expect(stored?.length).toBeGreaterThanOrEqual(9);
  });

  it('loads persisted entries beneath new ones', async () => {
    await browser.storage.local.set({ whyLog: [e(1), e(2)] });
    const log = new WhyLog();
    log.add(e(3));
    await log.ready;
    expect(log.all().map((x) => x.at)).toEqual([1, 2, 3]);
  });
});
