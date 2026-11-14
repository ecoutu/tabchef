import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import main, {
  checkFile, checkTheme, contrast, luminance, parseColor, parseThemes, unknownTokens, type Theme,
} from '../../scripts/check-contrast';

const decls = (t: Theme) => Object.entries(t).map(([k, v]) => `${k}: ${v};`).join(' ');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
/** Writes `content` to a fresh temp file named `name` and returns its path. */
function tempFile(content: string, name = 'tokens.css'): string {
  const dir = mkdtempSync(join(tmpdir(), 'contrast-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

const PASSING: Theme = {
  '--bg': '#fff', '--surface': '#f6f6f8', '--hover': '#eef0f4',
  '--text': '#1c1e24', '--muted': '#656a76', '--accent': '#2f63e6', '--danger': '#b3261e', '--ok': '#177d36',
};

describe('contrast maths (WCAG 2.x)', () => {
  it('parses #rgb and #rrggbb, case-insensitively', () => {
    expect(parseColor('#fff')).toEqual([1, 1, 1]);
    expect(parseColor('#000000')).toEqual([0, 0, 0]);
    expect(parseColor('#FF8a80')).toEqual(parseColor('#ff8a80'));
    expect(parseColor('#abc')).toEqual(parseColor('#aabbcc'));
  });
  it.each(['rgb(0 0 0)', 'red', '#ffff', '#12345', 'var(--x)', 'color-mix(in srgb, #fff, #000)'])('throws on %s', (c) => {
    expect(() => parseColor(c)).toThrow(/cannot parse color/);
  });
  it('luminance: black 0, white 1, sRGB linearisation', () => {
    expect(luminance(parseColor('#000'))).toBe(0);
    expect(luminance(parseColor('#fff'))).toBeCloseTo(1, 10);
    expect(luminance(parseColor('#808080'))).toBeCloseTo(0.2159, 4);
  });
  it('contrast: 21 for black on white, 1 for a color on itself, symmetric', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 10);
    expect(contrast('#3b6df0', '#3b6df0')).toBe(1);
    expect(contrast('#fff', '#188038')).toBeCloseTo(contrast('#188038', '#fff'), 10);
  });
  it('matches the known ratios of #215 (the old Done green)', () => {
    expect(contrast('#1e8e3e', '#ffffff').toFixed(2)).toBe('4.21');
    expect(contrast('#1e8e3e', '#1b1d22').toFixed(2)).toBe('4.01');
  });
});

describe('parseThemes', () => {
  it('reads :root as light and the dark media query on top of it', () => {
    const css = `/* :root { --text: #f00; } in a comment is ignored */
:root {
  --bg: #fff; --text: #111; --border: #ccc;
  --accent: #36c
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #000; --text: #eee; }
}
body { background: var(--bg); }`;
    const { light, dark } = parseThemes(css);
    expect(light).toEqual({ '--bg': '#fff', '--text': '#111', '--border': '#ccc', '--accent': '#36c' });
    expect(dark).toEqual({ '--bg': '#000', '--text': '#eee', '--border': '#ccc', '--accent': '#36c' });
  });
  it('reads Svelte :global(:root) rules', () => {
    const svelte = `<main></main>
<style>
  :global(:root) { --bg: #fff; }
  @media (prefers-color-scheme: dark) { :global(:root) { --bg: #1b1d22; } }
  :global(body) { margin: 0; }
</style>`;
    expect(parseThemes(svelte, 'App.svelte')).toEqual({ light: { '--bg': '#fff' }, dark: { '--bg': '#1b1d22' } });
  });
  const dark = '@media (prefers-color-scheme: dark) { :root { --bg: #000; } }';
  it.each([
    ['[data-theme]', ':root { --bg: #fff; } [data-theme="dark"] { --bg: #000; }', /data-theme/],
    ['two :root rules', ':root { --bg: #fff; } :root { --bg: #000; }', /top level: 2 :root rules/],
    ['an unclosed {', '@media (prefers-color-scheme: dark) { :root { --bg: #000; }', /top level: unclosed \{/],
    ['an unmatched }', ':root { --bg: #fff; } }', /top level: unmatched \}/],
    ['an unclosed comment, which runs to the end', ':root { --bg: #fff; /* }', /top level: unclosed \{/],
    ['a light media query', ':root { --bg: #fff; } @media (prefers-color-scheme: light) { :root { --bg: #fff; } }', /prefers-color-scheme: light/],
    ['two dark blocks', `:root { --bg: #fff; } ${dark} ${dark}`, /2 prefers-color-scheme: dark blocks/],
    ['two :root rules in the dark block', '@media (prefers-color-scheme: dark) { :root { --bg: #000; } :root { --bg: #111; } }', /dark block: 2 :root rules/],
    ['a rule nested inside :root', ':root { --bg: #fff; &.x { --bg: #000; } }', /top level: nested rule inside ":root"/],
    ['a rule nested inside the dark :root', `:root { --bg: #fff; } @media (prefers-color-scheme: dark) { :root { --bg: #000; &.x { --bg: #111; } } }`, /dark block: nested rule inside ":root"/],
    ['an escaped custom property name (hex escape)', ':root { --bg: #fff; } html { --\\61 ccent: #9ab; }', /--\\\.\.\. is an escaped custom property name/],
    ['an escaped custom property name (escaped :)', ':root { --bg: #fff; --a\\:b: #000; }', /--a\\\.\.\. is an escaped custom property name/],
  ])('refuses %s', (_, css, error) => {
    expect(() => parseThemes(css)).toThrow(error);
  });
  // A dark rule it does not recognise used to be skipped, so the dark theme was checked with the light values.
  it.each(['html:root', ':root, :host', 'html', ':root:not(.x)', ':global(html)'])('refuses a dark block whose rule is %s', (sel) => {
    const css = `:root { ${decls(PASSING)} } @media (prefers-color-scheme: dark) { ${sel} { --text: #333; --bg: #1b1d22; } }`;
    expect(() => parseThemes(css)).toThrow(/--text is declared in ".+" inside the dark block/);
  });
  // A token redefined under another selector overrides the :root value in the browser, but was never read.
  it.each([
    ['another rule', 'html { --accent: #9ab; }', /--accent is declared in "html"/],
    ['a selector list', ':root, :host { --accent: #9ab; }', /--accent is declared in ":root, :host"/],
    ['another at-rule', '@supports (display: grid) { :root { --accent: #9ab; } }', /--accent is declared in "@supports/],
    ['another dark query', '@media screen and (prefers-color-scheme: dark) { :root { --accent: #9ab; } }', /--accent is declared in "@media screen/],
    ['the top level, outside any rule', '--accent: #9ab;', /--accent is declared at the top level/],
    ['the dark block, outside any rule', '@media (prefers-color-scheme: dark) { --accent: #9ab; }', /--accent is declared inside the dark block, outside any rule/],
  ])('refuses a token declared in %s', (_, extra, error) => {
    expect(() => parseThemes(`:root { ${decls(PASSING)} } ${extra}`)).toThrow(error);
  });
  it('accepts a dark block with no token rule (dark = light) and rules that only use the tokens', () => {
    const css = `:root { --bg: #fff; } a { color: var(--accent, #000); } @media (prefers-color-scheme: dark) { img { opacity: .8; } }`;
    expect(parseThemes(css)).toEqual({ light: { '--bg': '#fff' }, dark: { '--bg': '#fff' } });
  });
  it('reads only the <style> of a .svelte file, so "/*" in a script cannot hide rules', () => {
    const svelte = `<script>const glob = 'src/*';</script>
<p>{glob}</p>
<style>
  :global(:root) { --bg: #fff; }
  /* a note */
  :global(html) { --bg: #000; }
</style>`;
    expect(() => parseThemes(svelte, 'App.svelte')).toThrow(/--bg is declared in ":global\(html\)"/);
  });
  it.each([
    ['two <style> blocks', '<style>:global(:root) { --bg: #fff; }</style>\n<style>p { margin: 0; }</style>', /cannot parse the component: .*single top-level `<style>`/],
    ['no <style>', '<p>hi</p>', /0 <style> blocks, expected one/],
    ['an unclosed <style>', '<style>:global(:root) { --bg: #fff; }</style>\n<style>:global(html) { --bg: #000; }', /cannot parse the component: Expected token <\/style/],
  ])('refuses a .svelte file with %s', (_, svelte, error) => {
    expect(() => parseThemes(svelte, 'App.svelte')).toThrow(error);
  });
  it('reads a .css file whole, even when a comment mentions <style>', () => {
    const css = `/* App.svelte copies these into its <style> */\n:root { --bg: #fff; }`;
    expect(parseThemes(css, 'src/ui/tokens.css')).toEqual({ light: { '--bg': '#fff' }, dark: { '--bg': '#fff' } });
    expect(checkFile(tempFile(`${css.replace('--bg: #fff;', decls(PASSING))}`))).toEqual([]);
  });
  it.each([
    ['double', `"} --bg: #000; {"`],
    ['single', `'} --bg: #000; {'`],
  ])('ignores token-like text and braces inside %s-quoted CSS strings', (_, str) => {
    expect(parseThemes(`:root { --bg: #fff; } a::after { content: ${str}; }`).light).toEqual({ '--bg': '#fff' });
  });
  it('does not read /* in an unquoted url() as a comment', () => {
    const css = ':root { --bg: #fff; } a { background: url(img/*.png); } @media (prefers-color-scheme: dark) { :root { --bg: #000; } }';
    expect(parseThemes(css)).toEqual({ light: { '--bg': '#fff' }, dark: { '--bg': '#000' } });
  });
});

describe('checkTheme', () => {
  it('passes when every text token reaches 4.5:1 on every background', () => {
    expect(checkTheme('light', PASSING)).toEqual([]);
  });
  it('lists each failing pair with its ratio', () => {
    expect(checkTheme('light', { ...PASSING, '--ok': '#1e8e3e' })).toEqual([
      'light: --ok #1e8e3e on --bg #fff is 4.21:1, below 4.5:1',
      'light: --ok #1e8e3e on --surface #f6f6f8 is 3.90:1, below 4.5:1',
      'light: --ok #1e8e3e on --hover #eef0f4 is 3.69:1, below 4.5:1',
    ]);
  });
  it('fails on an undefined token and on a color it cannot parse', () => {
    const noOk = { ...PASSING };
    delete noOk['--ok'];
    expect(checkTheme('dark', noOk)).toEqual(['dark: --ok is not defined']);
    expect(checkTheme('dark', { ...PASSING, '--hover': 'hsl(0 0% 90%)' })).toEqual([
      'dark: --hover: cannot parse color "hsl(0 0% 90%)" (only #rgb and #rrggbb are supported)',
    ]);
  });
  it('fails on a token in none of the known lists, once per file, but knows --border', () => {
    const unknown = '--link is not a known token; add it to TEXT, BACKGROUNDS or OTHER in scripts/check-contrast.ts';
    expect(unknownTokens({ ...PASSING, '--border': '#d4d7de' })).toEqual([]);
    expect(unknownTokens({ ...PASSING, '--link': '#9ab' }, { ...PASSING, '--link': '#9ab' })).toEqual([unknown]);
    const file = tempFile(`:root { ${decls(PASSING)} --link: #9ab; } @media (prefers-color-scheme: dark) { :root { --bg: #fff; } }`);
    expect(checkFile(file)).toEqual([unknown]);
  });
  it('validates exceptions: unknown tokens fail, a pair that now passes must be removed', () => {
    const exceptions = [
      { theme: 'light' as const, text: '--ok', bg: '--bg' },
      { theme: 'light' as const, text: '--text', bg: '--surface' },
      { theme: 'light' as const, text: '--border', bg: '--bg' },
      { theme: 'dark' as const, text: '--text', bg: '--bg' },
    ];
    expect(checkTheme('light', { ...PASSING, '--ok': '#1e8e3e' }, exceptions)).toEqual([
      'light: --ok #1e8e3e on --surface #f6f6f8 is 3.90:1, below 4.5:1',
      'light: --ok #1e8e3e on --hover #eef0f4 is 3.69:1, below 4.5:1',
      'light: exception --text on --surface now passes (15.43:1); remove it',
      'light: exception --border on --bg names a token that is not in TEXT or BACKGROUNDS',
    ]);
  });
});

describe('the repo tokens', () => {
  it('tokens.css and the options page App.svelte declare identical themes', () => {
    const css = parseThemes(readFileSync('src/ui/tokens.css', 'utf8'), 'src/ui/tokens.css');
    expect(parseThemes(readFileSync('src/entrypoints/options/App.svelte', 'utf8'), 'App.svelte')).toEqual(css);
    expect(css.light['--bg']).toBe('#fff');
    expect(css.dark['--bg']).toBe('#1b1d22');
  });
});

describe('check-contrast main', () => {
  function run(...files: string[]): { code: number; out: string; err: string } {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = main(files);
    const text = (spy: typeof log) => spy.mock.calls.map((c) => c.join(' ')).join('\n');
    return { code, out: text(log), err: text(error) };
  }
  it('exits 1 on a dark block it cannot read and on a token redefined elsewhere, naming the file', () => {
    const unread = tempFile(`:root { ${decls(PASSING)} } @media (prefers-color-scheme: dark) { html:root { --text: #333; --bg: #1b1d22; } }`);
    const elsewhere = tempFile(`:root { ${decls(PASSING)} } html { --accent: #9ab; }`);
    const r = run(unread, elsewhere);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${unread}: --text is declared in "html:root" inside the dark block`);
    expect(r.err).toContain(`${elsewhere}: --accent is declared in "html"`);
    expect(r.out).toMatch(/^0\/2 file\(s\) pass/);
  });
  it('exits 1 on a missing file', () => {
    const r = run(join(tmpdir(), 'no-such-dir-contrast', 'tokens.css'));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/ENOENT/);
  });
  it('exits 1 and names the theme of a failing pair', () => {
    const r = run(tempFile(`:root { ${decls(PASSING)} } @media (prefers-color-scheme: dark) { :root { --bg: #1b1d22; --surface: #25282f; --hover: #2b2f37; --text: #e8eaef; } }`));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/dark: --muted #656a76 on --bg #1b1d22 is \d\.\d\d:1, below 4\.5:1/);
    expect(r.err).not.toMatch(/: light:/);
  });
  it('exits 0 on passing files', () => {
    expect(run(tempFile(`:root { ${decls(PASSING)} }`))).toEqual({ code: 0, out: '1/1 file(s) pass: 15 text/background pairs per theme at 4.5:1', err: '' });
  });
});

describe('check-contrast CLI (one process)', () => {
  function cli(...files: string[]): { code: number; out: string } {
    try {
      const out = execFileSync('node', ['scripts/run-ts.mjs', 'scripts/check-contrast.ts', ...files], { encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stderr: string };
      return { code: err.status, out: err.stderr };
    }
  }
  it('exits 0 on the repo tokens and 1 on a failing file', () => {
    expect(cli()).toEqual({ code: 0, out: expect.stringMatching(/2\/2 file/) });
    const r = cli(tempFile(`:root { ${decls({ ...PASSING, '--ok': '#1e8e3e' })} }`));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/light: --ok #1e8e3e on --bg #fff is 4\.21:1/);
  });
});
