// The store images as HTML pages, rendered by generate.ts: five captioned screenshots (caption on the left, the real
// UI capture on the right, on a light ground, as the launch kit's screenshot mock) and the two promo tiles from the
// launch kit (https://claude.ai/artifact/RF913qNnKxbSjjQqTaFTVe): icon, name, tagline and chips on the small tile;
// the before/after tab rows on the marquee. Every font is embedded from store/fonts, so the PNGs never depend on the
// fonts installed on the machine.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Brand } from './brand';
import type { Captures, TabStripGroup } from './capture';
import { fitBox, type Fit } from './fit';

const FONTS = resolve(import.meta.dirname, 'fonts');

export interface Captions {
  screenshots: { file: string; headline: string; sub: string }[];
  smallTile: { chips: string[] };
  marquee: { tagline: string; before: string; after: string; legend: { duplicate: string; finished: string } };
}

/** The faces the kit uses, by family and weight; each must load or the render fails (generate.ts checks). */
export const FACES: [family: string, file: string, weight: number][] = [
  ['Bricolage Grotesque', 'bricolage-grotesque-latin-500-normal.woff2', 500],
  ['Bricolage Grotesque', 'bricolage-grotesque-latin-700-normal.woff2', 700],
  ['Bricolage Grotesque', 'bricolage-grotesque-latin-800-normal.woff2', 800],
  ['IBM Plex Sans', 'ibm-plex-sans-latin-400-normal.woff2', 400],
  ['IBM Plex Sans', 'ibm-plex-sans-latin-500-normal.woff2', 500],
  ['IBM Plex Sans', 'ibm-plex-sans-latin-600-normal.woff2', 600],
  ['IBM Plex Mono', 'ibm-plex-mono-latin-400-normal.woff2', 400],
  ['IBM Plex Mono', 'ibm-plex-mono-latin-500-normal.woff2', 500],
];

const fontCss = (): string => FACES.map(([family, file, weight]) => `@font-face { font-family: "${family}"; font-weight: ${weight};
  font-style: normal; src: url(data:font/woff2;base64,${readFileSync(join(FONTS, file)).toString('base64')}) format("woff2"); }`).join('\n');

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const png = (b: Buffer): string => `data:image/png;base64,${b.toString('base64')}`;
const svgUri = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
/** CSS size of a 2x capture (PNG header: width at byte 16, height at 20). */
const cssSize = (b: Buffer): { w: number; h: number } => ({ w: b.readUInt32BE(16) / 2, h: b.readUInt32BE(20) / 2 });
const named = (s: string, brand: Brand): string => esc(s.replaceAll('{name}', brand.name));

const INK = '#1A1E24';
const MUTED = '#5A6371';
const LINE = '#D3D8DF';
const GROUND = '#ECEEF1';
const ACCENT = '#E8620C';
/** Chrome's tab group colors (light theme). */
const GROUP_COLORS: Record<string, string> = {
  grey: '#5F6368', blue: '#1A73E8', red: '#D93025', yellow: '#F9AB00', green: '#188038', pink: '#D01884',
  purple: '#9334E6', cyan: '#007B83', orange: '#FA903E',
};

