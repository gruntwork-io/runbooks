/**
 * AwsAuth's agent adapter, through the block's real handlers and a fake
 * main: confirm detected credentials, or sign in with a profile.
 */
import { describe, it, expect, vi } from "vitest"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"

vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import AwsAuth from "../AwsAuth"

const IDENTITY = {
  accountId: "111111111111",
  accountName: "staging",
  arn: "arn:aws:sts::111111111111:assumed-role/Deploy/run-1",
}

describe("AwsAuth agent adapter", () => {
  it("confirms the credentials it detected", async () => {
    const api = renderWithAgent(<AwsAuth id="aws" />, {
      "aws:env-credentials": (() => ({
        found: true,
        valid: true,
        ...IDENTITY,
        region: "us-east-1",
        hasSessionToken: false,
      })) as never,
      "aws:env-credentials-confirm": (() => ({
        valid: true,
        ...IDENTITY,
        accessKeyId: "AKIA_ENV",
        secretAccessKey: "s",
        region: "us-east-1",
      })) as never,
      "session:set-env": (() => ({ ok: true })) as never,
      "aws:check-region": (() => ({ enabled: true })) as never,
    })
    await vi.waitFor(async () => {
      const detail = await askAgent(api, { op: "get_block", blockId: "aws" })
      expect(availableActions(detail)).toContain("confirm_detected")
      expect(detail.state.detected).toMatchObject({ accountId: "111111111111" })
    })
    await askAgent(api, {
      op: "act_on_block",
      blockId: "aws",
      action: "confirm_detected",
      params: {},
    })
    await vi.waitFor(async () => {
      const detail = await askAgent(api, { op: "get_block", blockId: "aws" })
      expect(detail).toMatchObject({ status: "success", state: { accountId: "111111111111" } })
    })
  })

  it("signs in with a profile it picks from ~/.aws/config", async () => {
    const api = renderWithAgent(<AwsAuth id="aws" detectCredentials={false} />, {
      "aws:profiles": (() => ({ profiles: [{ name: "dev", authType: "static" }] })) as never,
      "aws:profile-auth": (() => ({
        valid: true,
        ...IDENTITY,
        accessKeyId: "AKIA_DEV",
        secretAccessKey: "s",
      })) as never,
      "session:set-env": (() => ({ ok: true })) as never,
      "aws:check-region": (() => ({ enabled: true })) as never,
    })
    await askAgent(api, {
      op: "act_on_block",
      blockId: "aws",
      action: "sign_in_with_profile",
      params: { profile: "dev" },
    })
    await vi.waitFor(() =>
      expect(api.callsTo("aws:profile-auth")[0]).toMatchObject({ profile: "dev" }),
    )
    await vi.waitFor(async () => {
      expect((await askAgent(api, { op: "get_block", blockId: "aws" })).status).toBe("success")
    })
  })

  it("offers no SSO sign-in without an ssoStartUrl", async () => {
    const api = renderWithAgent(<AwsAuth id="aws" detectCredentials={false} />)
    const detail = await askAgent(api, { op: "get_block", blockId: "aws" })
    expect(
      detail.actionSpecs.find((a: { name: string }) => a.name === "start_sso_sign_in").unavailable,
    ).toContain("ssoStartUrl")
  })
})
