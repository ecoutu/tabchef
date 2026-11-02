// Project types (M3). T1 adds only ProjectDef, so `Recipe.project` can reference it (M3-R19); T14 adds Project and
// ProjectAssignment.

/** A recipe's project definition: how tabs it assigns (`assignProject`) are grouped into one project per key. */
export interface ProjectDef {
  recipeId: string;
  /** Template rendered with the assigning rule's vars. */
  key: string;
  /** Template, e.g. '{key}' or '{key} · {summary}'. */
  title: string;
  /** A Chrome group color or a template. */
  color: string;
  container: 'group';
  join: ('rules' | 'manual')[];
}
