import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useAllOutputs } from "@/contexts/useRunbook"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"
import type { AzureAuthProps } from "../types"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"

vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import AzureAuth from "../AzureAuth"

// Change tenant on a signed-in block: the picker reopens on the block's own
// sign-in, and a tenant that wants MFA gets a sign-in of its own. The IPC
// surface is the boundary faked, through the real session history.

const HOME = "141052b1-f3e4-49c2-91a3-dc349beb66f1"
const BILLING = "05547fca-944c-4be0-9f4a-fac8b78fb1ab"
const DIR = "/tmp/runbooks-azure-1"

const PRINCIPAL = {
  name: "alice@contoso.com",
  objectId: "alice-oid",
  type: "user" as const,
  tenantId: HOME,
}

const SAVED = {
  status: "signed-in",
  block: "azure",
  authType: "cli",
  principal: PRINCIPAL,
  tenantId: HOME,
  tenantName: "Landing zone",
  subscriptionId: "sub-home",
  subscriptionName: "LZ",
  configDir: DIR,
  env: { AZURE_CONFIG_DIR: DIR, AZURE_TENANT_ID: HOME, ARM_USE_CLI: "true" },
}

const PICKER: Result<"azure:change-tenant"> = {
  status: "select_context",
  authType: "cli",
  principal: PRINCIPAL,
  tenants: [
    { tenantId: HOME, displayName: "Landing zone" },
    { tenantId: BILLING, displayName: "Billing" },
  ],
  subscriptions: [
    { id: "sub-home", name: "LZ", tenantId: HOME, isDefault: true, tenantLevel: false },
    { id: "sub-bill", name: "Invoices", tenantId: BILLING, isDefault: false, tenantLevel: false },
  ],
}

const IN_BILLING: Result<"azure:select-context"> = {
  status: "authenticated",
  authType: "cli",
  principal: { ...PRINCIPAL, tenantId: BILLING },
  tenantId: BILLING,
  tenantName: "Billing",
  subscriptionId: "sub-bill",
  subscriptionName: "Invoices",
  configDir: DIR,
  env: { AZURE_CONFIG_DIR: DIR, AZURE_TENANT_ID: BILLING, ARM_USE_CLI: "true" },
}

let testApi: TestApi

beforeEach(() => {
  testApi = makeTestApi({
    "session:record-event": () => ({ ok: true }),
    "azure:cancel": () => ({ ok: true }),
    "azure:validate-session": () => ({ valid: true }),
    "azure:change-tenant": () => PICKER,
  })
})

function OutputsProbe() {
  const outputs = useAllOutputs().azure?.values ?? {}
  return <pre data-testid="outputs">{JSON.stringify(outputs)}</pre>
}

const outputs = () =>
  JSON.parse(screen.getByTestId("outputs").textContent || "{}") as Record<string, string>

const recorded = () => testApi.callsTo("session:record-event").map((event) => event.payload)

function renderBlock(props: Partial<AzureAuthProps> = {}, saved: unknown = SAVED) {
  const blockStates: SavedBlockState[] =
    saved === null ? [] : [{ blockId: "azure", kind: "auth", payload: saved }]
  return render(
    <TestWrapper>
      <ApiProvider api={testApi.api}>
        <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
          <AzureAuth id="azure" detectCredentials={false} {...props} />
          <OutputsProbe />
        </IpcSessionHistoryProvider>
      </ApiProvider>
    </TestWrapper>,
  )
}

async function openPicker() {
  fireEvent.click(await screen.findByRole("button", { name: "Change tenant" }))
  await screen.findByTestId("azure-context-picker")
  fireEvent.change(screen.getByLabelText("Tenant"), { target: { value: BILLING } })
  fireEvent.click(screen.getByRole("button", { name: "Continue" }))
}

