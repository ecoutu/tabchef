import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { columnOverflow, FIT, fitBox, fitScript, outside, rowScale, squeeze, type Fit } from '../../store/fit';

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('squeeze', () => {
  it('leaves text that fits alone', () => {
    expect(squeeze(200, 244)).toBeUndefined();
    expect(squeeze(244, 244)).toBeUndefined();
  });
  it('squeezes text wider than its room to exactly the room', () => {
    expect(squeeze(300.5, 244)).toBe(244);
  });
});

describe('rowScale', () => {
  it('is 1 for a row that fits', () => {
    expect(rowScale(1200, 1240)).toBe(1);
  });
  it('shrinks a row wider than its room to fit it', () => {
    expect(rowScale(1550, 1240)).toBeCloseTo(0.8);
    expect(1550 * rowScale(1550, 1240)).toBeCloseTo(1240);
  });
});

describe('outside', () => {
  const tile = box(0, 0, 440, 280);
  it('accepts a box inside the tile, and sub-pixel rounding at its edges', () => {
    expect(outside(box(10, 10, 430, 270), tile)).toBe(false);
    expect(outside(box(-0.4, 0, 440.4, 280.3), tile)).toBe(false);
  });
  it('flags a box that runs off any side', () => {
    expect(outside(box(300, 10, 452, 40), tile)).toBe(true);
    expect(outside(box(-2, 10, 40, 40), tile)).toBe(true);
    expect(outside(box(10, -1, 40, 40), tile)).toBe(true);
    expect(outside(box(10, 250, 40, 281), tile)).toBe(true);
  });
});

describe('columnOverflow', () => {
  const canvas = { width: 1280, height: 800 };
  it('accepts a caption inside the canvas whose text fits its column', () => {
    expect(columnOverflow(box(72, 200, 542, 600), 470, 470, canvas)).toBe(false);
  });
  it('flags a caption taller than the canvas', () => {
    expect(columnOverflow(box(72, -20, 542, 600), 470, 470, canvas)).toBe(true);
    expect(columnOverflow(box(72, 200, 542, 820), 470, 470, canvas)).toBe(true);
  });
  it('flags text wider than its column (a word that cannot wrap)', () => {
    expect(columnOverflow(box(72, 200, 542, 600), 520, 470, canvas)).toBe(true);
  });
});

describe('fitBox', () => {
  const area = box(600, 56, 1216, 744);
  it('zooms a small capture up to `zoom`, centered in the area', () => {
    expect(fitBox(400, 300, area, 1.2)).toEqual({ x: 668, y: 220, width: 480, height: 360 });
  });
  it('shrinks a capture larger than the area to fit it, keeping its aspect', () => {
    const r = fitBox(900, 1200, area, 1);
    expect(r.height).toBe(688);
    expect(r.width).toBe(516);
    expect(r.x + r.width).toBeLessThanOrEqual(1216);
  });
});

describe('fitScript', () => {
  it('defines storeFit in a page with the same functions', () => {
    const ctx: { storeFit?: Fit } = {};
    runInNewContext(fitScript(), ctx);
    const fit = ctx.storeFit!;
    expect(Object.keys(fit).sort()).toEqual(Object.keys(FIT).sort());
    expect(fit.squeeze(300, 244)).toBe(244);
    expect(fit.rowScale(1550, 1240)).toBeCloseTo(0.8);
    expect(fit.outside(box(0, 0, 500, 10), box(0, 0, 440, 280))).toBe(true);
    expect(fit.columnOverflow(box(0, 0, 10, 10), 20, 10, { width: 100, height: 100 })).toBe(true);
  });
});
