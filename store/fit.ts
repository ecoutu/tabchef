// The fitting rules of the store images, as pure functions: generate.ts uses them in node (capture placement) and
// installs them in the render page (fitScript) for the layout that needs measured text (art.ts layoutInPage).
// Each function must stay self-contained (no imports, no outer names): fitScript ships its source text.

export interface Box { left: number; top: number; right: number; bottom: number }

/** The textLength to give text measured `width` px wide that has `max` px of room: undefined when it fits. */
export function squeeze(width: number, max: number): number | undefined {
  return width > max ? max : undefined;
}

/** The scale a row `width` px wide needs to fit `room` px: 1 when it fits. */
export function rowScale(width: number, room: number): number {
  return width > room ? room / width : 1;
}

/** Whether `r` ends outside `bounds` by more than `slack` px on any side (sub-pixel rounding is not a problem). */
export function outside(r: Box, bounds: Box, slack = 0.5): boolean {
  return r.left < bounds.left - slack || r.right > bounds.right + slack || r.top < bounds.top - slack || r.bottom > bounds.bottom + slack;
}

/**
 * Whether a caption block overflows: it ends outside the canvas, or its content is wider than its column
 * (`scrollWidth` beyond `clientWidth`, e.g. a word too long for the column).
 */
export function columnOverflow(r: Box, scrollWidth: number, clientWidth: number, canvas: { width: number; height: number }): boolean {
  return r.top < 0 || r.bottom > canvas.height || r.right > canvas.width || scrollWidth > clientWidth + 1;
}

/** A w×h capture fitted into `area`: at most `zoom` times its size, never larger than the area, centered. */
export function fitBox(w: number, h: number, area: Box, zoom: number): { x: number; y: number; width: number; height: number } {
  const k = Math.min(zoom, (area.right - area.left) / w, (area.bottom - area.top) / h);
  const [width, height] = [Math.round(w * k), Math.round(h * k)];
  return {
    x: Math.round(area.left + (area.right - area.left - width) / 2),
    y: Math.round(area.top + (area.bottom - area.top - height) / 2),
    width, height,
  };
}

export const FIT = { squeeze, rowScale, outside, columnOverflow };
export type Fit = typeof FIT;

/** A script for the render page that defines `globalThis.storeFit` with the functions above. */
export function fitScript(): string {
  return `globalThis.storeFit = { ${Object.entries(FIT).map(([k, f]) => `${k}: ${f.toString()}`).join(',\n')} };`;
}
