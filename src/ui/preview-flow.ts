import { hasEffects, type PreviewResult } from '../core/lang/preview';
import type { Config } from '../core/types';
import { send } from './send';

/** How previewThenApply ended: applied (with apply's result), cancelled in the dialog, or the preview failed. */
export type PreviewOutcome<T> = { status: 'applied'; value: T } | { status: 'cancelled' } | { status: 'failed'; error: string };

/**
 * Preview then apply (M2 T13, ruling R5): sends `preview.change` for `config`, the config the change would store, and
 * when the change has real effects (hasEffects, R52: dry-run entries alone do not count) asks `confirm`
 * (PreviewDialog: Apply → true, Cancel → false) before `apply`. With no effects it applies straight away.
 *
 * A failed preview never applies unseen (with R51 a save can close open tabs): only `invalid config` falls through
 * to `apply`, whose request (config.set) reports the field errors. Any other failure resolves `failed` and applies
 * nothing; the caller shows "Could not preview: <error>" and keeps the edits.
 *
 * Order for a rule edit (options Save): previewThenApply(draft, …, () => send config.set {baseRev}).
 * Order for a recipe (T15): in the click handler, requestNeeds(needs) FIRST and synchronously (it needs the user
 * gesture), then previewThenApply(config with the recipe enabled, …, () => send recipes.enable {id, baseRev}).
 */
export async function previewThenApply<T>(
  config: Config, confirm: (r: PreviewResult) => Promise<boolean>, apply: () => Promise<T>,
): Promise<PreviewOutcome<T>> {
  const r = await send({ type: 'preview.change', config });
  if (!r.ok && r.error !== 'invalid config') return { status: 'failed', error: r.error };
  if (r.ok && hasEffects(r.data) && !(await confirm(r.data))) return { status: 'cancelled' };
  return { status: 'applied', value: await apply() };
}
