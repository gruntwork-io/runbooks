import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Either } from "effect"
import {
  SSOOIDCClient,
  CreateTokenCommand,
  AccessDeniedException,
  AuthorizationPendingException,
  ExpiredTokenException,
  SlowDownException,
} from "@aws-sdk/client-sso-oidc"
import { SSOClient, ListAccountsCommand, ListAccountRolesCommand } from "@aws-sdk/client-sso"
import { STSClient } from "@aws-sdk/client-sts"
import { AccountClient, GetRegionOptStatusCommand } from "@aws-sdk/client-account"
import { AwsSdkClientLive } from "./AwsSdkClient.ts"
import { AwsClient } from "../services/AwsClient.ts"
import type { AwsClientShape } from "../services/AwsClient.ts"

/**
 * The SSO device flow against the live layer, with the SDK's `send` stubbed at
 * the network boundary. Each stub records the region of the client that sent
 * the command, as the SDK resolved it.
 *
 * The OIDC client is registered in the IAM Identity Center region, so every
 * later call has to go to that region's endpoint too. A client built without
 * one throws "Region is missing" when nothing ambient names a region, and
 * otherwise talks to whatever region AWS_REGION / ~/.aws/config happens to
 * name. SSO_REGION is deliberately one nobody has as their default.
 */
const SSO_REGION = "ap-southeast-4"

const run = <A, E>(f: (client: AwsClientShape) => Effect.Effect<A, E>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.provide(Effect.either(Effect.flatMap(AwsClient, f)), AwsSdkClientLive))

const exception = <T>(Ctor: new (opts: { message: string; $metadata: object }) => T) =>
  new Ctor({ message: "from AWS", $metadata: {} })

type Sent = { region: string; command: unknown }

/** Stub `send` on an SDK client class; `reply` sees each command in turn. */
function stubSend(
  Client: typeof SSOOIDCClient | typeof SSOClient,
  reply: (command: unknown, index: number) => unknown,
) {
  const sent: Sent[] = []
  const spy = spyOn(Client.prototype, "send").mockImplementation(async function (
    this: SSOOIDCClient | SSOClient,
    command: unknown,
  ) {
    const index = sent.length
    sent.push({ region: await this.config.region(), command })
    return reply(command, index)
  } as never)
  return { sent, spy }
}

let spies: { mockRestore: () => void }[] = []
const stub = (...args: Parameters<typeof stubSend>) => {
  const s = stubSend(...args)
  spies.push(s.spy)
  return s.sent
}

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  spies = []
})

const POLL = { clientId: "cid", clientSecret: "csecret", deviceCode: "dc-1", region: SSO_REGION }

describe("AwsSdkClient.pollSsoToken", () => {
  it("sends CreateToken to the SSO region and returns the token", async () => {
    const sent = stub(SSOOIDCClient, () => ({ accessToken: "sso-token" }))

    const result = await run((c) => c.pollSsoToken(POLL))

    expect(result).toEqual(Either.right({ accessToken: "sso-token" }))
    expect(sent).toHaveLength(1)
    expect(sent[0].region).toBe(SSO_REGION)
    expect(sent[0].command).toBeInstanceOf(CreateTokenCommand)
  })

  it("is pending while authorization is pending", async () => {
    stub(SSOOIDCClient, () => {
      throw exception(AuthorizationPendingException)
    })
    expect(await run((c) => c.pollSsoToken(POLL))).toEqual(Either.right({ pending: true }))
  })

  it("is pending, not failed, when AWS asks the client to slow down", async () => {
    stub(SSOOIDCClient, () => {
      throw exception(SlowDownException)
    })
    expect(await run((c) => c.pollSsoToken(POLL))).toEqual(Either.right({ pending: true }))
  })

  it("explains a denied sign-in", async () => {
    stub(SSOOIDCClient, () => {
      throw exception(AccessDeniedException)
    })
    const result = await run((c) => c.pollSsoToken(POLL))
    expect(Either.isLeft(result) && result.left._tag).toBe("AwsSsoError")
    expect(Either.isLeft(result) && result.left.message).toBe("SSO sign-in was denied or cancelled in the browser")
  })

  it("explains an expired sign-in request", async () => {
    stub(SSOOIDCClient, () => {
      throw exception(ExpiredTokenException)
    })
    const result = await run((c) => c.pollSsoToken(POLL))
    expect(Either.isLeft(result) && result.left.message).toBe("The SSO sign-in request expired. Please try again.")
  })

  it("keeps the SDK's text for any other failure", async () => {
    stub(SSOOIDCClient, () => {
      throw new Error("socket hang up")
    })
    const result = await run((c) => c.pollSsoToken(POLL))
    expect(Either.isLeft(result) && result.left.message).toContain("Failed to poll SSO token")
    expect(Either.isLeft(result) && result.left.message).toContain("socket hang up")
  })
})

