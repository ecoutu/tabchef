// The M2 declarative rule language. Schema: rule.schema.json (precompiled, see scripts/gen-validator.mjs).
// `discard` and `notify` actions are deliberately absent until the milestone that implements them (ruling R26).
import type { DedupeMode, DedupeSettings, TabSnap } from '../types';

export type Pattern = string;                         // glob | /regex/flags | :param, as M1 compilePattern
export type Cond =
  | { url: Pattern | Pattern[] } | { title: Pattern }
  | { opener: Cond } | { group: string } | { pinned: boolean } | { audible: boolean }
  | { age: { gt?: string; lt?: string } }             // durations since tab creation
  | { pageText: string | string[] }                   // substring(s); needs host permission
  | { all: Cond[] } | { any: Cond[] } | { not: Cond };
export type ExtractSpec = { from: 'url' | 'title'; regex: string; group?: string } | { selector: string; attr?: string };
export type Extract = Record<string, ExtractSpec>;
export type TriggerKind = 'created' | 'committed' | 'pageText' | 'schedule' | 'groupChanged';
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
  | { showInView: { view: string } };
export interface Rule {
  id: string; name: string; enabled: boolean; dryRun?: boolean;
  trigger?: { on: TriggerKind[]; every?: string };     // default on: ['created','committed']
  match: Cond; extract?: Extract; actions: Action[];
}
export interface Comparison { field: string; op: '==' | '!=' | '<' | '>' | 'in' | 'matches'; value: unknown }
export type Show = Comparison | { all: Show[] } | { any: Show[] } | { not: Show };
export interface View {
  id: string; tab: string; kind: 'list' | 'duplicates'; rules?: string[];
  show?: Show; groupBy?: string; sort?: { field: string; dir: 'asc' | 'desc' }; actions: ('focus' | 'close' | 'close-all' | 'keep')[];
}
export interface ParamDef { type: 'string' | 'pattern' | 'regex' | 'number' | 'boolean' | 'duration' | 'string[]'; default: unknown; label: string }
export interface Recipe {
  recipe: string; version: number; name: string; description: string;
  params?: Record<string, ParamDef>; needs?: { hosts?: string[]; permissions?: string[] };
  tables?: Record<string, Record<string, string>>;
  dedupe?: { urlTransforms?: DedupeSettings['urlTransforms'] };
  rules: Rule[]; views?: View[];
}
export interface RecipeRef { id: string; enabled: boolean; params: Record<string, unknown>; source: 'builtin' | 'user'; body?: Recipe }
export interface TabFacts {
  tab: TabSnap; opener?: TabSnap; groupTitle?: string; createdAt?: number;
  page?: { texts: string[]; extracts: Record<string, string>; formEdited: boolean };
}
export interface CompiledRule { key: string /* 'user/<id>' | '<recipeId>/<id>' */; rule: Rule; recipeId?: string; index: number; dryRun: boolean }
export interface Program {
  rules: CompiledRule[]; views: (View & { recipeId: string })[]; tables: Record<string, Record<string, string>>;
  dedupe: DedupeSettings; needs: Record<string /* recipeId */, { origins: string[]; permissions: string[] }>;
}
