// A saved tab's identity (M4-R41), shared by the saved-list refresh (engine/projects.ts) and, with sync, the merge.

/**
 * A saved tab's identity: its URL as parsed, else the raw string. Never a dedupe key: those merge URLs the user kept
 * apart (`#fragment`, `utm_*`) and differ per device.
 */
export const keyOf = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};
