import { describe, it, expect, spyOn, beforeEach, afterAll } from "bun:test"
import { Effect } from "effect"
import { runtime } from "./runtime.ts"
import { handleProfiles, handleProfileAuth } from "./aws-profiles.ts"
import { makeTestAwsClient } from "../../../src/test-utils/TestLayer.ts"
import { AwsAuthError } from "../../../src/errors/index.ts"
import type { AwsClient, AwsClientShape } from "../../../src/services/AwsClient.ts"

/**
 * The aws:profiles / aws:profile-auth replies as the renderer receives them.
 * useAwsAuth reads `{ profiles }`
 * (web/src/components/mdx/AwsAuth/hooks/__tests__/useAwsAuth.profiles.test.ts
 * drives it with that shape). The shared runtime runs each effect against a
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

const PROFILES = [
  { name: "default", authType: "static" as const, region: "us-west-2" },
  { name: "sso-new", authType: "sso" as const },
]
const CREDENTIALS = {
  accessKeyId: "AKIA_DEV",
  secretAccessKey: "dev-secret",
  sessionToken: undefined,
  region: "eu-west-1",
}
const IDENTITY = {
  accountId: "111122223333",
  accountName: "dev",
  arn: "arn:aws:iam::111122223333:user/dev",
}

beforeEach(() => {
  aws = {
    listProfiles: () => Effect.succeed(PROFILES),
    authenticateProfile: () => Effect.succeed(CREDENTIALS),
    validateCredentials: () => Effect.succeed(IDENTITY),
  }
})

describe("aws:profiles", () => {
  it("replies { profiles }, the shape channels.ts declares", async () => {
    expect(await handleProfiles()).toEqual({ profiles: PROFILES })
  })
})

describe("aws:profile-auth", () => {
  it("resolves the profile and validates it once, via STS in us-east-1", async () => {
    const resolved: string[] = []
    const validated: unknown[][] = []
    aws.authenticateProfile = (profileName) => {
      resolved.push(profileName)
      return Effect.succeed(CREDENTIALS)
    }
    aws.validateCredentials = (creds, region) => {
      validated.push([creds, region])
      return Effect.succeed(IDENTITY)
    }

    expect(await handleProfileAuth({ profileName: "dev", profile: "dev" })).toEqual({
      valid: true,
      ...IDENTITY,
      accessKeyId: "AKIA_DEV",
      secretAccessKey: "dev-secret",
      sessionToken: undefined,
      region: "eu-west-1",
    })
    expect(resolved).toEqual(["dev"])
    expect(validated).toEqual([[CREDENTIALS, "us-east-1"]])
  })

  it("replies { valid: false, error } instead of rejecting", async () => {
    aws.validateCredentials = () =>
      Effect.fail(new AwsAuthError({ message: "Failed to validate credentials: ExpiredToken" }))

    expect(await handleProfileAuth({ profileName: "dev" })).toEqual({
      valid: false,
      error: "Failed to validate credentials: ExpiredToken",
    })
  })
})
