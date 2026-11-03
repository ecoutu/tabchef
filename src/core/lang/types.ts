// The M2 declarative rule language. Schema: rule.schema.json (precompiled, see scripts/gen-validator.mjs).
// `discard` and `notify` actions are deliberately absent until the milestone that implements them (ruling R26).
import type { DedupeMode, DedupeSettings, TabSnap } from '../types';
import type { ProjectDef } from '../projects/types';
import type { AdapterId } from '../adapters/types';

export type Pattern = string;                         // glob | /regex/flags | :param, as M1 compilePattern
export type Cond =
  | { url: Pattern | Pattern[] } | { title: Pattern }
  | { opener: Cond } | { group: string } | { pinned: boolean } | { audible: boolean }
  | { age: { gt?: string; lt?: string } }             // durations since tab creation
  | { pageText: string | string[] }                   // substring(s); needs host permission
  | { field: Comparison }                             // source.<name> | extract.<name> | project.<name> (M3); missing = unknown
  | { all: Cond[] } | { any: Cond[] } | { not: Cond };
/** Where a jiraKey extract reads its text: the tab's url or title, or one of the rule's source fields. */
export type ExtractFrom = 'url' | 'title' | `source.${string}`;
/** Jira issue key extraction (M3; the value is computed by T2, until then it is undefined, M3-R21). */
export interface JiraKeySpec { pattern?: string; allow?: string[]; ignore?: string[] }
export type ExtractSpec =
  | { from: 'url' | 'title'; regex: string; group?: string }
  | { selector: string; attr?: string }
  | { from: ExtractFrom; jiraKey: JiraKeySpec }
  /** M3 T10: one field of a page adapter (core/adapters), read from the page facts and parsed by the adapter. */
  | { adapter: AdapterId; field: string };
export type Extract = Record<string, ExtractSpec>;
export type TriggerKind = 'created' | 'committed' | 'pageText' | 'schedule' | 'groupChanged' | 'sourceUpdated';
export type CloseMode = 'auto' | 'suggest';
export interface GroupAction {
  title: string; color: string /* GroupColor or template */; collapsed?: boolean;
  sortGroups?: 'creation' | 'alphabetical'; strict?: boolean; merge?: boolean; anchors?: string[];
}
export interface DedupeAction { mode?: DedupeMode; followFragment?: boolean; keepFragment?: boolean; matchTitle?: boolean }
export type Action =
  | { group: GroupAction }
  | { dedupe: DedupeAction }
  | { close: { after?: string; mode?: CloseMode } }
  | { showInView: { view: string } }
  /**
   * Recipe rules only (M3-R15): make this tab a candidate for the recipe's project `key` (a template). `fallbackKey`
   * (a template) adds a second, lower candidate when it renders to another non-empty key: the first that resolves wins
   * (T16's either variant: the PR title's key, else its branch's; M2's `default:` filter takes only a literal).
   */
  | { assignProject: { key: string; fallbackKey?: string; create?: boolean /* default false */ } };
/**
 * Host match patterns, optional permissions and connections a recipe (or one recipe rule, T10) needs to run.
 * `anyOf` lists alternatives, best first; the first satisfied one is the rule's level (needsLevel, M3-R12), which
 * PermissionsManager computes from the granted permissions and connection states (T12). Alternatives do not nest.
 */
export interface RecipeNeeds { hosts?: string[]; permissions?: string[]; connections?: string[]; anyOf?: RecipeNeeds[] }
/** The source queries a rule's `source` may name (= T8's SOURCE_QUERIES keys, M3-R29). */
export type SourceQueryKind = 'github.pull_request' | 'github.search_prs_by_key' | 'jira.issue' | 'jira.projects';
/**
 * A recipe rule's data source (M3, recipe rules only, M3-R15): `query` run on `connection` with `args` (templates
 * rendered with the rule's vars); `fields` maps a field name (read as `source.<name>`) to a dot path into the result.
 * `fallback`: the page adapter the SourceService reads when there is no usable connection (M3-R59).
 */
