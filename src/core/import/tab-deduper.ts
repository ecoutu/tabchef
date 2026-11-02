/**
 * Tab Deduper (v1.2.3) chrome.storage.local -> Tabchef DedupeSettings (only keys the export contains are set)
 *
 * | source key              | Tabchef                    | note                                                           |
 * |-------------------------|----------------------------|----------------------------------------------------------------|
 * | dedupAllWindows         | scope                      | true -> 'all-windows', false -> 'same-window'                  |
 * | ignoreFragmentDefault   | stripFragment              |                                                                |
 * | fragmentOverrides       | fragmentOverrides          | plain line -> strip (keepFragment false), `-` -> keep (true)   |
 * | useTitleDefault         | matchTitle                 |                                                                |
 * | titleOverrides          | titleOverrides             | plain line -> matchTitle true, `-` -> false                    |
 * | urlExempts              | allowDuplicates            | prefix -> `<prefix>*`, /regex/ as is, `-` negation -> warning  |
 * | urlTranforms (sic)      | urlTransforms              | lines of pattern`replacement`flags                             |
 *
 * Override and exempt lines: a plain prefix becomes the glob `<prefix>*`, a `/regex/flags` line stays a regex (a
 * leading ^ absorbs the scheme). In an override list a `-` prefix turns the feature off for that site (Tab Deduper).
 */
import type { DedupeSettings } from '../types';

export interface TdImport { dedupe: Partial<DedupeSettings>; warnings: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const lines = (v: unknown): string[] => (typeof v === 'string' ? v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
const SCHEME = '^[a-z][a-z0-9+.-]*:\\/\\/';
/** Tab Deduper tests regexes against the URL after `scheme://`; Tabchef's keys keep the scheme, so a leading ^ must absorb it. */
const anchor = (src: string): string => (src.startsWith('^') ? SCHEME + src.slice(1) : src);
/** `/regex/flags` line -> Tabchef regex pattern (scheme-anchored), or undefined if it does not compile. */
function regexLine(l: string): string | undefined {
  const end = l.lastIndexOf('/');
  const body = l.slice(1, end); const fl = l.slice(end + 1);
  try { new RegExp(body, fl); } catch { return undefined; }
  return `/${anchor(body)}/${fl}`;
}
const isRegexLine = (l: string): boolean => l.length >= 2 && l.startsWith('/') && l.lastIndexOf('/') > 0;

/** Tab Deduper override lines: `[-]<prefix>` or `[-]/regex/flags`; `on` is false for a `-` line. */
function overrides(v: unknown, warnings: string[], what: string): { pattern: string; on: boolean }[] {
  const out: { pattern: string; on: boolean }[] = [];
  for (const raw of lines(v)) {
    const on = !raw.startsWith('-');
    const l = on ? raw : raw.slice(1).trim();
    if (l === '') continue;
    if (!isRegexLine(l)) { out.push({ pattern: `${l}*`, on }); continue; }
    const p = regexLine(l);
    if (p === undefined) warnings.push(`${what} regex ${raw} is invalid and was not imported.`);
    else out.push({ pattern: p, on });
  }
  return out;
}
const KEYS = ['dedupAllWindows', 'useTitleDefault', 'ignoreFragmentDefault', 'urlExempts', 'titleOverrides', 'fragmentOverrides', 'urlTranforms', 'urlTransforms'];

export function importTabDeduper(data: unknown): TdImport {
  if (!isObj(data)) return { dedupe: {}, warnings: ['Unrecognized format'] };
  let local: unknown = data;
  if ('local' in data || 'sync' in data) local = data.local ?? {};
  if (!isObj(local)) return { dedupe: {}, warnings: ['Unrecognized format'] };

  const dedupe: Partial<DedupeSettings> = {};
  const warnings: string[] = [];
  if (!KEYS.some((k) => k in local)) {
    return { dedupe, warnings: ['Tab Deduper had default settings; nothing to import.'] };
  }

  if (typeof local.dedupAllWindows === 'boolean') dedupe.scope = local.dedupAllWindows ? 'all-windows' : 'same-window';
  if (typeof local.ignoreFragmentDefault === 'boolean') dedupe.stripFragment = local.ignoreFragmentDefault;
  if (typeof local.useTitleDefault === 'boolean') dedupe.matchTitle = local.useTitleDefault;
  const titleOv = overrides(local.titleOverrides, warnings, 'Title override');
  if (titleOv.length) dedupe.titleOverrides = titleOv.map(({ pattern, on }) => ({ pattern, matchTitle: on }));
  // TD "ignore fragment" overrides: a plain line ignores (strips) the fragment there, a `-` line keeps it.
  const fragOv = overrides(local.fragmentOverrides, warnings, 'Fragment override');
  if (fragOv.length) dedupe.fragmentOverrides = fragOv.map(({ pattern, on }) => ({ pattern, keepFragment: !on }));

  const allow: string[] = [];
  for (const l of lines(local.urlExempts)) {
    if (l.startsWith('-')) { warnings.push(`Negated exempt "${l}" was not imported (not supported).`); continue; }
    if (isRegexLine(l)) {
      const p = regexLine(l);
      if (p === undefined) warnings.push(`Exempt regex ${l} is invalid and was not imported.`);
      else allow.push(p);
    } else allow.push(`${l}*`);
  }
  if (allow.length) dedupe.allowDuplicates = allow;

  const transforms: NonNullable<DedupeSettings['urlTransforms']> = [];
  for (const l of lines(local.urlTranforms ?? local.urlTransforms)) {
    const [pattern, replacement, flags] = l.split('`');
    if (pattern === undefined || pattern === '' || replacement === undefined) { warnings.push(`URL transform "${l}" is malformed and was not imported.`); continue; }
    try { new RegExp(pattern, flags || undefined); } catch { warnings.push(`URL transform "${l}" has an invalid regex and was not imported.`); continue; }
    const p = anchor(pattern);
    transforms.push(flags ? { pattern: p, replacement, flags } : { pattern: p, replacement });
  }
  if (transforms.length) dedupe.urlTransforms = transforms;
  return { dedupe, warnings };
}
