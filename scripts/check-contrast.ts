// WCAG AA guard for the theme color tokens: every text token must reach 4.5:1 on every background token, per theme.
// Usage: npm run check:contrast [-- file ...]   (default: the two places that define the tokens, see FILES)
// Prints one line per failing pair and exits 1 on any; 0 when every pair passes.
// A file's light theme is its top-level `:root` (or Svelte `:global(:root)`) rule; its dark theme is that rule inside
// `@media (prefers-color-scheme: dark)`, on top of the light values (the cascade). A .svelte file is read from its
// <style> only. Any other theme structure is refused rather than half-read: a custom property declared anywhere else
// (another selector, another at-rule, a nested rule), an escaped custom property name, [data-theme], a light media
// query, two root rules.
import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';

/** The popup and side panel import tokens.css; the options page declares the same tokens in its App.svelte. */
const FILES = ['src/ui/tokens.css', 'src/entrypoints/options/App.svelte'];
export const TEXT = ['--text', '--muted', '--accent', '--danger', '--ok'] as const;
export const BACKGROUNDS = ['--bg', '--surface', '--hover'] as const;
/** Tokens that are neither text nor a background, so have no pair to check. Any token in none of the lists fails. */
export const OTHER = ['--border'] as const;
export const AA = 4.5;

/**
 * Pairs that never occur in the UI and so may fail. Every entry needs a comment saying why it cannot occur. All 15
 * pairs occur or pass today: text sits on hovered rows (--hover), cards and toasts (--surface) and the page (--bg).
 * An entry that names an unknown token, or whose pair now passes, fails the check so the list cannot go stale.
 */
export type Exception = { theme: 'light' | 'dark'; text: string; bg: string };
export const EXCEPTIONS: Exception[] = [];

export type Theme = Record<string, string>;
export type Rgb = [number, number, number];

/** `#rgb` or `#rrggbb` as 0..1 channels; throws on any other format. */
export function parseColor(value: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`cannot parse color "${value}" (only #rgb and #rrggbb are supported)`);
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

/** WCAG 2.x relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio of two colors (1..21, order does not matter). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(parseColor(a)), luminance(parseColor(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const ROOT = /^(?::root|:global\(\s*:root\s*\))$/;
const DARK = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/;
const DECLARATION = /(--[\w-]+)\s*:/;
/**
 * A comment (unclosed runs to the end, as in CSS), a quoted string, or an unquoted `url(...)`, whose `/*` (as in
 * `url(img/*.png)`) does not start a comment.
 */
const COMMENT_OR_STRING = /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\burl\(\s*(?:[^"'()\\\s]|\\[\s\S])*\s*\)/gi;
/** A custom property name with an escape (`--\61 ccent`, `--a\:b`), which the declaration patterns cannot read. */
const ESCAPED_NAME = /(?<![\w-])--[\w-]*\\/;

/** `--name: value` declarations of one rule body. */
function declarations(body: string): Theme {
  const out: Theme = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out[m[1]!] = m[2]!;
  return out;
}

type Rule = { prelude: string; body: string };

/** The `prelude { body }` blocks at the top level of `css`, and the text outside them (statements such as @import). */
function split(css: string, where: string): { rules: Rule[]; loose: string } {
  const rules: Rule[] = [];
  let loose = '';
  let depth = 0;
  let from = 0;
  let open = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth++ === 0) open = i;
    } else if (css[i] === '}') {
      if (depth === 0) throw new Error(`${where}: unmatched }`);
      if (--depth === 0) {
        const head = css.slice(from, open);
        const cut = head.lastIndexOf(';') + 1;
        loose += head.slice(0, cut);
        rules.push({ prelude: head.slice(cut).trim().replace(/\s+/g, ' '), body: css.slice(open + 1, i) });
        from = i + 1;
      }
    }
  }
  if (depth) throw new Error(`${where}: unclosed {`);
  return { rules, loose: loose + css.slice(from) };
}

/** Throws if `text` declares a custom property: it would sit outside the two rules the themes are read from. */
function refuse(text: string, where: string): void {
  const m = DECLARATION.exec(text);
  if (m) throw new Error(`${m[1]} is declared ${where}, outside the light and dark :root rules; teach check-contrast it`);
}

/**
 * The single root rule among `rules` (`{}` if none), refusing custom properties in every other rule and in `loose`.
 * `inside` names the enclosing block for messages; `skip` is a rule the caller handles (the dark block).
 */
function rootRule({ rules, loose }: { rules: Rule[]; loose: string }, inside: string, skip?: Rule): Theme {
  const roots = rules.filter((r) => ROOT.test(r.prelude));
  if (roots.length > 1) throw new Error(`${inside}: ${roots.length} :root rules, expected one`);
  const at = inside === 'top level' ? 'at the top level' : `inside the ${inside}`;
  refuse(loose, `${at}, outside any rule`);
  for (const r of rules) if (r !== roots[0] && r !== skip) refuse(r.body, `in "${r.prelude}" ${at}`);
  if (!roots.length) return {};
  if (roots[0]!.body.includes('{')) throw new Error(`${inside}: nested rule inside "${roots[0]!.prelude}"`);
  return declarations(roots[0]!.body);
}

/**
 * The CSS of `source`, decided by the name of its `file`: a .svelte file's single <style> (its script and markup are
 * not CSS), any other file all of it.
 */
