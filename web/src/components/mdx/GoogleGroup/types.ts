import type { GoogleGroupRole } from "../../../../../src/services/GoogleClient"

export type { GoogleGroupRole }

export interface GoogleGroupProps {
  id: string
  /** Display title (supports template expressions). */
  title?: string
  /** Display description (supports template expressions). */
  description?: string
  /** The GoogleAuth block whose credential creates the group. */
  googleAuthId?: string
  /** The group's email address (supports template expressions). */
  email: string
  /** The group's name. Defaults to the part of `email` before the `@`. */
  displayName?: string
  /** The group's description, shown in Google Groups. */
  groupDescription?: string
  /** Skip the organization lookup and create the group in this customer. */
  customerId?: string
  /** People to add, besides whoever signed in, who becomes the group's first owner. */
  members?: string[]
  /** The role `members` get. Defaults to MEMBER. */
  role?: GoogleGroupRole
  /** Let anyone, including senders outside your organization, email the group. */
  allowExternalSenders?: boolean
  inputsId?: string | string[]
  autoCollapse?: boolean
}

export type GoogleGroupStatus = "ready" | "creating" | "success" | "fail"
