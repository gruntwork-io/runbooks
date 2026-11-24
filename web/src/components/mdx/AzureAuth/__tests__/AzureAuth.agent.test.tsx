/**
 * AzureAuth's agent adapter, through the block's real handlers and a fake
 * main: confirm a detected Azure CLI sign-in, pick the tenant and
 * subscription, and read back who is signed in.
 */
import { describe, it, expect, vi } from "vitest"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"

vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import AzureAuth from "../AzureAuth"

const PRINCIPAL = {
  name: "me@example.com",
  objectId: "oid",
  type: "user",
  tenantId: "t-1",
}
const CHOOSE = {
  status: "select_context",
  authType: "cli",
  principal: PRINCIPAL,
  tenants: [
    { tenantId: "t-1", displayName: "LZ Testing" },
    { tenantId: "t-2", displayName: "Other" },
  ],
  subscriptions: [
    { id: "sub-1", name: "A", tenantId: "t-1", isDefault: true, tenantLevel: false },
    { id: "sub-2", name: "B", tenantId: "t-2", isDefault: true, tenantLevel: false },
  ],
}
const SIGNED_IN = {
  status: "authenticated",
  authType: "cli",
  principal: PRINCIPAL,
  tenantId: "t-2",
  tenantName: "Other",
  subscriptionId: "sub-2",
  subscriptionName: "B",
  configDir: "/tmp/az",
  env: {
    AZURE_CONFIG_DIR: "/tmp/az",
    AZURE_TENANT_ID: "t-2",
    ARM_SUBSCRIPTION_ID: "sub-2",
    ARM_USE_CLI: "true",
  },
}

describe("AzureAuth agent adapter", () => {
  it("confirms a detected sign-in, then picks the tenant and subscription", async () => {
    const api = renderWithAgent(<AzureAuth id="azure" detectCredentials={["cli"]} />, {
      "azure:detect": (() => ({
        found: true,
        source: "cli",
        principalName: "me@example.com",
      })) as never,
      "azure:confirm-detected": (() => CHOOSE) as never,
      "azure:select-context": (() => SIGNED_IN) as never,
    })

    await vi.waitFor(async () => {
      const detail = await askAgent(api, { op: "get_block", blockId: "azure" })
      expect(availableActions(detail)).toContain("confirm_detected")
    })
    expect(
      await askAgent(api, {
        op: "act_on_block",
        blockId: "azure",
        action: "confirm_detected",
        params: {},
      }),
    ).toMatchObject({ ok: true })
    expect(api.callsTo("azure:confirm-detected")[0]).toMatchObject({
      blockId: "azure",
      source: "cli",
    })

    const choosing = await askAgent(api, { op: "get_block", blockId: "azure" })
    expect(choosing.state.choosing.tenants).toEqual([
      { id: "t-1", name: "LZ Testing" },
      { id: "t-2", name: "Other" },
    ])
    expect(
      await askAgent(api, {
        op: "act_on_block",
        blockId: "azure",
        action: "select_context",
        params: { tenant_id: "t-2" },
      }),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(api.callsTo("azure:select-context")[0]).toMatchObject({
        tenantId: "t-2",
        subscriptionId: "sub-2",
      }),
    )

    await vi.waitFor(async () => {
      const done = await askAgent(api, { op: "get_block", blockId: "azure" })
      expect(done).toMatchObject({
        status: "success",
        state: { signedInAs: "me@example.com", tenantId: "t-2", subscriptionId: "sub-2" },
      })
    })
  })

  it("refuses a tenant the picker doesn't offer", async () => {
    const api = renderWithAgent(<AzureAuth id="azure" detectCredentials={false} />)
    const result = await askAgent(api, {
      op: "act_on_block",
      blockId: "azure",
      action: "select_context",
      params: { tenant_id: "t-9" },
    })
    expect(result).toMatchObject({ ok: false })
  })

  it("starts a device-code sign-in and reports the code as needsHuman", async () => {
    const api = renderWithAgent(<AzureAuth id="azure" detectCredentials={false} />, {
      "azure:login-start": (() => ({ flowId: "f1" })) as never,
      "azure:login-poll": (() => ({
        status: "pending",
        verificationUri: "https://microsoft.com/devicelogin",
        userCode: "XYZ123",
      })) as never,
      "azure:cancel": (() => ({ ok: true })) as never,
    })
    await askAgent(api, {
      op: "act_on_block",
      blockId: "azure",
      action: "start_device_code_sign_in",
      params: {},
    })
    expect(api.callsTo("azure:login-start")[0]).toMatchObject({
      blockId: "azure",
      deviceCode: true,
    })
    await vi.waitFor(
      async () => {
        const detail = await askAgent(api, { op: "get_block", blockId: "azure" })
        expect(detail.needsHuman).toContain("XYZ123")
      },
      { timeout: 5000 },
    )
  })
})
