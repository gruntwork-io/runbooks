/**
 * Shared display limits for the collapsible file lists rendered by
 * ChangedFilesView (workspace diffs) and CodeFileCollection (generated code).
 */

/** Maximum number of files to render at once. */
export const MAX_DISPLAYED_FILES = 100
/** When the number of files exceeds this, all files start collapsed. */
export const AUTO_COLLAPSE_THRESHOLD = 25
/** How many additional files to reveal each time "Show more" is clicked. */
export const SHOW_MORE_INCREMENT = 50