export function page(body: string, { width, height }: { width: number; height: number }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontCss()}
* { box-sizing: border-box; margin: 0; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
body { position: relative; -webkit-font-smoothing: antialiased; font-family: "IBM Plex Sans", sans-serif; color: ${INK}; }
</style></head><body>${body}</body></html>`;
}

/* ---------- Screenshots (1280×800) ---------- */

const SHOT_CSS = `
  body { background: ${GROUND}; }
  .copy { position: absolute; left: 72px; width: 470px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
  .kicker { display: flex; align-items: center; gap: 12px; font: 700 24px/1 "Bricolage Grotesque"; margin-bottom: 30px; }
  .kicker img { width: 44px; height: 44px; }
  h1 { font: 800 60px/1.04 "Bricolage Grotesque"; letter-spacing: -0.015em; text-wrap: balance; }
  .rule { width: 56px; height: 5px; border-radius: 3px; background: ${ACCENT}; margin: 28px 0 24px; }
  p.sub { font: 400 23px/1.5 "IBM Plex Sans"; color: ${MUTED}; text-wrap: pretty; }
  .ui { position: absolute; border-radius: 14px; background: #fff; overflow: hidden;
    box-shadow: 0 1px 0 ${LINE}, 0 24px 56px rgb(26 30 36 / 0.16), 0 0 0 1px ${LINE}; }
  .ui img { display: block; width: 100%; height: 100%; }
  .label { position: absolute; font: 500 13px/1 "IBM Plex Mono"; letter-spacing: 0.08em; text-transform: uppercase; color: ${MUTED}; }
`;

function copy(c: Captions['screenshots'][number], brand: Brand, top = 0): string {
  return `<div class="copy" style="top:${top}px">
    <div class="kicker"><img src="${svgUri(brand.iconSvg)}" alt="">${esc(brand.name)}</div>
    <h1>${named(c.headline, brand)}</h1>
    <div class="rule"></div>
    <p class="sub">${named(c.sub, brand)}</p>
  </div>`;
}

/** A capture in the right-hand area (x 600–1216, y top–bottom), at most `zoom` times its CSS size, centered. */
function ui(shot: Buffer, { top = 56, bottom = 744, left = 600, right = 1216, zoom = 1.25 } = {}): string {
  const { w, h } = cssSize(shot);
  const { x, y, width: dw, height: dh } = fitBox(w, h, { left, top, right, bottom }, zoom);
  return `<div class="ui" style="left:${x}px; top:${y}px; width:${dw}px; height:${dh}px"><img src="${png(shot)}" alt=""></div>`;
}

/** Chrome's tab strip as the group rules left it (read from chrome.tabGroups): group chips, then their tabs. */
function tabStrip(strip: TabStripGroup[], { left, top, width }: { left: number; top: number; width: number }): string {
  const tabs = strip.reduce((n, g) => n + g.tabs.length, 0);
  const chips = strip.filter((g) => g.title).length;
  const tabW = Math.floor((width - 24 - chips * 70 - (tabs + chips) * 4) / tabs);
  const items = strip.flatMap((g) => {
    const c = GROUP_COLORS[g.color] ?? GROUP_COLORS.grey;
    const chip = g.title ? [`<span class="chip" style="background:${c}">${esc(g.title)}</span>`] : [];
    return [...chip, ...g.tabs.map((t, i) => `<span class="tab${i === 0 && g === strip[0] ? ' active' : ''}" style="width:${tabW}px; --g:${g.title ? c : 'transparent'}"><i></i><b>${esc(t)}</b></span>`)];
  });
  return `<style>
    .strip { position: absolute; left: ${left}px; top: ${top}px; width: ${width}px; height: 52px; border-radius: 12px;
      box-shadow: 0 0 0 1px ${LINE}, 0 12px 32px rgb(26 30 36 / 0.10); overflow: hidden;
      background: #DEE1E6; display: flex; align-items: flex-end; gap: 4px; padding: 0 12px; }
    .strip .chip { flex: none; align-self: center; margin-top: 6px; min-width: 66px; text-align: center; color: #fff;
      font: 500 14px/28px "IBM Plex Sans"; border-radius: 8px; padding: 0 10px; }
    .strip .tab { position: relative; flex: none; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px;
      font: 400 13.5px/1 "IBM Plex Sans"; color: #3C4043; border-radius: 10px 10px 0 0; background: #EDEFF2; }
    .strip .tab b { font-weight: 400; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .strip .tab.active { background: #fff; color: ${INK}; }
    .strip .tab::after { content: ""; position: absolute; left: 6px; right: 6px; bottom: 0; height: 3px; border-radius: 2px 2px 0 0; background: var(--g); }
    .strip .tab i { flex: none; width: 14px; height: 14px; border-radius: 50%; background: #9AA0A6; }
  </style><div class="strip">${items.join('')}</div>`;
}

export function screenshots(shots: Captures, captions: Captions, brand: Brand): { file: string; html: string }[] {
  const [dup, groups, projects, merged, preview] = captions.screenshots;
  if (!dup || !groups || !projects || !merged || !preview) throw new Error('store:assets: captions.json needs five screenshots');
  const frame = (body: string) => `<style>${SHOT_CSS}</style>${body}`;
  return [
    { file: dup.file, html: frame(copy(dup, brand) + ui(shots.duplicates, { zoom: 1.2 })) },
    {
      file: groups.file,
      html: frame(copy(groups, brand, 96) + tabStrip(shots.strip, { left: 72, top: 48, width: 1136 })
        + ui(shots.rules, { top: 140, bottom: 768, zoom: 1 })),
    },
    { file: projects.file, html: frame(copy(projects, brand) + ui(shots.projects, { left: 640, right: 1176, zoom: 1.3 })) },
    { file: merged.file, html: frame(copy(merged, brand) + ui(shots.merged, { zoom: 1.2 })) },
    { file: preview.file, html: frame(copy(preview, brand) + ui(shots.preview, { zoom: 1.1 })) },
  ];
}

/* ---------- Promo tiles (the launch kit's designs) ---------- */

const icon = (brand: Brand, x: number, y: number, size: number): string =>
  `<image href="${svgUri(brand.iconSvg)}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;

/** The small tile (440×280): icon, name, tagline and three chips. Text that would run off the tile is squeezed to fit. */
export function smallTile(brand: Brand, captions: Captions): string {
  const chipColors = ['#1A73E8', ACCENT, '#188038'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280" data-fit>
    <rect width="440" height="280" fill="${INK}"/>
    ${icon(brand, 36, 76, 115.2)}
    <text data-max="244" x="172" y="128" fill="#FFFFFF" font-family="Bricolage Grotesque" font-weight="800" font-size="44">${esc(brand.name)}</text>
    <text data-max="242" x="174" y="164" fill="#AEB6C2" font-family="IBM Plex Sans" font-size="18">${esc(brand.tagline)}</text>
    <g data-chips="${chipColors.join(',')}" transform="translate(174 186)">${captions.smallTile.chips.map((c) =>
      `<text fill="#fff" font-family="IBM Plex Mono" font-size="11" text-anchor="middle" y="14">${esc(c)}</text>`).join('')}</g>
  </svg>`;
}

/** The marquee (1400×560): name, positioning line, and the before/after tab rows. */
export function marquee(brand: Brand, captions: Captions): string {
  const m = captions.marquee;
  // Before: three copies of one pull request (one is its Files tab), a finished OAuth callback, a Meet tab whose
  // call ended. 1 = duplicate, 2 = finished. After: grouped by repo in the configured order.
  const before: [string, number][] = [['acme/api #412', 1], ['Google Meet', 2], ['acme/web', 0], ['acme/api #412 · Files', 1],
    ['localhost:3000/callback', 2], ['docs: URLPattern', 0], ['acme/api #412', 1], ['acme/web #88', 0]];
  const after: [string, string, string[]][] = [['api', '#1A73E8', ['acme/api #412']], ['web', '#188038', ['acme/web', 'acme/web #88']],
    ['docs', '#9334E6', ['URLPattern']]];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="560" viewBox="0 0 1400 560" data-fit>
    <rect width="1400" height="560" fill="${INK}"/>
    ${icon(brand, 1180, 64, 140)}
    <text data-max="1060" x="80" y="150" fill="#FFFFFF" font-family="Bricolage Grotesque" font-weight="800" font-size="76">${esc(brand.name)}</text>
    <text data-max="1060" x="82" y="204" fill="#AEB6C2" font-family="IBM Plex Sans" font-size="28">${named(m.tagline, brand)}</text>
    <text x="82" y="296" fill="#6F7987" font-family="IBM Plex Mono" font-size="18" letter-spacing="2">${esc(m.before.toUpperCase())}</text>
    <g data-row="before" data-tabs='${esc(JSON.stringify(before))}' data-legend='${esc(JSON.stringify(m.legend))}' transform="translate(80 312)"></g>
    <text x="82" y="446" fill="#6F7987" font-family="IBM Plex Mono" font-size="18" letter-spacing="2">${esc(m.after.toUpperCase())}</text>
    <g data-row="after" data-groups='${esc(JSON.stringify(after))}' transform="translate(80 462)"></g>
  </svg>`;
}

/**
 * Runs in the page once the fonts have loaded: lays out the chips and tab rows from the measured text (the kit
 * estimated widths from character counts), and squeezes any `data-max` text wider than its room. Returns the
 * problems found (text still out of bounds), which fail the render. The fitting rules are store/fit.ts, installed
 * in the page as `storeFit` (fitScript) first.
 */
export function layoutInPage(): string[] {
  const fit = (globalThis as unknown as { storeFit: Fit }).storeFit;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (t: string, a: Record<string, string | number>, p: Element): SVGElement => {
    const e = document.createElementNS(NS, t);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
    p.appendChild(e);
    return e;
  };
  const text = (p: Element, s: string, a: Record<string, string | number>): SVGTextElement => {
    const t = el('text', a, p) as SVGTextElement;
    t.textContent = s;
    return t;
  };
  const tabPath = (x: number, w: number, h: number) => `M${x} ${h}V12Q${x} 0 ${x + 12} 0H${x + w - 12}Q${x + w} 0 ${x + w} 12V${h}Z`;
  const MONO = 'IBM Plex Mono';
  const problems: string[] = [];

  for (const t of document.querySelectorAll<SVGTextElement>('text[data-max]')) {
    const max = Number(t.dataset.max);
    const length = fit.squeeze(t.getComputedTextLength(), max);
    if (length !== undefined) { t.setAttribute('textLength', String(length)); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
  }

  for (const g of document.querySelectorAll<SVGGElement>('g[data-chips]')) {
    const colors = g.dataset.chips!.split(',');
    let x = 0;
    for (const [i, t] of [...g.querySelectorAll('text')].entries()) {
      const w = Math.max(58, Math.ceil(t.getComputedTextLength()) + 22);
      const r = document.createElementNS(NS, 'rect');
      for (const [k, v] of Object.entries({ x, width: w, height: 20, rx: 10, fill: colors[i] ?? colors[0]! })) r.setAttribute(k, String(v));
      g.insertBefore(r, t);
      t.setAttribute('x', String(x + w / 2));
      x += w + 6;
    }
  }

  // Tabs: the measured title plus 16 px either side, at least 96 px; a row wider than its room shrinks to fit.
  const row = (g: SVGGElement, room: number, draw: (scale: number) => number) => {
    const w = draw(1);
    const k = fit.rowScale(w, room);
    if (k < 1) { g.replaceChildren(); draw(k); }
  };
  const measure = (s: string, size: number) => {
    const t = text(document.querySelector('svg')!, s, { 'font-family': MONO, 'font-size': size, x: -9999, y: -9999 });
    const w = t.getComputedTextLength();
    t.remove();
    return w;
  };
  const tabW = (s: string, k: number) => Math.max(96 * k, measure(s, 15 * k) + 32 * k);

  const b = document.querySelector<SVGGElement>('g[data-row="before"]');
  if (b) {
    const tabs = JSON.parse(b.dataset.tabs!) as [string, number][];
    const legend = JSON.parse(b.dataset.legend!) as { duplicate: string; finished: string };
    row(b, 1240, (k) => {
      let x = 0;
      for (const [t, mark] of tabs) {
        const w = tabW(t, k);
        el('path', { d: tabPath(x, w, 52), fill: '#3A424C' }, b);
        text(b, t, { x: x + 16 * k, y: 33, fill: mark ? '#FFB27A' : '#C7CED8', 'font-family': MONO, 'font-size': 15 * k });
        if (mark) el('rect', { x: x + 2, y: 48, width: w - 4, height: 4, fill: mark === 1 ? '#E8620C' : '#D93025' }, b);
        x += w + 6;
      }
      return x - 6;
    });
    const l = text(b, '', { x: 0, y: 84, fill: '#8B95A3', 'font-family': 'IBM Plex Sans', 'font-size': 16 });
    for (const [s, fill, dx] of [['orange', '#FF8A3D', 0], [legend.duplicate, '', 5], ['red', '#F07068', 22], [legend.finished, '', 5]] as const) {
      const span = document.createElementNS(NS, 'tspan');
      if (fill) span.setAttribute('fill', fill);
      if (dx) span.setAttribute('dx', String(dx));
      span.textContent = s;
      l.appendChild(span);
    }
  }

  const a = document.querySelector<SVGGElement>('g[data-row="after"]');
  if (a) {
    const groups = JSON.parse(a.dataset.groups!) as [string, string, string[]][];
    row(a, 1240, (k) => {
      let x = 0;
      for (const [g, c, tabs] of groups) {
        const cw = measure(g, 16 * k) + 34 * k;
        el('rect', { x, y: 12, width: cw, height: 30, rx: 15, fill: c }, a);
        text(a, g, { x: x + cw / 2, y: 33, fill: '#fff', 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 16 * k, 'font-weight': 500 });
        x += cw + 6;
        for (const t of tabs) {
          const w = tabW(t, k);
          el('path', { d: tabPath(x, w, 52), fill: '#2A3038' }, a);
          el('rect', { x, y: 48, width: w, height: 4, fill: c }, a);
          text(a, t, { x: x + 16 * k, y: 33, fill: '#E7EAEE', 'font-family': MONO, 'font-size': 15 * k });
          x += w + 6;
        }
        x += 18;
      }
      return x - 24;
    });
  }

  // Nothing may end outside the tile.
  const svg = document.querySelector('svg');
  if (svg) {
    const box = svg.getBoundingClientRect();
    for (const t of svg.querySelectorAll('text, path, rect, image')) {
      const r = t.getBoundingClientRect();
      if (r.width === 0) continue;
      if (fit.outside(r, box)) {
        problems.push(`${t.tagName} "${t.textContent ?? ''}" runs off the tile`);
      }
    }
  }
  return problems;
}
