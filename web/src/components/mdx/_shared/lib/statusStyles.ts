import type { LucideIcon } from 'lucide-react'

/** The status→style accessor trio returned by {@link makeStatusStyles}. */
export interface StatusStyles<S extends string> {
  getStatusClasses: (status: S) => string
  getStatusIcon: (status: S) => LucideIcon
  getStatusIconClasses: (status: S) => string
}

/**
 * Build the status→style accessors shared by the auth and execution MDX blocks
 * (AwsAuth, GitAuth, Command, Check).
 *
 * Each block supplies its OWN maps: the status unions and the exact
 * class/icon/color values differ per block (e.g. AwsAuth uses warning-tinted
 * "authenticating" while GitAuth uses info-tinted; Command/Check use a
 * different status union entirely). The factory only removes the repeated
 * `(status) => map[status]` lookup boilerplate — it does not unify the data.
 *
 * Using `Record<S, …>` keeps the maps exhaustive: dropping or misspelling a
 * status is a compile error.
 */
export function makeStatusStyles<S extends string>(maps: {
  container: Record<S, string>
  icon: Record<S, LucideIcon>
  iconColor: Record<S, string>
}): StatusStyles<S> {
  return {
    getStatusClasses: (status) => maps.container[status],
    getStatusIcon: (status) => maps.icon[status],
    getStatusIconClasses: (status) => maps.iconColor[status],
  }
}
