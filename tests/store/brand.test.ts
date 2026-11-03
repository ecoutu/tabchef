import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ICON_SVG, loadBrand } from '../../store/brand';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"/>';

/** A temp repository root with terms.json naming `name`, the given listing.md, and the icon. */
function root(name: string, listing: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-brand-'));
  dirs.push(dir);
  const files = { 'docs/store/terms.json': JSON.stringify({ name, banned: [] }), 'docs/store/listing.md': listing, [ICON_SVG]: ICON };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

const LISTING = '# Listing\n\n## Name\n\nPotluck\n\n## Tagline\n\nTabs, served.\n\n## Summary\n\nText.\n';

describe('loadBrand', () => {
  it('takes the name from terms.json, the tagline from the listing and the icon from ICON_SVG', () => {
    expect(loadBrand(root('Potluck', LISTING), 'Potluck')).toEqual({ name: 'Potluck', tagline: 'Tabs, served.', iconSvg: ICON });
  });

  it('throws when terms.json and the manifest name differ', () => {
    expect(() => loadBrand(root('Potluck', LISTING), 'Tabchef')).toThrow(/names the product "Potluck" but the manifest .* says "Tabchef"/);
  });

  it('throws when the listing has no Tagline section', () => {
    expect(() => loadBrand(root('Potluck', '# Listing\n\n## Name\n\nPotluck\n'), 'Potluck')).toThrow(/no "## Tagline" section/);
  });

  it('reads the real repository by default, where the names agree', () => {
    expect(loadBrand().name).toMatch(/\S/);
  });
});