describe("AwsSdkClient.listSsoAccounts", () => {
  it("lists every page from the SSO region", async () => {
    const sent = stub(SSOClient, (_command, index) =>
      index === 0
        ? { accountList: [{ accountId: "111111111111", accountName: "prod", emailAddress: "p@x" }], nextToken: "page-2" }
        : { accountList: [{ accountId: "222222222222", accountName: "dev" }] },
    )

    const result = await run((c) => c.listSsoAccounts("sso-token", SSO_REGION))

    expect(result).toEqual(
      Either.right([
        { accountId: "111111111111", accountName: "prod", emailAddress: "p@x" },
        { accountId: "222222222222", accountName: "dev", emailAddress: undefined },
      ]),
    )
    expect(sent.map((s) => s.region)).toEqual([SSO_REGION, SSO_REGION])
    expect(sent[0].command).toBeInstanceOf(ListAccountsCommand)
    expect((sent[1].command as ListAccountsCommand).input).toEqual({ accessToken: "sso-token", nextToken: "page-2" })
  })
})

describe("AwsSdkClient.listSsoRoles", () => {
  it("lists every page from the SSO region", async () => {
    const sent = stub(SSOClient, (_command, index) =>
      index === 0
        ? { roleList: [{ roleName: "ReadOnly", accountId: "111111111111" }], nextToken: "page-2" }
        : { roleList: [{ roleName: "Admin" }] },
    )

    const result = await run((c) => c.listSsoRoles("sso-token", "111111111111", SSO_REGION))

    expect(result).toEqual(
      Either.right([
        { roleName: "ReadOnly", accountId: "111111111111" },
        { roleName: "Admin", accountId: "111111111111" },
      ]),
    )
    expect(sent.map((s) => s.region)).toEqual([SSO_REGION, SSO_REGION])
    expect(sent[0].command).toBeInstanceOf(ListAccountRolesCommand)
    expect((sent[1].command as ListAccountRolesCommand).input).toEqual({
      accessToken: "sso-token",
      accountId: "111111111111",
      nextToken: "page-2",
    })
  })
})

/**
 * Local profiles, read from real fixture files that AWS_CONFIG_FILE and
 * AWS_SHARED_CREDENTIALS_FILE point at (the same variables the SDK's fromIni
 * honors), so the developer's own ~/.aws never leaks in.
 */
