import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { RecentlyClosed } from '../../../src/core/safety/recently-closed';

const e = (i: number) => ({ url: `https://x.com/${i}`, title: `t${i}`, windowId: 1, reason: 'duplicate', at: i });

describe('RecentlyClosed', () => {
  beforeEach(() => fakeBrowser.reset());

  it('caps at 100, newest first', async () => {
    const rc = new RecentlyClosed();
    for (let i = 0; i < 105; i++) rc.add(e(i));
    expect(rc.list()).toHaveLength(100);
    expect(rc.list()[0]!.at).toBe(104);
    expect(rc.list().at(-1)!.at).toBe(5);
    await rc.idle();
  });

  it('take removes the entry and returns it once', async () => {
    const rc = new RecentlyClosed();
    const id = rc.add(e(1));
    expect(rc.take(id)).toMatchObject({ id, url: 'https://x.com/1' });
    expect(rc.take(id)).toBeUndefined();
    expect(rc.list()).toEqual([]);
    await rc.idle();
  });

  it('ids are unique and persisted under recentlyClosed', async () => {
    const rc = new RecentlyClosed();
    const a = rc.add(e(1));
    const b = rc.add(e(1));
    expect(a).not.toBe(b);
    await rc.idle();
    expect(((await browser.storage.local.get('recentlyClosed')).recentlyClosed as unknown[]).length).toBe(2);
    const again = new RecentlyClosed();
    await again.ready;
    expect(again.list().map((x) => x.id)).toEqual([b, a]);
  });
});