export interface SourceSpec {
  connection: string; query: SourceQueryKind; args: Record<string, string>; fields: Record<string, string>;
  fallback?: { adapter: AdapterId };
}
export interface Rule {
  id: string; name: string; enabled: boolean; dryRun?: boolean;
  /** Recipe rules only (R44): an unmet rule-level need pauses this rule key alone; the recipe still enables (R5). */
  needs?: RecipeNeeds;
  /** Recipe rules only (M3-R15). */
  source?: SourceSpec;
  trigger?: { on: TriggerKind[]; every?: string };     // default on: ['created','committed']
  match: Cond; extract?: Extract; actions: Action[];
}
/** In a `field` condition, `value` may be `{ago: <duration>}`: the time now minus that, compared as a date (M3-R9). */
export interface Comparison { field: string; op: '==' | '!=' | '<' | '>' | 'in' | 'matches'; value: unknown }
export type Show = Comparison | { all: Show[] } | { any: Show[] } | { not: Show };
export interface View {
  id: string; tab: string; kind: 'list' | 'duplicates' | 'projects'; rules?: string[];
  show?: Show; groupBy?: string; sort?: { field: string; dir: 'asc' | 'desc' }; actions: ('focus' | 'close' | 'close-all' | 'keep')[];
}
export interface ParamDef {
  type: 'string' | 'pattern' | 'regex' | 'number' | 'boolean' | 'duration' | 'string[]'; default: unknown; label: string;
  /** A longer explanation, shown as the field's help tip on the Recipes page. */
  help?: string;
  /** Allowed values (compared by JSON equality); the schema keyword lands with the recipe schema (T5). */
  enum?: unknown[];
  /** Inclusive bounds of a duration (a duration string) or number param (M3-R77); a value outside is a param problem. */
  min?: string | number; max?: string | number;
}
export interface Recipe {
  recipe: string; version: number; name: string; description: string;
  params?: Record<string, ParamDef>; needs?: RecipeNeeds;
  tables?: Record<string, Record<string, string>>;
  dedupe?: { urlTransforms?: DedupeSettings['urlTransforms'] };
  rules: Rule[]; views?: View[];
  /** M3: the project tabs of `assignProject` rules join (one per rendered key). */
  project?: Omit<ProjectDef, 'recipeId'>;
  /** M3: recipe ids that cannot be enabled together with this one (M3-R17). */
  conflicts?: string[];
  /**
   * M3: named capability levels; each lists the rule ids whose status decides it. The kind is POSITIONAL (M3-R69):
   * levels[0] = titles, [1] = page (host access), [2] = connection (core/lang/needs.ts LEVEL_KINDS), so at most 3,
   * and every listed rule needs an alternative of its level's kind (validateRecipe). A level is available when none of
   * its rules is paused and at least one runs at that kind or better.
   */
  levels?: RecipeLevel[];
}
export interface RecipeLevel { id: string; label: string; rules: string[] }
export interface RecipeRef {
  id: string; enabled: boolean; params: Record<string, unknown>; source: 'builtin' | 'user'; body?: Recipe;
  /**
   * R56: per-rule overrides of the body's `enabled` (both directions), keyed by rule id. No entry = the body default.
   * compileProgram uses the effective value: a rule turned off adds no needs and never wins or shadows.
   */
  ruleEnabled?: Record<string, boolean>;
}
export interface TabFacts {
  tab: TabSnap; opener?: TabSnap; groupTitle?: string;
  page?: { texts: string[]; extracts: Record<string, string>; formEdited: boolean };
  /**
   * M3: source data per rule key (T8's SourceEntry is assignable). `data` holds the picked `fields`; a field that is
   * absent (or no entry, or no data) is unknown to `field` conditions (M3-R8). `stale`: the data could not be
   * refreshed (kept from an earlier lookup); a close never acts on it (M3-R90).
   */
  source?: Record<string /* ruleKey */, { data?: Record<string, unknown>; stale?: boolean }>;
  /** M3: the project this tab belongs to (T14/T15). */
  projectId?: string;
}
/** One Program.needs alternative: origins, permissions and (M3) connection ids. */
export interface NeedsAlt { origins: string[]; permissions: string[]; connections?: string[] }
/** A Program.needs entry: base needs, plus (M3) ordered alternatives, best first. */
export interface NeedsEntry extends NeedsAlt { anyOf?: NeedsAlt[] }
export interface CompiledRule { key: string /* 'user/<id>' | '<recipeId>/<id>' */; rule: Rule; recipeId?: string; index: number; dryRun: boolean }
export interface Program {
  rules: CompiledRule[]; views: (View & { recipeId: string })[]; tables: Record<string, Record<string, string>>;
  dedupe: DedupeSettings; needs: Record<string /* recipeId | ruleKey (rule-level, T10; listed while paused too) */, NeedsEntry>;
  /** M3 T12: the declared capability levels per enabled recipe id (only recipes that declare them). */
  levels?: Record<string, RecipeLevel[]>;
  /** M3 T15: the project definitions of enabled recipes (params substituted), one per recipe that declares one. */
  projects?: ProjectDef[];
  /** The resolved param values of enabled recipes that declare params, by recipe id (M3 T15 projects, T13 views and the refresh period). */
  params?: Record<string, Record<string, unknown>>;
  /** M3-R75: the `refreshEvery` value of each enabled recipe that declares it as a duration param, by recipe id. */
  refreshEvery?: Record<string, string>;
  /**
   * Global dry run (`config.dryRun`, M2 T12): every rule is dry-run and engine-initiated actions only (R50) are blocked
   * and logged; user-initiated actions (popup close / close-all, banner choices, undo) still apply.
   */
  dryRun?: boolean;
}
