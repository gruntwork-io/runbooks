import { describe, it, expect, spyOn, afterEach } from "bun:test"
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
