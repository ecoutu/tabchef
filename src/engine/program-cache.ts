// The one compiled Program the background engine runs (ruling R4). Every consumer that used the Config for rules or
// dedupe (Reconciler, DedupeHandler, ask controller, badge, duplicates list) gets `get` as its getProgram.
import { compileProgram, type CompileError } from '../core/lang/compile';
import { builtinRecipes } from '../recipes/load';
import { configRev } from './messages';
import type { Config } from '../core/types';
import type { Program, Recipe } from '../core/lang/types';

export interface ProgramCacheOptions {
  /** Built-in recipe bodies. Default: builtinRecipes(). */
  builtins?: Record<string, Recipe>;
  /** Rule keys and/or recipe ids left out of the program (waiting for a permission, M2 T8). Default: none. */
  paused?: () => Iterable<string>;
  /** Called with the compile errors when a compile reports any. Default: console.warn. */
  warn?: (message: string, errors: CompileError[]) => void;
  /** Called after each compile (tests). */
  onCompile?: (p: Program) => void;
}

/**
 * Compiles on demand and memoizes the last Program by (config revision, paused set), so a store reload with equal
 * content reuses it. Keyed by content, not object identity, so an in-place mutation can never serve a stale Program.
 */
export class ProgramCache {
  private last?: { key: string; program: Program };

  constructor(
    private readonly getConfig: () => Promise<Config>,
    private readonly opts: ProgramCacheOptions = {},
  ) {}

  async get(): Promise<Program> {
    const config = await this.getConfig();
    const paused = [...new Set(this.opts.paused?.() ?? [])].sort();
    const key = `${configRev(config)}\n${JSON.stringify(paused)}`;
    if (this.last?.key === key) return this.last.program;
    const { program, errors } = compileProgram(config, this.opts.builtins ?? builtinRecipes(), { paused: new Set(paused) });
    if (errors.length) {
      const warn = this.opts.warn ?? ((m: string, e: CompileError[]) => console.warn(m, e));
      warn(`[tabchef] ${errors.length} rule/recipe problem(s) skipped: ${errors.map((e) => `${e.key}: ${e.error}`).join('; ')}`, errors);
    }
    this.last = { key, program };
    this.opts.onCompile?.(program);
    return program;
  }
}
