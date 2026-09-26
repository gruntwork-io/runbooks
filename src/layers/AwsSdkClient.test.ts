import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { regionEnabledOrUnknown } from "./AwsSdkClient.ts"

/**
 * Regression: the lookup used to fail with the boolean `true` instead of
 * succeeding with it. Any role lacking `account:GetRegionOptStatus` then got a
 * caution box reading "true" on the success card.
 */
describe("regionEnabledOrUnknown", () => {
  it("reports an enabled region", async () => {
    const enabled = await Effect.runPromise(regionEnabledOrUnknown(async () => true))
    expect(enabled).toBe(true)
  })

  it("reports a region the account has not opted into", async () => {
    const enabled = await Effect.runPromise(regionEnabledOrUnknown(async () => false))
    expect(enabled).toBe(false)
  })

  it("treats a lookup that throws as enabled rather than failing", async () => {
    const enabled = await Effect.runPromise(
      regionEnabledOrUnknown(async () => {
        throw new Error("AccessDeniedException: account:GetRegionOptStatus")
      }),
    )
    expect(enabled).toBe(true)
  })
})
