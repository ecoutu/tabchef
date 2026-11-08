// Renders public/icon/{16,32,48,96,128}.png from docs/store/icon.svg with Playwright's Chromium, plus
// docs/store/icon-512.png, the GitHub App's logo (docs/store/github-app.md; GitHub asks for at least 200 px).
// The 128 px icon is also the store icon, so its artwork sits in the central 96×96 with 16 px of transparent padding
// (Chrome Web Store image guidelines); the smaller toolbar and extensions-page sizes fill their canvas.
// Usage: npm run icons
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const SVG = readFileSync(join(ROOT, 'docs/store/icon.svg'), 'utf8');
const SIZES = [16, 32, 48, 96, 128, 512];
const PADDING = { 128: 16 };
const OUT = { 512: 'docs/store/icon-512.png' };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of SIZES) {
    const pad = PADDING[size] ?? 0;
    const art = size - 2 * pad;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
        `<img src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}" ` +
        `style="display:block;margin:${pad}px;width:${art}px;height:${art}px"></body></html>`,
    );
    await page.locator('img').evaluate((img) => img.decode());
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    const out = OUT[size] ?? `public/icon/${size}.png`;
    writeFileSync(join(ROOT, out), png);
    console.log(`${out} (${size}×${size}${pad ? `, ${pad} px padding` : ''})`);
  }
} finally {
  await browser.close();
}
