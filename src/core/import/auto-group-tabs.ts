/**
 * Auto-Group Tabs (v0.0.24) -> Tabchef GroupRule
 *
 * | source (sync.groups[i])  | Tabchef                | note                                            |
 * |--------------------------|------------------------|-------------------------------------------------|
 * | id                       | id                     | new id only if it is missing                    |
 * | title                    | name, group.title      |                                                 |
 * | color                    | group.color            | Chrome color names; unknown -> grey + warning   |
 * | matchers[]               | match.url              | globs with scheme or /regex/flags               |
 * | options.strict           | strict                 | default false in AGT                            |
 * | options.merge            | merge                  | default false in AGT                            |
 * | array order              | array order            | = priority                                      |
 *
 * `sync.groups` is base64 of LZMA-alone compressed JSON (dev mode stores a plain array).
 * AGT matches groups by title + color; Tabchef by title only, hence a warning on shared titles.
 */
import type { GroupColor, GroupRule } from '../types';
import { compilePattern } from '../match/pattern';

export interface AgtImport { rules: GroupRule[]; warnings: string[] }

const COLORS: readonly string[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const KNOWN_OPTIONS = new Set(['strict', 'merge']);
const MAX_DECODED = 10 * 1024 * 1024;
class TooLarge extends Error {}
const UNRECOGNIZED: AgtImport = { rules: [], warnings: ['Unrecognized format'] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type LzmaModule = { decompress: (b: Uint8Array | number[], cb: (r: string | null, err?: unknown) => void) => void };

/** Loaded lazily; the decompress-only build, which uses no eval, no new Function and no Workers. */
async function loadLzma(): Promise<LzmaModule> {
  const m = (await import('lzma/src/lzma-d.js')) as unknown as Record<string, unknown> & { default?: Record<string, unknown> };
  const l = (m.LZMA ?? m.default?.LZMA ?? m.default) as LzmaModule | undefined;
  if (!l || typeof l.decompress !== 'function') throw new Error('lzma decoder unavailable');
  return l;
}

/** Decode `sync.groups`: a base64 LZMA string (-> parsed JSON) or an already-decoded value. */
export async function decodeGroups(groups: unknown): Promise<unknown> {
  if (typeof groups !== 'string') return groups;
  const bin = atob(groups.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // LZMA-alone header: props(5) + uncompressed size (8 bytes LE, all 0xff = unknown).
  if (bytes.length >= 13 && bytes.subarray(5, 13).some((b) => b !== 0xff)) {
    const dv = new DataView(bytes.buffer);
    if (dv.getUint32(9, true) > 0 || dv.getUint32(5, true) > MAX_DECODED) throw new TooLarge();
  }
  const lzma = await loadLzma();
  const text = await new Promise<string>((resolve, reject) => {
    lzma.decompress(bytes, (r, err) => (err || r === null || r === undefined ? reject(err ?? new Error('lzma failed')) : resolve(String(r))));
  });
  if (text.length > MAX_DECODED) throw new TooLarge();
  return JSON.parse(text);
}

export async function importAutoGroupTabs(data: unknown): Promise<AgtImport> {
  if (!isObj(data)) return UNRECOGNIZED;
  const inner = isObj(data.sync) ? data.sync : data;
  if (!('groups' in inner)) return UNRECOGNIZED;
  let groups: unknown;
  try { groups = await decodeGroups(inner.groups); } catch (e) { return e instanceof TooLarge ? { rules: [], warnings: ['Decoded data too large'] } : UNRECOGNIZED; }
  if (!Array.isArray(groups) || groups.length === 0) return UNRECOGNIZED;

  const rules: GroupRule[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  groups.forEach((g: unknown, i) => {
    const label = `Group ${i + 1}`;
    if (!isObj(g) || typeof g.title !== 'string' || !Array.isArray(g.matchers)) { warnings.push(`${label}: skipped (not a valid group).`); return; }
    const title = g.title;
    const matchers = g.matchers.filter((m): m is string => typeof m === 'string' && m.length > 0);
    const good: string[] = [];
    for (const p of matchers) {
      try { compilePattern(p); good.push(p); } catch (e) { warnings.push(`"${title}": dropped pattern ${p} (${(e as Error).message}).`); }
    }
    if (good.length === 0) { warnings.push(`"${title}": skipped (no usable patterns).`); return; }
    let color = g.color as string;
    if (!COLORS.includes(color)) { warnings.push(`"${title}": unknown color ${JSON.stringify(g.color)}; using grey.`); color = 'grey'; }
    const opts = isObj(g.options) ? g.options : {};
    for (const k of Object.keys(opts)) if (!KNOWN_OPTIONS.has(k)) warnings.push(`"${title}": option "${k}" is not supported and was ignored.`);
    let id = typeof g.id === 'string' && g.id ? g.id : crypto.randomUUID();
    if (seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);
    rules.push({
      id, name: title, enabled: true, match: { url: good }, group: { title, color: color as GroupColor },
      strict: opts.strict === true, merge: opts.merge === true,
    });
  });

  if (rules.length === 0 && warnings.length === 0) return UNRECOGNIZED;
  const colorsByTitle = new Map<string, Set<string>>();
  for (const r of rules) {
    const s = colorsByTitle.get(r.group.title) ?? new Set<string>();
    s.add(r.group.color);
    colorsByTitle.set(r.group.title, s);
  }
  for (const [t, s] of colorsByTitle) {
    if (s.size > 1) warnings.push(`Title "${t}" is used with different colors (${[...s].join(', ')}). Auto-Group Tabs kept them separate; Tabchef matches groups by title only.`);
  }
  return { rules, warnings };
}
