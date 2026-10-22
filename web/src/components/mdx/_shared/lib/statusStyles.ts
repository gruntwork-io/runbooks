import { createElement } from "react"
import type { ReactElement } from "react"
import type { LucideIcon, LucideProps } from "lucide-react"

/** Props for the {@link StatusStyles.StatusIcon} component: a status plus any Lucide icon prop. */
export type StatusIconProps<S extends string> = LucideProps & { status: S }

/** The status→style accessors returned by {@link makeStatusStyles}. */
export interface StatusStyles<S extends string> {
  getStatusClasses: (status: S) => string
  /** Renders the status's icon, forwarding every other prop to it. */
  StatusIcon: (props: StatusIconProps<S>) => ReactElement
  getStatusIconClasses: (status: S) => string
}

/**
 * Build the status→style accessors shared by the auth and execution MDX blocks
 * (AwsAuth, GitAuth, GoogleAuth, Command, Check).
 *
 * Each block supplies its OWN maps: the status unions and the exact
 * class/icon/color values differ per block (e.g. AwsAuth uses warning-tinted
 * "authenticating" while GitAuth uses info-tinted; Command/Check use a
 * different status union entirely). The factory only removes the repeated
 * `(status) => map[status]` lookup boilerplate — it does not unify the data.
 *
 * The icon is a component rather than a getter so callers render
 * `<StatusIcon status={…} />` and never create a component during render.
 * Call this at module scope: each call builds a new `StatusIcon`.
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
    StatusIcon: ({ status, ...props }) => createElement(maps.icon[status], props),
    getStatusIconClasses: (status) => maps.iconColor[status],
  }
}
