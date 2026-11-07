// npm run store:assets: the Chrome Web Store screenshots and promo tiles (docs/store/listing.md's table), from the
// real extension. Builds the e2e flavor (WXT_E2E_LOCALHOST=1, so the worker may call the local mock services) into a
// temp dir, which is removed afterwards: .output, which `npm run zip` packs, is never touched. Captures the popup,
// options page and side panel (capture.ts), then lays them out with the captions (captions.json), the name, tagline
// and icon (brand.ts) and the launch kit's tile designs (art.ts), in the fonts under store/fonts.
// Writes docs/store/images/, which is committed. The release job runs it and commits the images in the release commit,
// so they match the released extension. An image whose pixels didn't change is left alone, so a re-encode by another
// Chromium never shows up as a change.
// Options: --keep-captures also writes the raw captures to docs/store/images/captures/.
import { chromium, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { FACES, layoutInPage, marquee, page, screenshots, smallTile, type Captions } from './art';
import { loadBrand } from './brand';
import { fitScript, type Fit } from './fit';
import { capture } from './capture';
import * as demo from './demo';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs/store/images');

function buildE2e(outDir: string): string {
  console.log('store:assets: building the e2e extension into a temp dir (not .output)');
  execFileSync(process.execPath, ['--input-type=module', '-e', 'import { build } from "wxt"; await build({ outDir: process.argv[1] });', outDir], {
    cwd: ROOT, env: { ...process.env, WXT_E2E_LOCALHOST: '1' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  return join(outDir, 'chrome-mv3');
}

/** Whether two PNGs decode to the same pixels (their bytes may differ: encoder, metadata). */
async function samePixels(p: Page, a: Buffer, b: Buffer): Promise<boolean> {
  if (a.equals(b)) return true;
  return p.evaluate(async ([a64, b64]) => {
    const decode = async (b64: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.naturalWidth, img.naturalHeight];
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    };
    const [x, y] = [await decode(a64), await decode(b64)];
    return x.width === y.width && x.height === y.height && x.data.every((v, i) => v === y.data[i]);
  }, [a.toString('base64'), b.toString('base64')] as const);
}

/**
 * Renders `html` at exactly width×height into `file`; fails on a missing font or (tiles) anything off the tile.
 * Leaves an existing `file` with the same pixels untouched. Returns whether it wrote the file.
 */
async function render(browser: Browser, html: string, size: { width: number; height: number }, file: string): Promise<boolean> {
  const p = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  try {
    await p.setContent(page(html, size), { waitUntil: 'load' });
    const missing = await p.evaluate(async (faces) => {
      await document.fonts.ready;
      const out: string[] = [];
      for (const [family, , weight] of faces) {
        await document.fonts.load(`${weight} 16px "${family}"`);
        if (![...document.fonts].some((f) => f.family.replace(/"/g, '') === family && f.weight === String(weight) && f.status === 'loaded')) out.push(`${family} ${weight}`);
      }
      return out;
    }, FACES);
    if (missing.length) throw new Error(`store:assets: fonts did not load: ${missing.join(', ')} (see store/fonts)`);
    await p.addScriptTag({ content: fitScript() });
    const problems = await p.evaluate(layoutInPage);
    // Screenshots: the caption must fit its column and the canvas.
    problems.push(...await p.evaluate(() => [...document.querySelectorAll('.copy > *, .ui')].flatMap((e) => {
      const fit = (globalThis as unknown as { storeFit: Fit }).storeFit;
      const over = fit.columnOverflow(e.getBoundingClientRect(), e.scrollWidth, e.clientWidth, { width: innerWidth, height: innerHeight });
      return over ? [`${e.className || e.tagName} "${(e.textContent ?? '').slice(0, 40)}" does not fit`] : [];
    })));
    if (problems.length) throw new Error(`store:assets: ${file}: ${problems.join('; ')}`);
    const b = await p.screenshot({ type: 'png' });
    const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (w !== size.width || h !== size.height) throw new Error(`store:assets: ${file} is ${w}×${h}, not ${size.width}×${size.height}`);
    if (existsSync(file) && await samePixels(p, readFileSync(file), b)) return false;
    writeFileSync(file, b);
    return true;
  } finally {
    await p.close();
  }
}

export default async function main(args: string[]): Promise<number> {
  const brand = loadBrand();
  const captions = JSON.parse(readFileSync(join(ROOT, 'store/captions.json'), 'utf8')) as Captions;
  const tmp = mkdtempSync(join(tmpdir(), 'tabchef-store-build-'));
  let shots;
  try {
    const ext = buildE2e(tmp);
    console.log('store:assets: capturing the popup, options page and side panel');
    const started = Date.now();
    shots = await capture(ext, demo, args.includes('--keep-captures') ? join(OUT, 'captures') : undefined);
    console.log(`store:assets: captured in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
  const images = [
    ...screenshots(shots, captions, brand).map((s) => ({ file: s.file, html: s.html, size: { width: 1280, height: 800 } })),
    { file: 'promo-small-440x280.png', html: smallTile(brand, captions), size: { width: 440, height: 280 } },
    { file: 'promo-marquee-1400x560.png', html: marquee(brand, captions), size: { width: 1400, height: 560 } },
  ];
  const written: string[] = [];
  try {
    for (const i of images) if (await render(browser, i.html, i.size, join(OUT, i.file))) written.push(i.file);
  } finally {
    await browser.close();
  }
  const where = relative(ROOT, OUT);
  console.log(written.length
    ? `store:assets: wrote ${written.length} of ${images.length} images to ${where}/ (${written.join(', ')}); the rest are unchanged`
    : `store:assets: all ${images.length} images in ${where}/ are unchanged`);
  return 0;
}
