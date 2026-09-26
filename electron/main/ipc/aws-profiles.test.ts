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
  it("resolves the profile and validates it once, in the profile's region", async () => {
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
    // The working region; AwsSdkClient routes STS to its partition's home region.
    expect(validated).toEqual([[CREDENTIALS, "eu-west-1"]])
  })

  it("validates a GovCloud profile in its GovCloud region", async () => {
    const validated: string[] = []
    aws.authenticateProfile = () => Effect.succeed({ ...CREDENTIALS, region: "us-gov-east-1" })
    aws.validateCredentials = (_creds, region) => {
      validated.push(region)
      return Effect.succeed(IDENTITY)
    }

    const reply = await handleProfileAuth({ profileName: "gov", defaultRegion: "us-west-2" })

    expect(reply).toMatchObject({ valid: true, region: "us-gov-east-1" })
    expect(validated).toEqual(["us-gov-east-1"])
  })

  it("uses the block's region for a profile that names none", async () => {
    const validated: string[] = []
    aws.authenticateProfile = () => Effect.succeed({ ...CREDENTIALS, region: "" })
    aws.validateCredentials = (_creds, region) => {
      validated.push(region)
      return Effect.succeed(IDENTITY)
    }

    const reply = await handleProfileAuth({ profileName: "gov", defaultRegion: "us-gov-west-1" })

    expect(reply).toMatchObject({ valid: true, region: "us-gov-west-1" })
    expect(validated).toEqual(["us-gov-west-1"])
  })

  it("fails instead of guessing when neither the profile nor the block names a region", async () => {
    let validated = false
    aws.authenticateProfile = () => Effect.succeed({ ...CREDENTIALS, region: "" })
    aws.validateCredentials = () => {
      validated = true
      return Effect.succeed(IDENTITY)
    }

    const reply = await handleProfileAuth({ profileName: "dev" })

    expect(reply.valid).toBe(false)
    expect(reply.error).toContain('No AWS region for profile "dev"')
    expect(validated).toBe(false)
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
