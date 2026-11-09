/**
 * A stand-in for the Google group API calls, for previewing the
 * <GoogleGroup> block without writing to a real Google Workspace.
 * Turned on with RUNBOOKS_MOCK_GOOGLE_GROUPS=1. Groups live in memory until
 * the app quits. An email that starts with "existing" names a group that
 * already exists, and one that starts with "denied" fails as a missing
 * permission would.
 */
import { Effect } from "effect"
import { GoogleClient } from "../../../src/services/GoogleClient.ts"
import type { GoogleCredentialRef, GoogleGroup } from "../../../src/services/GoogleClient.ts"
import { GoogleAuthError } from "../../../src/errors/index.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("google-groups-mock")

export const mockGoogleGroupsEnabled = (): boolean =>
  process.env.RUNBOOKS_MOCK_GOOGLE_GROUPS === "1"

/** Stands in for a signed-in credential when the runbook has no GoogleAuth block. */
export const MOCK_CREDENTIAL: GoogleCredentialRef = { kind: "access_token", accessToken: "mock" }

const groups = new Map<string, { group: GoogleGroup; members: Set<string> }>()

/** Long enough to see the block's saving state. */
const latency = Effect.sleep("700 millis")

export const withMockGoogleGroups = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.updateService(effect, GoogleClient, (real) => ({
    ...real,
    findCustomerIdForDomain: (_caller, domain) =>
      latency.pipe(
        Effect.tap(() => Effect.sync(() => log.info(`find customer for ${domain}`))),
        Effect.as("C0mock123"),
      ),
    createGroup: (_caller, params) =>
      Effect.gen(function* () {
        yield* latency
        const email = params.email.toLowerCase()
        if (email.startsWith("denied")) {
          return yield* Effect.fail(
            new GoogleAuthError({
              message:
                "Error 403: The caller does not have permission (mock). Ask a Google Workspace administrator for the Groups Admin role.",
            }),
          )
        }
        if (email.startsWith("existing") && !groups.has(email)) {
          groups.set(email, {
            group: { name: "groups/existing1", email, displayName: params.displayName },
            members: new Set(),
          })
        }
        const existing = groups.get(email)
        if (existing) {
          log.info(`group ${email} already exists`)
          return { status: "exists" as const, group: existing.group }
        }
        const group: GoogleGroup = {
          name: `groups/mock${groups.size + 1}`,
          email,
          displayName: params.displayName,
        }
        groups.set(email, { group, members: new Set() })
        log.info(`created group ${email} in ${params.customerId}`)
        return { status: "created" as const, group }
      }),
    addGroupMember: (_caller, groupName, memberEmail, role) =>
      Effect.gen(function* () {
        yield* latency
        const entry = [...groups.values()].find((g) => g.group.name === groupName)
        const key = memberEmail.toLowerCase()
        if (!entry || entry.members.has(key)) return "exists" as const
        entry.members.add(key)
        log.info(`added ${memberEmail} to ${groupName} as ${role}`)
        return "added" as const
      }),
    allowExternalSenders: (_caller, groupEmail) =>
      latency.pipe(
        Effect.tap(() => Effect.sync(() => log.info(`let outside senders email ${groupEmail}`))),
      ),
  }))
