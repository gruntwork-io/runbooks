import { describe, it, expect } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { detectEnvCredentials, confirmEnvCredentials } from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestAwsClient } from "../../test-utils/TestLayer.ts"

describe("detectEnvCredentials", () => {
  it("returns credentials when both keys are set", async () => {
    const layer = makeTestEnvironment({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeDefined()
    expect(result!.accessKeyId).toBe("AKID")
    expect(result!.secretAccessKey).toBe("SECRET")
  })

  it("returns undefined when access key is missing", async () => {
    const layer = makeTestEnvironment({
      AWS_SECRET_ACCESS_KEY: "SECRET",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("returns undefined when secret key is missing", async () => {
    const layer = makeTestEnvironment({
      AWS_ACCESS_KEY_ID: "AKID",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("includes optional session token and region", async () => {
    const layer = makeTestEnvironment({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
      AWS_SESSION_TOKEN: "TOKEN",
      AWS_DEFAULT_REGION: "eu-west-1",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result!.sessionToken).toBe("TOKEN")
    expect(result!.region).toBe("eu-west-1")
  })

  it("supports custom env var name for access key ID", async () => {
    const layer = makeTestEnvironment({
      CUSTOM_KEY_ID: "CUSTOM_AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("CUSTOM_KEY_ID").pipe(Effect.provide(layer)),
    )
    expect(result).toBeDefined()
    expect(result!.accessKeyId).toBe("CUSTOM_AKID")
  })
})

describe("confirmEnvCredentials", () => {
  it("fails with AwsAuthError when no env credentials found", async () => {
    const layer = Layer.merge(
      makeTestEnvironment({}),
      makeTestAwsClient(),
    )
    const exit = await Effect.runPromiseExit(
      confirmEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("validates credentials via STS when env credentials found", async () => {
    let validated = false
    const layer = Layer.merge(
      makeTestEnvironment({
        AWS_ACCESS_KEY_ID: "AKID",
        AWS_SECRET_ACCESS_KEY: "SECRET",
      }),
      makeTestAwsClient({
        validateCredentials: (creds, region) => {
          validated = true
          expect(region).toBe("us-east-1")
          return Effect.succeed({
            accountId: "123456789012",
            arn: "arn:aws:iam::123456789012:user/test",
            userId: "AIDTEST",
          })
        },
      }),
    )
    const result = await Effect.runPromise(
      confirmEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(validated).toBe(true)
    expect(result.accessKeyId).toBe("AKID")
  })
})
