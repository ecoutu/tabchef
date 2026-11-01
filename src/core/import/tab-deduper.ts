/**
 * Tab Deduper (v1.2.3) chrome.storage.local -> Tabchef DedupeSettings (only keys the export contains are set)
 *
 * | source key              | Tabchef                    | note                                                           |
 * |-------------------------|----------------------------|----------------------------------------------------------------|
 * | dedupAllWindows         | scope                      | true -> 'all-windows', false -> 'same-window'                  |
 * | ignoreFragmentDefault   | stripFragment              |                                                                |
 * | fragmentOverrides       | (warning)                  | per-site fragment rules are not supported yet                  |
 * | useTitleDefault         | (warning)                  | Tabchef compares URLs only                                     |
 * | titleOverrides          | (warning)                  |                                                                |
 * | urlExempts              | allowDuplicates            | prefix -> `<prefix>*`, /regex/ as is, `-` negation -> warning  |
 * | urlTranforms (sic)      | urlTransforms              | lines of pattern`replacement`flags                             |
 */
import type { DedupeSettings } from '../types';

export interface TdImport { dedupe: Partial<DedupeSettings>; warnings: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const lines = (v: unknown): string[] => (typeof v === 'string' ? v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
const SCHEME = '^[a-z][a-z0-9+.-]*:\\/\\/';
/** Tab Deduper tests regexes against the URL after `scheme://`; Tabchef's keys keep the scheme, so a leading ^ must absorb it. */
const anchor = (src: string): string => (src.startsWith('^') ? SCHEME + src.slice(1) : src);
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
  if (local.useTitleDefault === true || lines(local.titleOverrides).length > 0) {
    warnings.push('Tab Deduper compared page titles too; Tabchef compares URLs only.');
  }
  const titleOv = lines(local.titleOverrides);
  if (titleOv.length) warnings.push(`Title overrides were not imported: ${titleOv.join(', ')}`);
  const fragOv = lines(local.fragmentOverrides);
  if (fragOv.length) warnings.push(`Per-site fragment overrides were not imported (not supported yet): ${fragOv.join(', ')}`);

  const allow: string[] = [];
  for (const l of lines(local.urlExempts)) {
    if (l.startsWith('-')) { warnings.push(`Negated exempt "${l}" was not imported (not supported).`); continue; }
    const regex = l.length >= 2 && l.startsWith('/') && l.lastIndexOf('/') > 0;
    if (regex) {
      const end = l.lastIndexOf('/');
      const body = l.slice(1, end); const fl = l.slice(end + 1);
      try { new RegExp(body, fl); allow.push(`/${anchor(body)}/${fl}`); }
      catch { warnings.push(`Exempt regex ${l} is invalid and was not imported.`); }
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
