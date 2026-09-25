import { describe, it, expect } from "bun:test"
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

  it("prefers AWS_REGION over AWS_DEFAULT_REGION", async () => {
    const layer = makeTestEnvironment({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
      AWS_REGION: "eu-west-1",
      AWS_DEFAULT_REGION: "us-west-2",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials().pipe(Effect.provide(layer)),
    )
    expect(result!.region).toBe("eu-west-1")
  })

  it("treats an empty prefix as no prefix", async () => {
    const layer = makeTestEnvironment({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("").pipe(Effect.provide(layer)),
    )
    expect(result?.accessKeyId).toBe("AKID")
  })
})

describe("detectEnvCredentials — {env:{prefix}} variant", () => {
  it("reads every variable with the prefix prepended", async () => {
    const layer = makeTestEnvironment({
      PROD_AWS_ACCESS_KEY_ID: "PROD_AKID",
      PROD_AWS_SECRET_ACCESS_KEY: "PROD_SECRET",
      PROD_AWS_SESSION_TOKEN: "PROD_TOKEN",
      PROD_AWS_REGION: "eu-central-1",
      // The ambient (e.g. dev) credentials must not leak into any field.
      AWS_ACCESS_KEY_ID: "DEV_AKID",
      AWS_SECRET_ACCESS_KEY: "DEV_SECRET",
      AWS_SESSION_TOKEN: "DEV_TOKEN",
      AWS_REGION: "us-west-2",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("PROD_").pipe(Effect.provide(layer)),
    )
    expect(result).toEqual({
      accessKeyId: "PROD_AKID",
      secretAccessKey: "PROD_SECRET",
      sessionToken: "PROD_TOKEN",
      region: "eu-central-1",
    })
  })

  it("falls back to <PREFIX>AWS_DEFAULT_REGION, not the unprefixed region", async () => {
    const layer = makeTestEnvironment({
      PROD_AWS_ACCESS_KEY_ID: "PROD_AKID",
      PROD_AWS_SECRET_ACCESS_KEY: "PROD_SECRET",
      PROD_AWS_DEFAULT_REGION: "ap-southeast-2",
      AWS_REGION: "us-west-2",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("PROD_").pipe(Effect.provide(layer)),
    )
    expect(result!.region).toBe("ap-southeast-2")
  })

  it("never falls back to the unprefixed keys", async () => {
    const layer = makeTestEnvironment({
      AWS_ACCESS_KEY_ID: "DEV_AKID",
      AWS_SECRET_ACCESS_KEY: "DEV_SECRET",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("PROD_").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("needs both prefixed keys, not a prefixed ID with the unprefixed secret", async () => {
    const layer = makeTestEnvironment({
      PROD_AWS_ACCESS_KEY_ID: "PROD_AKID",
      AWS_SECRET_ACCESS_KEY: "DEV_SECRET",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("PROD_").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  it("treats an allowlist-violating prefix as absent (defense in depth)", async () => {
    const layer = makeTestEnvironment({
      lower_AWS_ACCESS_KEY_ID: "AKID",
      lower_AWS_SECRET_ACCESS_KEY: "SECRET",
    })
    const result = await Effect.runPromise(
      detectEnvCredentials("lower_").pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
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
        validateCredentials: (_creds, region) => {
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
    expect(result.credentials.accessKeyId).toBe("AKID")
    expect(result.identity.accountId).toBe("123456789012")
    expect(result.identity.arn).toBe("arn:aws:iam::123456789012:user/test")
  })

  it("confirms the prefixed credentials, not the ambient ones", async () => {
    const seen: string[] = []
    const layer = Layer.merge(
      makeTestEnvironment({
        PROD_AWS_ACCESS_KEY_ID: "PROD_AKID",
        PROD_AWS_SECRET_ACCESS_KEY: "PROD_SECRET",
        AWS_ACCESS_KEY_ID: "DEV_AKID",
        AWS_SECRET_ACCESS_KEY: "DEV_SECRET",
      }),
      makeTestAwsClient({
        validateCredentials: (creds) => {
          seen.push(creds.accessKeyId)
          return Effect.succeed({ accountId: "222222222222", arn: "arn:aws:iam::222222222222:user/prod" })
        },
      }),
    )
    const result = await Effect.runPromise(
      confirmEnvCredentials("PROD_").pipe(Effect.provide(layer)),
    )
    expect(seen).toEqual(["PROD_AKID"])
    expect(result.credentials.secretAccessKey).toBe("PROD_SECRET")
  })

  describe("region", () => {
    const confirmRegion = async (env: Record<string, string>, defaultRegion?: string) => {
      const layer = Layer.merge(
        makeTestEnvironment({ AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET", ...env }),
        makeTestAwsClient({
          validateCredentials: (_creds, region) => {
            // STS is always called in us-east-1, whatever the working region.
            expect(region).toBe("us-east-1")
            return Effect.succeed({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/test" })
          },
        }),
      )
      const result = await Effect.runPromise(
        confirmEnvCredentials(undefined, defaultRegion).pipe(Effect.provide(layer)),
      )
      return result.credentials.region
    }

    it("uses the environment's region first", async () => {
      expect(await confirmRegion({ AWS_REGION: "eu-west-1" }, "ap-south-1")).toBe("eu-west-1")
    })

    it("falls back to the block's defaultRegion, not us-east-1", async () => {
      expect(await confirmRegion({}, "ap-south-1")).toBe("ap-south-1")
    })

    it("uses us-east-1 only when nothing names a region", async () => {
      expect(await confirmRegion({})).toBe("us-east-1")
      expect(await confirmRegion({}, "")).toBe("us-east-1")
    })
  })
})
