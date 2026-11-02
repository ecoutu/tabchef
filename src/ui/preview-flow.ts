import { hasEffects, type PreviewResult } from '../core/lang/preview';
import type { Config } from '../core/types';
import { send } from './send';

/**
 * Preview then apply (M2 T13, ruling R5): sends `preview.change` for `config`, the config the change would store, and
 * when the preview has anything to show asks `confirm` (PreviewDialog: Apply → true, Cancel → false) before `apply`.
 * Resolves to apply's result, or undefined when cancelled. With no effects, or when the preview itself fails (the
 * apply request reports invalid configs), it applies straight away.
 *
 * Order for a rule edit (options Save): previewThenApply(draft, …, () => send config.set {baseRev}).
 * Order for a recipe (T15): in the click handler, requestNeeds(needs) FIRST and synchronously (it needs the user
 * gesture), then previewThenApply(config with the recipe enabled, …, () => send recipes.enable {id, baseRev}).
 */
export async function previewThenApply<T>(
  config: Config, confirm: (r: PreviewResult) => Promise<boolean>, apply: () => Promise<T>,
): Promise<T | undefined> {
  const r = await send({ type: 'preview.change', config });
  if (r.ok && hasEffects(r.data) && !(await confirm(r.data))) return undefined;
  return apply();
}
