import { describe, it, expect, spyOn, beforeEach, afterAll } from "bun:test"
import { Effect } from "effect"
import { runtime } from "./runtime.ts"
import { handleSsoPoll, handleSsoRoles } from "./aws-sso.ts"
import { makeTestAwsClient } from "../../../src/test-utils/TestLayer.ts"
import { AwsSsoError } from "../../../src/errors/index.ts"
import type { AwsClient, AwsClientShape } from "../../../src/services/AwsClient.ts"

/**
 * The aws:sso-poll / aws:sso-roles replies as the renderer receives them.
 * useAwsAuth branches on `status` and reads `{ roles }`
 * (web/src/components/mdx/AwsAuth/hooks/__tests__/useAwsAuth.sso.test.ts
 * drives it with these shapes). The shared runtime runs each effect against a
 * test AwsClient; the domain functions are the real ones.
 */

/** This test's AwsClient; each test replaces the calls it cares about. */
let aws: { -readonly [K in keyof AwsClientShape]?: AwsClientShape[K] } = {}

const runPromise = spyOn(runtime, "runPromise").mockImplementation(
  (<A, E>(effect: Effect.Effect<A, E, AwsClient>) =>
    Effect.runPromise(Effect.provide(effect, makeTestAwsClient(aws)))) as typeof runtime.runPromise,
)

afterAll(() => {
  runPromise.mockRestore()
})

const SSO_REGION = "eu-central-1"
const POLL = { clientId: "cid", clientSecret: "csecret", deviceCode: "dc-1", region: SSO_REGION }
const ACCOUNTS = [
  { accountId: "111111111111", accountName: "prod", emailAddress: "prod@example.com" },
  { accountId: "222222222222", accountName: "dev", emailAddress: "dev@example.com" },
]
const IDENTITY = {
  accountId: "111111111111",
  accountName: "prod",
  arn: "arn:aws:sts::111111111111:assumed-role/Admin/me",
}

beforeEach(() => {
  aws = {
    pollSsoToken: () => Effect.succeed({ accessToken: "sso-token" }),
    listSsoAccounts: () => Effect.succeed(ACCOUNTS),
    completeSsoAuth: (params) =>
      Effect.succeed({
        accessKeyId: "ASIA_ROLE",
        secretAccessKey: "role-secret",
        sessionToken: "role-token",
        region: params.region,
      }),
    validateCredentials: () => Effect.succeed(IDENTITY),
  }
})

describe("aws:sso-poll", () => {
  it("replies pending while the user has not approved", async () => {
    aws.pollSsoToken = () => Effect.succeed({ pending: true })
    expect(await handleSsoPoll(POLL)).toEqual({ status: "pending" })
  })

  it("replies select_account with the token and accounts once approved", async () => {
    const regions: string[] = []
    aws.pollSsoToken = (params) => {
      regions.push(params.region)
      return Effect.succeed({ accessToken: "sso-token" })
    }
    aws.listSsoAccounts = (_token, region) => {
      regions.push(region)
      return Effect.succeed(ACCOUNTS)
    }

    expect(await handleSsoPoll(POLL)).toEqual({
      status: "select_account",
      accessToken: "sso-token",
      accounts: ACCOUNTS,
    })
    expect(regions).toEqual([SSO_REGION, SSO_REGION])
  })

  it("replies success with the identity and keys for a pinned account and role", async () => {
    const reply = await handleSsoPoll({ ...POLL, accountId: "111111111111", roleName: "Admin" })

    expect(reply).toEqual({
      status: "success",
      ...IDENTITY,
      accessKeyId: "ASIA_ROLE",
      secretAccessKey: "role-secret",
      sessionToken: "role-token",
    })
  })

  it("replies failed with the reason instead of rejecting", async () => {
    aws.pollSsoToken = () =>
      Effect.fail(new AwsSsoError({ message: "The SSO sign-in request expired. Please try again." }))

    expect(await handleSsoPoll(POLL)).toEqual({
      status: "failed",
      error: "The SSO sign-in request expired. Please try again.",
    })
  })

  it("replies failed when no accounts are available", async () => {
    aws.listSsoAccounts = () => Effect.succeed([])
    const reply = await handleSsoPoll(POLL)
    expect(reply.status).toBe("failed")
    expect("error" in reply && reply.error).toContain("No AWS accounts are available")
  })

  it("replies failed without calling AWS when no region is given", async () => {
    let polled = false
    aws.pollSsoToken = () => {
      polled = true
      return Effect.succeed({ pending: true })
    }
    expect(await handleSsoPoll({ ...POLL, region: undefined })).toEqual({
      status: "failed",
      error: "SSO region is required",
    })
    expect(polled).toBe(false)
  })
})

describe("aws:sso-roles", () => {
  it("replies { roles } listed in the SSO region", async () => {
    const calls: unknown[][] = []
    aws.listSsoRoles = (token, accountId, region) => {
      calls.push([token, accountId, region])
      return Effect.succeed([{ roleName: "Admin", accountId }])
    }

    expect(await handleSsoRoles({ accessToken: "sso-token", accountId: "111111111111", region: SSO_REGION })).toEqual({
      roles: [{ roleName: "Admin", accountId: "111111111111" }],
    })
    expect(calls).toEqual([["sso-token", "111111111111", SSO_REGION]])
  })

  it("replies { roles: [], error } instead of rejecting", async () => {
    aws.listSsoRoles = () => Effect.fail(new AwsSsoError({ message: "Failed to list SSO roles: UnauthorizedException" }))

    expect(await handleSsoRoles({ accessToken: "sso-token", accountId: "111111111111", region: SSO_REGION })).toEqual({
      roles: [],
      error: "Failed to list SSO roles: UnauthorizedException",
    })
  })

  it("replies an error without calling AWS when no region is given", async () => {
    expect(await handleSsoRoles({ accessToken: "sso-token", accountId: "111111111111" })).toEqual({
      roles: [],
      error: "SSO region is required",
    })
  })
})
