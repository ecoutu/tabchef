// npm run store:assets: the Chrome Web Store screenshots and promo tiles (docs/store/listing.md's table), from the
// real extension. Builds the e2e flavor (WXT_E2E_LOCALHOST=1, so the worker may call the local mock services) into a
// temp dir, which is removed afterwards: .output, which `npm run zip` packs, is never touched. Captures the popup,
// options page and side panel (capture.ts), then lays them out with the captions (captions.json), the name, tagline
// and icon (brand.ts) and the launch kit's tile designs (art.ts), in the fonts under store/fonts.
// Writes docs/store/images/, which is committed: re-run and commit after a UI, name or icon change.
// Options: --keep-captures also writes the raw captures to docs/store/images/captures/.
import { chromium, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Renders `html` at exactly width×height into `file`; fails on a missing font or (tiles) anything off the tile. */
async function render(browser: Browser, html: string, size: { width: number; height: number }, file: string): Promise<void> {
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
    await p.screenshot({ path: file, type: 'png' });
    const b = readFileSync(file);
    const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (w !== size.width || h !== size.height) throw new Error(`store:assets: ${file} is ${w}×${h}, not ${size.width}×${size.height}`);
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
  const written: string[] = [];
  try {
    for (const s of screenshots(shots, captions, brand)) {
      await render(browser, s.html, { width: 1280, height: 800 }, join(OUT, s.file));
      written.push(s.file);
    }
    await render(browser, smallTile(brand, captions), { width: 440, height: 280 }, join(OUT, 'promo-small-440x280.png'));
    await render(browser, marquee(brand, captions), { width: 1400, height: 560 }, join(OUT, 'promo-marquee-1400x560.png'));
    written.push('promo-small-440x280.png', 'promo-marquee-1400x560.png');
  } finally {
    await browser.close();
  }
  console.log(`store:assets: wrote ${written.length} images to ${relative(ROOT, OUT)}/ (${written.join(', ')})`);
  return 0;
}
