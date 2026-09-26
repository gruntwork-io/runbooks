import { describe, it, expect, spyOn, afterEach } from "bun:test"
import { Effect } from "effect"
import { STSClient } from "@aws-sdk/client-sts"
import { IAMClient } from "@aws-sdk/client-iam"
import { AccountClient } from "@aws-sdk/client-account"
import { AwsClient } from "../services/AwsClient.ts"
import { AwsSdkClientLive } from "./AwsSdkClient.ts"

/**
 * The partition-wide calls (STS, IAM, the Account API) must reach the
 * partition of the working region. No request leaves the process: each
 * client's `send` is stubbed to record the region the client was built for.
 */
const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret", region: "unused" }

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

/** Records the region every client of `Client` sends from, replying `reply`. */
function recordRegions(Client: { prototype: { send: unknown; config: unknown } }, reply: unknown) {
  const regions: string[] = []
  const spy = spyOn(Client.prototype as { send: (...args: unknown[]) => Promise<unknown> }, "send")
  spy.mockImplementation(async function (this: { config: { region: () => Promise<string> } }) {
    regions.push(await this.config.region())
    return reply
  })
  spies.push(spy)
  return regions
}

const run = <A>(f: (client: typeof AwsClient.Service) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.flatMap(AwsClient, f).pipe(Effect.provide(AwsSdkClientLive)))

describe("AwsSdkClient partition routing", () => {
  it.each([
    ["eu-west-2", "us-east-1"],
    ["us-gov-east-1", "us-gov-west-1"],
    ["cn-north-1", "cn-northwest-1"],
    ["eusc-de-east-1", "eusc-de-east-1"],
  ])("validateCredentials for %s calls STS and IAM in %s", async (region, home) => {
    const sts = recordRegions(STSClient, { Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/me" })
    const iam = recordRegions(IAMClient, { AccountAliases: [] })

    await run((c) => c.validateCredentials(CREDS, region))

    expect(sts).toEqual([home])
    expect(iam).toEqual([home])
  })

  it.each([
    ["ap-east-1", "us-east-1"],
    ["us-gov-east-1", "us-gov-west-1"],
    ["cn-northwest-1", "cn-northwest-1"],
  ])("checkRegion for %s asks the Account API in %s", async (region, home) => {
    const account = recordRegions(AccountClient, { RegionOptStatus: "ENABLED" })

    expect(await run((c) => c.checkRegion(region, CREDS))).toBe(true)
    expect(account).toEqual([home])
  })
})
