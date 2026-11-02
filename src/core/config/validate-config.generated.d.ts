export interface ValidateError { instancePath: string; schemaPath: string; keyword: string; params: Record<string, unknown>; message?: string }
export interface ValidateFn { (data: unknown): boolean; errors: ValidateError[] | null }
/** Config v2 (config.schema.json). */
export const validate: ValidateFn;
/** One rule (src/core/lang/rule.schema.json). */
export const validateRule: ValidateFn;
/** One recipe (src/core/lang/recipe.schema.json; its rules may hold {params.x} placeholders). */
export const validateRecipe: ValidateFn;
/** M1 config (config-v1.schema.json); migration only. */
export const validateConfigV1: ValidateFn;