function styleOf(source: string, file: string): string {
  if (!file.endsWith('.svelte')) return source;
  // Svelte's own parser finds the <style> (a component has at most one; it refuses two or an unclosed one).
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, { modern: true });
  } catch (e) {
    throw new Error(`cannot parse the component: ${(e as Error).message}`);
  }
  if (!ast.css) throw new Error('0 <style> blocks, expected one');
  return ast.css.content.styles;
}

/** The light and dark token values a stylesheet (or, for a `file` ending in .svelte, its <style>) declares. */
export function parseThemes(source: string, file = ''): { light: Theme; dark: Theme } {
  const css = styleOf(source, file).replace(COMMENT_OR_STRING, (m) => {
    if (m.startsWith('/*')) return '';
    return /^url/i.test(m) ? 'url()' : '""';
  });
  const escaped = ESCAPED_NAME.exec(css);
  if (escaped) throw new Error(`${escaped[0]}... is an escaped custom property name; unescape it or teach check-contrast it`);
  if (/data-theme|prefers-color-scheme\s*:\s*light/.test(css)) {
    throw new Error('unsupported theme selector ([data-theme] or prefers-color-scheme: light); teach check-contrast it');
  }
  const top = split(css, 'top level');
  const media = top.rules.filter((r) => DARK.test(r.prelude));
  if (media.length > 1) throw new Error(`${media.length} prefers-color-scheme: dark blocks, expected at most one`);
  const light = rootRule(top, 'top level', media[0]);
  const dark = media.length ? rootRule(split(media[0]!.body, 'dark block'), 'dark block') : {};
  return { light, dark: { ...light, ...dark } };
}

/** Each token the `themes` declare that is in none of TEXT, BACKGROUNDS and OTHER, once however many declare it. */
export function unknownTokens(...themes: Theme[]): string[] {
  const known: readonly string[] = [...TEXT, ...BACKGROUNDS, ...OTHER];
  const tokens = new Set(themes.flatMap((t) => Object.keys(t)));
  return [...tokens]
    .filter((token) => !known.includes(token))
    .map((token) => `${token} is not a known token; add it to TEXT, BACKGROUNDS or OTHER in scripts/check-contrast.ts`);
}

/**
 * Problems of one theme as messages: each text/background pair below AA (minus `exceptions`), each token that is not
 * defined, each color that cannot be parsed, each exception that is unknown or no longer needed. An undefined token is
 * a failure, not a skip: the components would fall back to whatever their var() says (that is how #215's --ok shipped
 * unchecked). Unknown tokens are checked per file, by unknownTokens.
 */
export function checkTheme(name: 'light' | 'dark', theme: Theme, exceptions: Exception[] = EXCEPTIONS): string[] {
  const problems: string[] = [];
  const ok = (token: string) => {
    if (theme[token] === undefined) return problems.push(`${name}: ${token} is not defined`), false;
    try {
      parseColor(theme[token]!);
      return true;
    } catch (e) {
      return problems.push(`${name}: ${token}: ${(e as Error).message}`), false;
    }
  };
  const bgs: readonly string[] = BACKGROUNDS.filter(ok);
  const texts: readonly string[] = TEXT.filter(ok);
  const excepted = (text: string, bg: string) => exceptions.some((x) => x.theme === name && x.text === text && x.bg === bg);
  for (const text of texts) {
    for (const bg of bgs) {
      const ratio = contrast(theme[text]!, theme[bg]!);
      if (ratio >= AA || excepted(text, bg)) continue;
      problems.push(`${name}: ${text} ${theme[text]} on ${bg} ${theme[bg]} is ${ratio.toFixed(2)}:1, below ${AA}:1`);
    }
  }
  for (const x of exceptions.filter((x) => x.theme === name)) {
    if (!(TEXT as readonly string[]).includes(x.text) || !(BACKGROUNDS as readonly string[]).includes(x.bg)) {
      problems.push(`${name}: exception ${x.text} on ${x.bg} names a token that is not in TEXT or BACKGROUNDS`);
    } else if (texts.includes(x.text) && bgs.includes(x.bg)) {
      const ratio = contrast(theme[x.text]!, theme[x.bg]!);
      if (ratio >= AA) problems.push(`${name}: exception ${x.text} on ${x.bg} now passes (${ratio.toFixed(2)}:1); remove it`);
    }
  }
  return problems;
}

/** Problems of one file (its unknown tokens, then both themes), or the parse error. */
export function checkFile(file: string): string[] {
  try {
    const { light, dark } = parseThemes(readFileSync(file, 'utf8'), file);
    return [...unknownTokens(light, dark), ...checkTheme('light', light), ...checkTheme('dark', dark)];
  } catch (e) {
    return [(e as Error).message];
  }
}

export default function main(args: string[]): number {
  const files = args.length ? args : FILES;
  let bad = 0;
  for (const f of files) {
    const problems = checkFile(f);
    for (const p of problems) console.error(`${f}: ${p}`);
    if (problems.length) bad++;
  }
  const pairs = TEXT.length * BACKGROUNDS.length;
  console.log(`${files.length - bad}/${files.length} file(s) pass: ${pairs} text/background pairs per theme at ${AA}:1`);
  return bad ? 1 : 0;
}
