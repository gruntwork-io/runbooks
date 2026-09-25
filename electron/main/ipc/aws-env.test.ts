import { describe, it, expect, spyOn, beforeEach, afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import { runtime, sessionManager } from "./runtime.ts"
import { handleEnvCredentials, handleEnvCredentialsConfirm } from "./aws-env.ts"
import { makeTestEnvironment } from "../../../src/test-utils/TestEnvironment.ts"
import { makeTestAwsClient } from "../../../src/test-utils/TestLayer.ts"
import { AwsAuthError } from "../../../src/errors/index.ts"
import type { AwsClient, AwsClientShape } from "../../../src/services/AwsClient.ts"
import type { Environment } from "../../../src/services/Environment.ts"

/**
 * The aws:env-credentials / aws:env-credentials-confirm replies as the
 * renderer receives them. The shared runtime runs each effect against the test
 * Environment (the process env) and AwsClient (STS); the domain functions and
 * the session manager are the real ones.
 */

let processEnv: Record<string, string> = {}
let validateCredentials: AwsClientShape["validateCredentials"]

const runPromise = spyOn(runtime, "runPromise").mockImplementation(
  (<A, E>(effect: Effect.Effect<A, E, Environment | AwsClient>) =>
    Effect.runPromise(
      Effect.provide(
        effect,
        Layer.merge(makeTestEnvironment(processEnv), makeTestAwsClient({ validateCredentials })),
      ),
    )) as typeof runtime.runPromise,
)

afterAll(() => {
  runPromise.mockRestore()
  sessionManager.deleteSession()
})

/** The session env, as the next script would receive it. */
const sessionEnv = () =>
  Effect.runSync(sessionManager.getSession().pipe(Effect.map((s) => Object.fromEntries(s.env))))

const IDENTITY = {
  accountId: "111122223333",
  accountName: "prod",
  arn: "arn:aws:iam::111122223333:user/deployer",
}

beforeEach(() => {
  processEnv = {}
  validateCredentials = () => Effect.succeed(IDENTITY)
  // A session left over from an earlier SSO sign-in in another block.
  Effect.runSync(
    sessionManager.createSession("/tmp").pipe(
      Effect.provide(makeTestEnvironment({ AWS_SESSION_TOKEN: "stale-sso-token", PATH: "/usr/bin" })),
    ),
  )
})

describe("aws:env-credentials", () => {
  it("returns found/valid identity metadata and never the key material", async () => {
    processEnv = {
      AWS_ACCESS_KEY_ID: "AKIA_DEV",
      AWS_SECRET_ACCESS_KEY: "dev-secret",
      AWS_SESSION_TOKEN: "dev-token",
      AWS_REGION: "eu-west-1",
    }
    const before = sessionEnv()

    const reply = await handleEnvCredentials({ prefix: "", defaultRegion: "us-west-2" })

    expect(reply).toEqual({
      found: true,
      valid: true,
      ...IDENTITY,
      region: "eu-west-1",
      hasSessionToken: true,
    })
    const serialized = JSON.stringify(reply)
    expect(serialized).not.toContain("AKIA_DEV")
    expect(serialized).not.toContain("dev-secret")
    expect(serialized).not.toContain("dev-token")
    // Detection is read-only.
    expect(sessionEnv()).toEqual(before)
  })

  it("reports the block's defaultRegion when the environment names none", async () => {
    processEnv = { AWS_ACCESS_KEY_ID: "AKIA_DEV", AWS_SECRET_ACCESS_KEY: "dev-secret" }

    const reply = await handleEnvCredentials({ prefix: "", defaultRegion: "ap-south-1" })

    expect(reply.region).toBe("ap-south-1")
    expect(reply.hasSessionToken).toBe(false)
  })

  it("returns found:false when no credentials are set", async () => {
    expect(await handleEnvCredentials({ prefix: "", defaultRegion: "" })).toEqual({ found: false })
  })

  it("returns found but invalid when STS rejects the credentials", async () => {
    processEnv = { AWS_ACCESS_KEY_ID: "AKIA_OLD", AWS_SECRET_ACCESS_KEY: "expired" }
    validateCredentials = () => Effect.fail(new AwsAuthError({ message: "ExpiredToken" }))

    const reply = await handleEnvCredentials({ prefix: "" })

    expect(reply.found).toBe(true)
    expect(reply.valid).toBe(false)
    expect(reply.error).toContain("ExpiredToken")
  })

  it("reads only the prefixed variables for a prefixed source", async () => {
    processEnv = { AWS_ACCESS_KEY_ID: "AKIA_DEV", AWS_SECRET_ACCESS_KEY: "dev-secret" }

    expect(await handleEnvCredentials({ prefix: "PROD_" })).toEqual({ found: false })

    const validated: string[] = []
    validateCredentials = (creds) => {
      validated.push(creds.accessKeyId)
      return Effect.succeed(IDENTITY)
    }
    processEnv = {
      ...processEnv,
      PROD_AWS_ACCESS_KEY_ID: "AKIA_PROD",
      PROD_AWS_SECRET_ACCESS_KEY: "prod-secret",
    }

    const reply = await handleEnvCredentials({ prefix: "PROD_" })

    expect(reply.valid).toBe(true)
    expect(validated).toEqual(["AKIA_PROD"])
  })

  it("rejects a prefix that fails the allowlist", async () => {
    processEnv = { "prod-AWS_ACCESS_KEY_ID": "AKIA_X", "prod-AWS_SECRET_ACCESS_KEY": "x" }

    const reply = await handleEnvCredentials({ prefix: "prod-" })

    expect(reply.found).toBe(false)
    expect(reply.error).toContain('Invalid env prefix "prod-"')
  })
})

describe("aws:env-credentials-confirm", () => {
  it("writes AWS_REGION and clears a stale session token for static keys", async () => {
    processEnv = { AWS_ACCESS_KEY_ID: "AKIA_DEV", AWS_SECRET_ACCESS_KEY: "dev-secret" }

    const reply = await handleEnvCredentialsConfirm({ prefix: "", defaultRegion: "us-west-2" })

    expect(reply).toEqual({
      valid: true,
      ...IDENTITY,
      accessKeyId: "AKIA_DEV",
      secretAccessKey: "dev-secret",
      sessionToken: undefined,
      region: "us-west-2",
    })
    expect(sessionEnv()).toEqual({
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: "AKIA_DEV",
      AWS_SECRET_ACCESS_KEY: "dev-secret",
      AWS_REGION: "us-west-2",
      AWS_SESSION_TOKEN: "",
    })
  })

  it("confirms the prefixed credentials with their session token", async () => {
    processEnv = {
      AWS_ACCESS_KEY_ID: "AKIA_DEV",
      AWS_SECRET_ACCESS_KEY: "dev-secret",
      PROD_AWS_ACCESS_KEY_ID: "ASIA_PROD",
      PROD_AWS_SECRET_ACCESS_KEY: "prod-secret",
      PROD_AWS_SESSION_TOKEN: "prod-token",
      PROD_AWS_REGION: "eu-central-1",
    }

    const reply = await handleEnvCredentialsConfirm({ prefix: "PROD_", defaultRegion: "us-east-1" })

    expect(reply.valid).toBe(true)
    expect(reply.accessKeyId).toBe("ASIA_PROD")
    expect(sessionEnv()).toMatchObject({
      AWS_ACCESS_KEY_ID: "ASIA_PROD",
      AWS_SECRET_ACCESS_KEY: "prod-secret",
      AWS_REGION: "eu-central-1",
      AWS_SESSION_TOKEN: "prod-token",
    })
  })

  it("writes nothing and returns valid:false when STS rejects the credentials", async () => {
    processEnv = { AWS_ACCESS_KEY_ID: "AKIA_OLD", AWS_SECRET_ACCESS_KEY: "expired" }
    validateCredentials = () => Effect.fail(new AwsAuthError({ message: "ExpiredToken" }))
    const before = sessionEnv()

    const reply = await handleEnvCredentialsConfirm({ prefix: "" })

    expect(reply.valid).toBe(false)
    expect(reply.error).toContain("ExpiredToken")
    expect(sessionEnv()).toEqual(before)
  })

  it("returns valid:false when the credentials are gone at confirm time", async () => {
    const before = sessionEnv()

    const reply = await handleEnvCredentialsConfirm({ prefix: "" })

    expect(reply.valid).toBe(false)
    expect(reply.error).toContain("No AWS credentials found")
    expect(sessionEnv()).toEqual(before)
  })

  it("rejects a prefix that fails the allowlist and writes nothing", async () => {
    processEnv = { AWS_ACCESS_KEY_ID: "AKIA_DEV", AWS_SECRET_ACCESS_KEY: "dev-secret" }
    const before = sessionEnv()

    const reply = await handleEnvCredentialsConfirm({ prefix: "../" })

    expect(reply.valid).toBe(false)
    expect(reply.error).toContain('Invalid env prefix "../"')
    expect(sessionEnv()).toEqual(before)
  })
})