describe("AzureAuth — Change tenant", () => {
  it("opens the picker on the block's own sign-in, then saves the tenant it moves to", async () => {
    testApi.handle("azure:select-context", () => IN_BILLING)
    renderBlock()

    fireEvent.click(await screen.findByRole("button", { name: "Change tenant" }))
    await screen.findByTestId("azure-context-picker")
    expect(testApi.callsTo("azure:change-tenant")).toEqual([
      { blockId: "azure", configDir: DIR, authType: "cli", tenantId: HOME },
    ])
    // The current tenant and subscription, not the account's defaults
    expect((screen.getByLabelText("Tenant") as HTMLSelectElement).value).toBe(HOME)
    expect((screen.getByLabelText("Subscription") as HTMLSelectElement).value).toBe("sub-home")

    fireEvent.change(screen.getByLabelText("Tenant"), { target: { value: BILLING } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(outputs().AZURE_TENANT_ID).toBe(BILLING))
    expect(screen.getByText("✓ Signed in to Azure")).toBeInTheDocument()
    expect(screen.getByText("Billing")).toBeInTheDocument()
    expect(testApi.callsTo("azure:select-context")).toEqual([
      { blockId: "azure", tenantId: BILLING, subscriptionId: "sub-bill" },
    ])
    await waitFor(() => expect(recorded().at(-1)).toMatchObject({ tenantId: BILLING }))
    expect(recorded().at(-1)).toMatchObject({ status: "signed-in", configDir: DIR })
  })

  it("goes back to the sign-in it had on Cancel", async () => {
    renderBlock()
    fireEvent.click(await screen.findByRole("button", { name: "Change tenant" }))
    await screen.findByTestId("azure-context-picker")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(await screen.findByText("✓ Signed in to Azure")).toBeInTheDocument()
    expect(screen.queryByTestId("azure-context-picker")).not.toBeInTheDocument()
    expect(screen.getByText("Landing zone")).toBeInTheDocument()
    expect(outputs()).toMatchObject({ AZURE_TENANT_ID: HOME, __AUTHENTICATED: "true" })
    expect(testApi.callsTo("azure:select-context")).toEqual([])
    expect(recorded()).toEqual([])
  })

  it("signs in to a tenant that wants MFA, saying so, then uses it", async () => {
    testApi.handle("azure:select-context", () => ({
      status: "failed",
      error: `Tenant ${BILLING} needs you to sign in to it again`,
      interactionRequired: true,
    }))
    testApi.handle("azure:tenant-login-start", () => ({ flowId: "f1" }))
    testApi.handle("azure:login-poll", () => IN_BILLING)
    renderBlock()

    await openPicker()
    expect(
      await screen.findByText("This tenant needs you to sign in again. Your browser will open."),
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(testApi.callsTo("azure:tenant-login-start")).toEqual([
      { blockId: "azure", tenantId: BILLING, subscriptionId: "sub-bill" },
    ])

    await screen.findByText("✓ Signed in to Azure", {}, { timeout: 4000 })
    expect(screen.getByText("Billing")).toBeInTheDocument()
    expect(outputs().AZURE_TENANT_ID).toBe(BILLING)
    expect(testApi.callsTo("azure:login-start")).toEqual([])
  })

  it("goes back to the picker when that sign-in is cancelled", async () => {
    testApi.handle("azure:select-context", () => ({
      status: "failed",
      error: "needs a sign-in",
      interactionRequired: true,
    }))
    testApi.handle("azure:tenant-login-start", () => ({ flowId: "f1" }))
    testApi.handle("azure:login-poll", () => ({ status: "pending" }))
    renderBlock()

    await openPicker()
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }))
    expect(await screen.findByRole("button", { name: "Continue" })).toBeEnabled()
    expect(testApi.callsTo("azure:cancel")).toContainEqual({ blockId: "azure" })
    expect(outputs().AZURE_TENANT_ID).toBe(HOME)
  })

  it("shows why a sign-in to the tenant failed, in the picker", async () => {
    testApi.handle("azure:select-context", () => ({
      status: "failed",
      error: "needs a sign-in",
      interactionRequired: true,
    }))
    testApi.handle("azure:tenant-login-start", () => ({ flowId: "f1" }))
    testApi.handle("azure:login-poll", () => ({
      status: "failed",
      error: "User canceled the sign-in",
    }))
    renderBlock()

    await openPicker()
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent(
      "User canceled the sign-in",
    )
    expect(screen.getByTestId("azure-context-picker")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled()
  })

  it("signs in to a tenant that wants MFA from the picker after the first sign-in too", async () => {
    let polls = 0
    testApi.handle("azure:login-start", () => ({ flowId: "first" }))
    testApi.handle("azure:login-poll", () => (polls++ === 0 ? PICKER : IN_BILLING))
    testApi.handle("azure:select-context", () => ({
      status: "failed",
      error: "needs a sign-in",
      interactionRequired: true,
    }))
    testApi.handle("azure:tenant-login-start", () => ({ flowId: "tenant" }))
    renderBlock({}, null)

    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }))
    await screen.findByTestId("azure-context-picker", {}, { timeout: 4000 })
    fireEvent.change(screen.getByLabelText("Tenant"), { target: { value: BILLING } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    expect(await screen.findByTestId("azure-tenant-sign-in")).toBeInTheDocument()
    await screen.findByText("✓ Signed in to Azure", {}, { timeout: 4000 })
    expect(testApi.callsTo("azure:login-poll").map((call) => call.flowId)).toEqual([
      "first",
      "tenant",
    ])
    expect(outputs().AZURE_TENANT_ID).toBe(BILLING)
  })

  it("isn't offered for a service principal or a block pinned to a tenant", async () => {
    const { unmount } = renderBlock({}, { ...SAVED, authType: "service_principal" })
    await screen.findByText("✓ Signed in to Azure")
    expect(screen.queryByRole("button", { name: "Change tenant" })).not.toBeInTheDocument()
    unmount()

    renderBlock({ tenantId: HOME })
    await screen.findByText("✓ Signed in to Azure")
    expect(screen.queryByRole("button", { name: "Change tenant" })).not.toBeInTheDocument()
  })
})
