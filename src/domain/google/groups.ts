/**
 * The <GoogleGroup> block's work: create a Google group and give it members,
 * through the Cloud Identity Groups API, as a GoogleAuth block's credential.
 *
 * Every step is safe to repeat. A group that already exists is used as it is,
 * and a member who already belongs keeps their membership, so running the
 * block again finishes what an interrupted run started.
 */
import { Effect } from "effect"
import { GoogleClient } from "../../services/GoogleClient.ts"
import type { GoogleApiCaller, GoogleGroup, GoogleGroupRole } from "../../services/GoogleClient.ts"
import { GoogleAuthError } from "../../errors/index.ts"

export const GOOGLE_GROUP_ROLES = [
  "MEMBER",
  "MANAGER",
  "OWNER",
] as const satisfies readonly GoogleGroupRole[]

/** What the block asks for, with its props resolved. */
export interface GoogleGroupRequest {
  readonly email: string
  /** Defaults to the part of `email` before the `@`. */
  readonly displayName?: string | undefined
  readonly description?: string | undefined
  /** Skips the organization lookup when set. */
  readonly customerId?: string | undefined
  /** Added besides the caller, who becomes the group's first owner. */
  readonly members: readonly string[]
  readonly role: GoogleGroupRole
  readonly allowExternalSenders: boolean
}

export interface GoogleGroupResult {
  readonly group: GoogleGroup
  /** False when a group with this email already existed. */
  readonly created: boolean
  readonly customerId: string
  /** What the block did, a line per step, for its log. */
  readonly log: readonly string[]
}

// One @, no spaces, and a dot in the domain: enough to catch a typo or an
// unresolved template before Google is asked.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Why `request` can't be sent, or undefined when it can. */
export function googleGroupRequestError(request: {
  email?: string | undefined
  members?: readonly string[] | undefined
  role?: string | undefined
}): string | undefined {
  const email = request.email?.trim() ?? ""
  if (!email) return "The group needs an email address (the `email` prop)."
  if (!EMAIL_PATTERN.test(email)) return `"${email}" is not an email address.`
  for (const member of request.members ?? []) {
    if (!EMAIL_PATTERN.test(member.trim())) return `Member "${member}" is not an email address.`
  }
  if (
    request.role !== undefined &&
    !(GOOGLE_GROUP_ROLES as readonly string[]).includes(request.role)
  ) {
    return `Role "${request.role}" is not one of ${GOOGLE_GROUP_ROLES.join(", ")}.`
  }
  return undefined
}

/** The members to add, trimmed, without repeats (emails compare case-insensitively). */
export function uniqueMembers(members: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of members) {
    const member = raw.trim()
    const key = member.toLowerCase()
    if (!member || seen.has(key)) continue
    seen.add(key)
    unique.push(member)
  }
  return unique
}

/** Create the group if it doesn't exist, then add its members. */
export const ensureGoogleGroup = (caller: GoogleApiCaller, request: GoogleGroupRequest) =>
  Effect.gen(function* () {
    const invalid = googleGroupRequestError(request)
    if (invalid) return yield* Effect.fail(new GoogleAuthError({ message: invalid }))

    const google = yield* GoogleClient
    const email = request.email.trim()
    const domain = email.slice(email.indexOf("@") + 1)
    const log: string[] = []

    let customerId = request.customerId?.trim()
    if (!customerId) {
      customerId = yield* google.findCustomerIdForDomain(caller, domain)
      if (!customerId) {
        return yield* Effect.fail(
          new GoogleAuthError({
            message: `This account can't see a Google Cloud organization for ${domain}. If ${domain} is a secondary domain, set the block's customerId prop to your Google Workspace customer ID (Admin console > Account > Account settings).`,
          }),
        )
      }
      log.push(`Found customer ${customerId} for ${domain}`)
    }

    const { status, group } = yield* google.createGroup(caller, {
      email,
      displayName: request.displayName?.trim() || email.slice(0, email.indexOf("@")),
      description: request.description?.trim() || undefined,
      customerId,
    })
    log.push(
      status === "created" ? `Created group ${group.email}` : `Group ${group.email} already exists`,
    )

    for (const member of uniqueMembers(request.members)) {
      const added = yield* google.addGroupMember(caller, group.name, member, request.role)
      log.push(
        added === "added"
          ? `Added ${member} as ${request.role.toLowerCase()}`
          : `${member} is already a member`,
      )
    }

    if (request.allowExternalSenders) {
      yield* google.allowExternalSenders(caller, group.email)
      log.push("Anyone can now email the group, including senders outside your organization")
    }

    return { group, created: status === "created", customerId, log } satisfies GoogleGroupResult
  })
