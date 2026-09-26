import { describe, it, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { detectEnvCredentials, confirmEnvCredentials, pollSsoFlow, validateCredentials } from "./auth.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { makeTestAwsClient } from "../../test-utils/TestLayer.ts"
import { AwsAuthError, AwsSsoError } from "../../errors/index.ts"
import type { AwsClientShape, SsoAccount } from "../../services/AwsClient.ts"

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
        AWS_REGION: "us-west-2",
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
      confirmEnvCredentials("PROD_", "us-west-2").pipe(Effect.provide(layer)),
    )
    expect(seen).toEqual(["PROD_AKID"])
    expect(result.credentials.secretAccessKey).toBe("PROD_SECRET")
  })

  describe("region", () => {
    /** Confirms env credentials, recording the region STS was called in. */
    const confirmRegion = async (env: Record<string, string>, defaultRegion?: string) => {
      let stsRegion: string | undefined
      const layer = Layer.merge(
        makeTestEnvironment({ AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET", ...env }),
        makeTestAwsClient({
          validateCredentials: (_creds, region) => {
            stsRegion = region
            return Effect.succeed({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/test" })
          },
        }),
      )
      const exit = await Effect.runPromiseExit(
        confirmEnvCredentials(undefined, defaultRegion).pipe(Effect.provide(layer)),
      )
      return { exit, stsRegion }
    }

    const workingRegion = (exit: Exit.Exit<{ credentials: { region: string } }, unknown>) => {
      if (!Exit.isSuccess(exit)) throw new Error(`expected confirm to succeed: ${Cause.pretty(exit.cause)}`)
      return exit.value.credentials.region
    }

    it("uses the environment's region first", async () => {
      const { exit, stsRegion } = await confirmRegion({ AWS_REGION: "eu-west-1" }, "ap-south-1")
      expect(workingRegion(exit)).toBe("eu-west-1")
      expect(stsRegion).toBe("us-east-1")
    })

    it("falls back to the block's defaultRegion", async () => {
      const { exit } = await confirmRegion({}, "ap-south-1")
      expect(workingRegion(exit)).toBe("ap-south-1")
    })

    it("validates GovCloud credentials against GovCloud STS", async () => {
      const { exit, stsRegion } = await confirmRegion({ AWS_DEFAULT_REGION: "us-gov-east-1" })
      expect(workingRegion(exit)).toBe("us-gov-east-1")
      expect(stsRegion).toBe("us-gov-west-1")
    })

    it("takes the partition from a GovCloud defaultRegion", async () => {
      const { exit, stsRegion } = await confirmRegion({}, "us-gov-east-1")
      expect(workingRegion(exit)).toBe("us-gov-east-1")
      expect(stsRegion).toBe("us-gov-west-1")
    })

    it("fails instead of guessing a region when nothing names one", async () => {
      for (const defaultRegion of [undefined, ""]) {
        const { exit, stsRegion } = await confirmRegion({}, defaultRegion)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toContain("No AWS region")
        expect(stsRegion).toBeUndefined()
      }
    })
  })
})

/**
 * The SSO device flow after the user approves in the browser: the poll carries
 * the flow as far as it can without asking (Go backend parity), and every SSO
 * call goes to the region the flow was started in.
 */
describe("pollSsoFlow", () => {
  const SSO_REGION = "eu-central-1"
  const POLL = { clientId: "cid", clientSecret: "csecret", deviceCode: "dc-1", region: SSO_REGION }
  const ACCOUNT_A: SsoAccount = { accountId: "111111111111", accountName: "prod" }
  const ACCOUNT_B: SsoAccount = { accountId: "222222222222", accountName: "dev" }
  const ROLE_CREDS = {
    accessKeyId: "ASIA_ROLE",
    secretAccessKey: "role-secret",
    sessionToken: "role-token",
    region: SSO_REGION,
  }
  const IDENTITY = { accountId: "111111111111", arn: "arn:aws:sts::111111111111:assumed-role/Admin/me" }

  /**
   * Runs one poll. Every SSO call records the region it was sent to; the
   * token is granted and account/role listings are empty unless overridden.
   */
  const run = async (
    overrides: Partial<AwsClientShape>,
    extra: { accountId?: string; roleName?: string } = {},
  ) => {
    const regions: string[] = []
    const completed: unknown[] = []
    const layer = makeTestAwsClient({
      pollSsoToken: (params) => {
        regions.push(params.region)
        return Effect.succeed({ accessToken: "sso-token" })
      },
      completeSsoAuth: (params) => {
        regions.push(params.region)
        completed.push(params)
        return Effect.succeed(ROLE_CREDS)
      },
      validateCredentials: () => Effect.succeed(IDENTITY),
      ...overrides,
      listSsoAccounts: (token, region) => {
        regions.push(region)
        return overrides.listSsoAccounts?.(token, region) ?? Effect.succeed([])
      },
      listSsoRoles: (token, accountId, region) => {
        regions.push(region)
        return overrides.listSsoRoles?.(token, accountId, region) ?? Effect.succeed([])
      },
    })
    const exit = await Effect.runPromiseExit(
      pollSsoFlow({ ...POLL, ...extra }).pipe(Effect.provide(layer)),
    )
    return { exit, regions, completed }
  }

  const outcome = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isSuccess(exit)) throw new Error(`expected the poll to succeed: ${Cause.pretty(exit.cause)}`)
    return exit.value
  }

  const failureMessage = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) throw new Error("expected the poll to fail")
    const err = Cause.failureOption(exit.cause)
    if (err._tag === "None") throw new Error("expected a typed failure")
    return (err.value as { message: string }).message
  }

  it("is pending until the user approves", async () => {
    const { exit } = await run({ pollSsoToken: () => Effect.succeed({ pending: true }) })
    expect(outcome(exit)).toEqual({ status: "pending" })
  })

  it("signs in to the pinned account and role without listing accounts", async () => {
    const { exit, regions, completed } = await run({}, { accountId: "111111111111", roleName: "Admin" })

    expect(outcome(exit)).toEqual({ status: "success", credentials: ROLE_CREDS, identity: IDENTITY })
    expect(completed).toEqual([
      { accessToken: "sso-token", accountId: "111111111111", roleName: "Admin", region: SSO_REGION },
    ])
    // pollSsoToken, then completeSsoAuth: no listing call.
    expect(regions).toEqual([SSO_REGION, SSO_REGION])
  })

  it("lists accounts when only one of account and role is pinned", async () => {
    const { exit } = await run(
      { listSsoAccounts: () => Effect.succeed([ACCOUNT_A, ACCOUNT_B]) },
      { accountId: "111111111111" },
    )
    expect(outcome(exit)).toEqual({
      status: "select_account",
      accessToken: "sso-token",
      accounts: [ACCOUNT_A, ACCOUNT_B],
    })
  })

  it("asks the user to choose when there are several accounts", async () => {
    const { exit, regions, completed } = await run({
      listSsoAccounts: () => Effect.succeed([ACCOUNT_A, ACCOUNT_B]),
    })

    expect(outcome(exit)).toEqual({
      status: "select_account",
      accessToken: "sso-token",
      accounts: [ACCOUNT_A, ACCOUNT_B],
    })
    expect(completed).toEqual([])
    expect(regions).toEqual([SSO_REGION, SSO_REGION])
  })

  it("signs in without asking when there is one account with one role", async () => {
    const { exit, regions, completed } = await run({
      listSsoAccounts: () => Effect.succeed([ACCOUNT_A]),
      listSsoRoles: (_token, accountId) => Effect.succeed([{ roleName: "ReadOnly", accountId }]),
    })

    expect(outcome(exit)).toEqual({ status: "success", credentials: ROLE_CREDS, identity: IDENTITY })
    expect(completed).toEqual([
      { accessToken: "sso-token", accountId: "111111111111", roleName: "ReadOnly", region: SSO_REGION },
    ])
    // poll, list accounts, list roles, complete — all in the SSO region.
    expect(regions).toEqual([SSO_REGION, SSO_REGION, SSO_REGION, SSO_REGION])
  })

  it("asks the user to choose when the one account has several roles", async () => {
    const { exit, completed } = await run({
      listSsoAccounts: () => Effect.succeed([ACCOUNT_A]),
      listSsoRoles: (_token, accountId) =>
        Effect.succeed([{ roleName: "ReadOnly", accountId }, { roleName: "Admin", accountId }]),
    })

    expect(outcome(exit)).toEqual({ status: "select_account", accessToken: "sso-token", accounts: [ACCOUNT_A] })
    expect(completed).toEqual([])
  })

  it("fails when no accounts are available", async () => {
    const { exit } = await run({ listSsoAccounts: () => Effect.succeed([]) })
    expect(failureMessage(exit)).toContain("No AWS accounts are available")
  })

  it("fails when the one account has no roles", async () => {
    const { exit } = await run({ listSsoAccounts: () => Effect.succeed([ACCOUNT_A]) })
    expect(failureMessage(exit)).toContain("No roles are available to you in account 111111111111")
  })

  it("fails when the approved token poll returns no access token", async () => {
    const { exit } = await run({ pollSsoToken: () => Effect.succeed({}) })
    expect(failureMessage(exit)).toContain("without an access token")
  })

  it("fails with the SSO error when the token poll fails", async () => {
    const { exit } = await run({
      pollSsoToken: () => Effect.fail(new AwsSsoError({ message: "The SSO sign-in request expired. Please try again." })),
    })
    expect(failureMessage(exit)).toBe("The SSO sign-in request expired. Please try again.")
  })

  it("validates the role credentials in the partition of the SSO region", async () => {
    const stsRegions: string[] = []
    const record = { validateCredentials: (_creds: unknown, region: string) => {
      stsRegions.push(region)
      return Effect.succeed(IDENTITY)
    } }
    await run(record, { accountId: "111111111111", roleName: "Admin" })
    const gov = makeTestAwsClient({
      pollSsoToken: () => Effect.succeed({ accessToken: "sso-token" }),
      completeSsoAuth: () => Effect.succeed({ ...ROLE_CREDS, region: "us-gov-east-1" }),
      ...record,
    })
    await Effect.runPromise(
      pollSsoFlow({ ...POLL, region: "us-gov-east-1", accountId: "111111111111", roleName: "Admin" }).pipe(Effect.provide(gov)),
    )
    expect(stsRegions).toEqual(["us-east-1", "us-gov-west-1"])
  })

  it("fails when the role credentials do not validate", async () => {
    const { exit } = await run(
      { validateCredentials: () => Effect.fail(new AwsAuthError({ message: "sts said no" })) },
      { accountId: "111111111111", roleName: "Admin" },
    )
    expect(failureMessage(exit)).toBe("sts said no")
  })
})

describe("validateCredentials", () => {
  const creds = { accessKeyId: "AKID", secretAccessKey: "SECRET", region: "us-gov-west-1" }

  it("sends GovCloud credentials to GovCloud STS", async () => {
    let stsRegion: string | undefined
    const layer = makeTestAwsClient({
      validateCredentials: (_creds, region) => {
        stsRegion = region
        return Effect.succeed({ accountId: "123456789012", arn: "arn:aws-us-gov:iam::123456789012:user/test" })
      },
    })
    await Effect.runPromise(validateCredentials(creds, "us-gov-west-1").pipe(Effect.provide(layer)))
    expect(stsRegion).toBe("us-gov-west-1")
  })

  it("sends commercial credentials to us-east-1 STS whatever region was picked", async () => {
    let stsRegion: string | undefined
    const layer = makeTestAwsClient({
      validateCredentials: (_creds, region) => {
        stsRegion = region
        return Effect.succeed({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/test" })
      },
    })
    await Effect.runPromise(validateCredentials({ ...creds, region: "eu-west-2" }, "eu-west-2").pipe(Effect.provide(layer)))
    expect(stsRegion).toBe("us-east-1")
  })
})
