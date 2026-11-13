/**
 * Keeps only the newest of overlapping async results. Kept free of Electron
 * imports so it can be tested on its own.
 */
export interface LatestOnly {
  /**
   * Start a new piece of work. The returned function says whether it is
   * still the newest: false once a later `begin` or an `invalidate` ran.
   */
  begin: () => () => boolean
  /** Make every piece of work started so far stale. */
  invalidate: () => void
}

export function makeLatestOnly(): LatestOnly {
  let latest = 0
  return {
    begin: () => {
      const mine = ++latest
      return () => mine === latest
    },
    invalidate: () => {
      latest++
    },
  }
}
