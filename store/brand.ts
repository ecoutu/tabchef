// The one place the store images get the product name, tagline and icon from. A rename (#46) changes `name` in
// docs/store/terms.json (check:terms enforces that spelling everywhere) and the manifest name in wxt.config.ts; the
// generator refuses to run while they differ, then re-renders every image with the new name. The tagline is the
// listing's "## Tagline" section. The icon is the extension icon's SVG source (npm run icons renders public/icon/).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { manifestConfig } from '../wxt.config';

const ROOT = resolve(import.meta.dirname, '..');

/** The icon the tiles and screenshots show: the same source as the extension's own icon. */
export const ICON_SVG = 'docs/store/icon.svg';

export interface Brand { name: string; tagline: string; iconSvg: string }

export function loadBrand(): Brand {
  const name = (JSON.parse(readFileSync(join(ROOT, 'docs/store/terms.json'), 'utf8')) as { name: string }).name;
  if (manifestConfig.name !== name) {
    throw new Error(`store:assets: docs/store/terms.json names the product "${name}" but the manifest (wxt.config.ts) says "${manifestConfig.name}"; make them the same`);
  }
  const listing = readFileSync(join(ROOT, 'docs/store/listing.md'), 'utf8');
  const tagline = /^## Tagline\n+(.+)$/m.exec(listing)?.[1]?.trim();
  if (!tagline) throw new Error('store:assets: docs/store/listing.md has no "## Tagline" section');
  return { name, tagline, iconSvg: readFileSync(join(ROOT, ICON_SVG), 'utf8') };
}
