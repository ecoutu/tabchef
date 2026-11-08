// Keep named for what it does (#157), shared by Project home and the popup's Done prompt. With project sync on
// (projects.sync.status `enabled`: the toggle on and the bookmarks permission granted) a kept project is written to the
// Tabchef bookmark folder, so the words say bookmarks; otherwise keeping only saves the project.
import type { Response, ResponseData } from '../engine/messages';

/**
 * Project sync is on, from a projects.sync.status answer. A failed read keeps `last` (the last known value), so one
 * failed refresh does not flip the wording; before any answer callers start from false (sync off).
 */
export const syncOnFrom = (s: Response<ResponseData['projects.sync.status']>, last: boolean): boolean => (s.ok ? s.data?.enabled === true : last);

/** Project home's button: what clicking it does. */
export const keepLabel = (syncOn: boolean, keep: boolean): string =>
  syncOn ? (keep ? 'Remove from bookmarks' : 'Save to bookmarks') : (keep ? 'Unsave project' : 'Save project');

/** Project home's tooltip on that button. */
export const keepTitle = (syncOn: boolean): string =>
  syncOn ? 'A saved project is never forgotten, and sync keeps it in your bookmarks' : 'A saved project is never forgotten';

/** Project home's badge on a saved project. */
export const savedBadge = (syncOn: boolean): string => (syncOn ? 'Saved to bookmarks' : 'Saved');

/**
 * The popup's Done prompt: keep the group open (and keep the project, which sync saves to bookmarks). A project already
 * kept is already saved, so the button only keeps the group open.
 */
export const doneKeepLabel = (syncOn: boolean, keep = false): string => (syncOn && !keep ? 'Keep and save to bookmarks' : 'Keep open');
