import { describe, it, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { ensureGoogleGroup, googleGroupRequestError, uniqueMembers } from "./groups.ts"
import type { GoogleGroupRequest } from "./groups.ts"
import type { GoogleApiCaller, GoogleClientShape } from "../../services/GoogleClient.ts"
import { GoogleAuthError } from "../../errors/index.ts"
import { makeTestGoogleClient } from "../../test-utils/TestLayer.ts"

const CALLER: GoogleApiCaller = {
  creds: { kind: "file", path: "/tmp/adc.json" },
  quotaProjectId: "billing-project",
}

const REQUEST: GoogleGroupRequest = {
  email: "aws-prod@example.com",
  members: [],
  role: "MEMBER",
  allowExternalSenders: false,
}

const GROUP = { name: "groups/abc123", email: "aws-prod@example.com", displayName: "aws-prod" }

/** Records every client call, in order. */
function recordingClient(overrides: Partial<GoogleClientShape> = {}) {
  const calls: string[] = []
  const layer = makeTestGoogleClient({
    findCustomerIdForDomain: (_caller, domain) => {
      calls.push(`find ${domain}`)
      return Effect.succeed("C01abc")
    },
    createGroup: (_caller, params) => {
      calls.push(`create ${params.email} ${params.displayName} ${params.customerId}`)
      return Effect.succeed({ status: "created" as const, group: GROUP })
    },
    addGroupMember: (_caller, groupName, member, role) => {
      calls.push(`add ${groupName} ${member} ${role}`)
      return Effect.succeed("added" as const)
    },
    allowExternalSenders: (_caller, email) => {
      calls.push(`external ${email}`)
      return Effect.void
    },
    ...overrides,
  })
  return { calls, layer }
}

describe("googleGroupRequestError", () => {
  it("accepts a complete request", () => {
    expect(googleGroupRequestError({ email: "a@b.co", members: ["c@d.co"], role: "OWNER" })).toBe(
      undefined,
    )
  })

  it("requires an email", () => {
    expect(googleGroupRequestError({ email: " " })).toContain("needs an email")
  })

  it("rejects an unresolved template as the email", () => {
    expect(googleGroupRequestError({ email: "{{ .inputs.Email }}" })).toContain(
      "is not an email address",
    )
  })

  it("rejects a member that isn't an email", () => {
    expect(googleGroupRequestError({ email: "a@b.co", members: ["josh"] })).toContain(
      'Member "josh"',
    )
  })

  it("rejects an unknown role", () => {
    expect(googleGroupRequestError({ email: "a@b.co", role: "ADMIN" })).toContain("ADMIN")
  })
})

describe("uniqueMembers", () => {
  it("trims, drops blanks, and drops case-insensitive repeats", () => {
    expect(uniqueMembers([" a@b.co", "A@B.co", "", "c@d.co"])).toEqual(["a@b.co", "c@d.co"])
  })
})

describe("ensureGoogleGroup", () => {
  it("finds the customer from the email's domain, creates the group, and adds members", async () => {
    const { calls, layer } = recordingClient()
    const result = await Effect.runPromise(
      ensureGoogleGroup(CALLER, { ...REQUEST, members: ["josh@example.com"] }).pipe(
        Effect.provide(layer),
      ),
    )
    expect(calls).toEqual([
      "find example.com",
      "create aws-prod@example.com aws-prod C01abc",
      "add groups/abc123 josh@example.com MEMBER",
    ])
    expect(result.created).toBe(true)
    expect(result.customerId).toBe("C01abc")
    expect(result.group).toEqual(GROUP)
  })

  it("skips the organization lookup when the customer ID is given", async () => {
    const { calls, layer } = recordingClient()
    await Effect.runPromise(
      ensureGoogleGroup(CALLER, { ...REQUEST, customerId: "C99", displayName: "AWS prod" }).pipe(
        Effect.provide(layer),
      ),
    )
    expect(calls).toEqual(["create aws-prod@example.com AWS prod C99"])
  })

  it("uses a group that already exists and keeps existing memberships", async () => {
    const { layer } = recordingClient({
      createGroup: () => Effect.succeed({ status: "exists" as const, group: GROUP }),
      addGroupMember: () => Effect.succeed("exists" as const),
    })
    const result = await Effect.runPromise(
      ensureGoogleGroup(CALLER, { ...REQUEST, members: ["josh@example.com"] }).pipe(
        Effect.provide(layer),
      ),
    )
    expect(result.created).toBe(false)
    expect(result.log).toContain("Group aws-prod@example.com already exists")
    expect(result.log).toContain("josh@example.com is already a member")
  })

  it("opens the group to outside senders only when asked", async () => {
    const { calls, layer } = recordingClient()
    await Effect.runPromise(
      ensureGoogleGroup(CALLER, { ...REQUEST, allowExternalSenders: true }).pipe(
        Effect.provide(layer),
      ),
    )
    expect(calls.at(-1)).toBe("external aws-prod@example.com")
  })

  it("fails with what to do when no organization matches the domain", async () => {
    const { layer } = recordingClient({
      findCustomerIdForDomain: () => Effect.succeed(undefined),
    })
    const exit = await Effect.runPromiseExit(
      ensureGoogleGroup(CALLER, REQUEST).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("customerId prop")
  })

  it("fails before calling Google when the request is invalid", async () => {
    const { calls, layer } = recordingClient()
    const exit = await Effect.runPromiseExit(
      ensureGoogleGroup(CALLER, { ...REQUEST, email: "not-an-email" }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })

  it("stops at the first failed step", async () => {
    const { calls, layer } = recordingClient({
      addGroupMember: () => Effect.fail(new GoogleAuthError({ message: "denied" })),
    })
    const exit = await Effect.runPromiseExit(
      ensureGoogleGroup(CALLER, {
        ...REQUEST,
        members: ["a@example.com", "b@example.com"],
        allowExternalSenders: true,
      }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls.some((call) => call.startsWith("external"))).toBe(false)
  })
})