describe("AwsSdkClient local profiles", () => {
  let dir: string
  const saved = {
    AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
    AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
  }

  const writeConfig = (text: string) => fs.writeFileSync(path.join(dir, "config"), text)
  const writeCredentials = (text: string) => fs.writeFileSync(path.join(dir, "credentials"), text)
  const keys = (id: string) => `aws_access_key_id = ${id}\naws_secret_access_key = secret-${id}\n`

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-aws-profiles-"))
    process.env.AWS_CONFIG_FILE = path.join(dir, "config")
    process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, "credentials")
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe("listProfiles", () => {
    it("merges the region in config with the keys in credentials (the `aws configure` layout)", async () => {
      writeConfig("[default]\nregion = us-west-2\n\n[profile staging]\nregion = eu-west-1\noutput = json\n")
      writeCredentials(`[default]\n${keys("AKIA_DEFAULT")}\n[staging]\n${keys("AKIA_STAGING")}`)

      expect(await run((c) => c.listProfiles())).toEqual(
        Either.right([
          { name: "default", region: "us-west-2", authType: "static" },
          { name: "staging", region: "eu-west-1", authType: "static" },
        ]),
      )
    })

    it("keeps dotted profile names whole", async () => {
      writeConfig("[profile acme.prod]\nregion = eu-central-1\n")
      writeCredentials(`[acme.prod]\n${keys("AKIA_ACME")}`)

      expect(await run((c) => c.listProfiles())).toEqual(
        Either.right([{ name: "acme.prod", region: "eu-central-1", authType: "static" }]),
      )
    })

    it("classifies SSO and assume-role profiles, and lists no sso-session or services section", async () => {
      writeConfig(
        [
          "[sso-session acme]",
          "sso_start_url = https://acme.awsapps.com/start",
          "sso_region = us-east-1",
          "[services local]",
          "s3 =",
          "  endpoint_url = http://localhost:9000",
          "[profile sso-new]",
          "sso_session = acme",
          "sso_account_id = 111111111111",
          "sso_role_name = Admin",
          "[profile sso-legacy]",
          "sso_start_url = https://acme.awsapps.com/start",
          "sso_region = us-east-1",
          "[profile ci]",
          "role_arn = arn:aws:iam::111111111111:role/ci",
          "credential_source = Environment",
          "[profile admin]",
          "role_arn = arn:aws:iam::111111111111:role/admin",
          "source_profile = default",
          "[profile proc]",
          "credential_process = /usr/local/bin/get-creds",
          "",
        ].join("\n"),
      )

      const result = await run((c) => c.listProfiles())

      expect(Either.isRight(result)).toBe(true)
      const byName = Object.fromEntries(Either.getOrThrow(result).map((p) => [p.name, p.authType]))
      expect(byName).toEqual({
        "sso-new": "sso",
        "sso-legacy": "sso",
        ci: "assume_role",
        admin: "assume_role",
        proc: "unsupported",
      })
    })

    it("re-reads the files on every call, so a refresh sees edits", async () => {
      writeCredentials(`[first]\n${keys("AKIA_FIRST")}`)
      expect(await run((c) => c.listProfiles())).toEqual(
        Either.right([{ name: "first", region: undefined, authType: "static" }]),
      )

      writeCredentials(`[second]\n${keys("AKIA_SECOND")}`)
      expect(await run((c) => c.listProfiles())).toEqual(
        Either.right([{ name: "second", region: undefined, authType: "static" }]),
      )
    })

    it("lists nothing when neither file exists", async () => {
      expect(await run((c) => c.listProfiles())).toEqual(Either.right([]))
    })
  })

  describe("authenticateProfile", () => {
    it("resolves a dotted profile's keys and config region without calling STS", async () => {
      const sts = spyOn(STSClient.prototype, "send")
      spies.push(sts)
      writeConfig("[profile acme.prod]\nregion = eu-central-1\n")
      writeCredentials(`[acme.prod]\n${keys("AKIA_ACME")}`)

      const result = await run((c) => c.authenticateProfile("acme.prod"))

      expect(result).toEqual(
        Either.right({
          accessKeyId: "AKIA_ACME",
          secretAccessKey: "secret-AKIA_ACME",
          sessionToken: undefined,
          region: "eu-central-1",
        }),
      )
      // Validation is the caller's job (aws:profile-auth runs it once).
      expect(sts).not.toHaveBeenCalled()
    })

    it("takes a region set in the credentials file", async () => {
      writeCredentials(`[dev]\n${keys("AKIA_DEV")}region = ap-south-1\n`)

      const result = await run((c) => c.authenticateProfile("dev"))

      expect(Either.isRight(result) && result.right.region).toBe("ap-south-1")
    })

    it("returns an empty region when the profile names none, rather than guessing one", async () => {
      writeCredentials(`[dev]\n${keys("AKIA_DEV")}`)

      const result = await run((c) => c.authenticateProfile("dev"))

      expect(Either.isRight(result) && result.right.region).toBe("")
    })
  })
})

describe("AwsSdkClient.checkRegion", () => {
  const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret", region: "ap-east-1" }

  const stubAccount = (reply: () => Promise<unknown>) => {
    const spy = spyOn(AccountClient.prototype, "send").mockImplementation(reply as never)
    spies.push(spy)
    return spy
  }

  it("fails open: an error from GetRegionOptStatus reports the region as enabled", async () => {
    stubAccount(() => Promise.reject(new Error("AccessDeniedException")))

    expect(await run((c) => c.checkRegion("ap-east-1", CREDS))).toEqual(Either.right(true))
  })

  it("reports a disabled region as not enabled", async () => {
    const spy = stubAccount(() => Promise.resolve({ RegionOptStatus: "DISABLED" }))

    expect(await run((c) => c.checkRegion("ap-east-1", CREDS))).toEqual(Either.right(false))
    const command = spy.mock.calls[0][0] as unknown as GetRegionOptStatusCommand
    expect(command).toBeInstanceOf(GetRegionOptStatusCommand)
    expect(command.input).toEqual({ RegionName: "ap-east-1" })
  })

  it("reports an enabled-by-default region as enabled", async () => {
    stubAccount(() => Promise.resolve({ RegionOptStatus: "ENABLED_BY_DEFAULT" }))

    expect(await run((c) => c.checkRegion("us-west-2", CREDS))).toEqual(Either.right(true))
  })
})
