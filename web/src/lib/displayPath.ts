/** The directories that paths on screen are shortened against. */
export interface PathRoots {
  /** The open session's own directory, shown as `session` */
  sessionDir?: string | undefined
  /** The user's home directory, shown as `~` */
  homeDir?: string | undefined
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * `text` with each path in the session's directory shortened to start with
 * `session`, and each other path in the home directory to start with `~`:
 * `/Users/me/Library/…/sessions/dirs/0199a5c2/generated` becomes
 * `session/generated`, and `/Users/me/dev/infra` becomes `~/dev/infra`.
 *
 * `text` can be a lone path or a message with paths in it. A directory
 * matches only whole: with `/Users/me` as home, `/Users/meg` stays as it is.
 */
export function abbreviatePaths(text: string, roots: PathRoots): string {
  let shortened = text
  // The session's directory is in the home directory, so it goes first.
  for (const [dir, label] of [
    [roots.sessionDir, "session"],
    [roots.homeDir, "~"],
  ] as const) {
    const root = dir?.replace(/[\\/]+$/, "")
    // A filesystem root would shorten every path.
    if (!root || root.length < 2) continue
    const whole = new RegExp(`(?<![\\w.\\\\/-])${escapeRegExp(root)}(?=[\\\\/]|[^\\w.-]|$)`, "g")
    shortened = shortened.replace(whole, label)
  }
  return shortened
}
