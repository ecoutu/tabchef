// DedupeHandler constants with no imports, so the Playwright e2e helpers can load them without the engine's
// JSON-schema import chain (src/core/lang → src/core/config/schema.ts imports *.schema.json).

export const SESSION_MARKER = 'tabchef.sessionStarted';
/** After browser startup, all candidates are ignored and no tab created in the window counts as new (session restore). */
export const STARTUP_GRACE_MS = 10_000;
