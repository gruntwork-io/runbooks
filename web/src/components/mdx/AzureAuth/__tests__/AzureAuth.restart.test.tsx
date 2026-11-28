import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
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

// AzureAuth resumed after Runbooks restarted: the block's config dir is gone,
// so a sign-in the user accepted from their own az login (or the environment)
// is detected again, and adopted without asking when it is the same one. The
// IPC surface is the boundary faked, through the real session history.

const TENANT = "05547fca-944c-4be0-9f4a-fac8b78fb1ab"

const PRINCIPAL = {
  name: "alice@contoso.com",
  objectId: "alice-oid",
  type: "user" as const,
  tenantId: TENANT,
}

const AUTHENTICATED: Result<"azure:confirm-detected"> = {
  status: "authenticated",
  authType: "cli",
  principal: PRINCIPAL,
  tenantId: TENANT,
  tenantName: "Contoso",
  subscriptionId: "sub-2",
  subscriptionName: "Sandbox",
  configDir: "/tmp/runbooks-azure-new",
  env: { AZURE_CONFIG_DIR: "/tmp/runbooks-azure-new", ARM_USE_CLI: "true" },
}

const SAVED = {
  status: "signed-in",
  block: "azure",
  authType: "cli",
  principal: PRINCIPAL,
  tenantId: TENANT,
  tenantName: "Contoso",
  subscriptionId: "sub-2",
  subscriptionName: "Sandbox",
  configDir: "/tmp/runbooks-azure-old",
  env: { AZURE_CONFIG_DIR: "/tmp/runbooks-azure-old", ARM_USE_CLI: "true" },
  detected: { source: "cli" },
}

const ENDED: Result<"azure:validate-session"> = {
  valid: false,
  ended: true,
  error: "the sign-in ended when Runbooks quit",
}

const FOUND_CLI: Result<"azure:detect"> = {
  found: true,
  source: "cli",
  principalName: PRINCIPAL.name,
  tenantId: TENANT,
  subscriptionId: "sub-1",
}

let testApi: TestApi

beforeEach(() => {
  testApi = makeTestApi({
    "session:record-event": () => ({ ok: true }),
    "azure:cancel": () => ({ ok: true }),
    "azure:validate-session": () => ENDED,
    "azure:detect": () => ({ found: false }),
    "session:clear-env-export": () => ({ ok: true }),
  })
})

function OutputsProbe() {
  const outputs = useAllOutputs().azure?.values ?? {}
  return <pre data-testid="outputs">{JSON.stringify(outputs)}</pre>
}

const outputs = () =>
  JSON.parse(screen.getByTestId("outputs").textContent || "{}") as Record<string, string>

/** The payload of each auth event sent to the main process, oldest first. */
const recorded = () => testApi.callsTo("session:record-event").map((event) => event.payload)

/** Renders the block, resumed from `saved`; `null` for a block with no history. */
function renderBlock(props: Partial<AzureAuthProps> = {}, saved: unknown = SAVED) {
  const blockStates: SavedBlockState[] =
    saved === null ? [] : [{ blockId: "azure", kind: "auth", payload: saved }]
  return render(
    <TestWrapper>
      <ApiProvider api={testApi.api}>
        <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
          <AzureAuth id="azure" detectCredentials={["cli"]} {...props} />
          <OutputsProbe />
        </IpcSessionHistoryProvider>
      </ApiProvider>
    </TestWrapper>,
  )
}

const RESTARTED = "Runbooks was restarted, so sign in again."

describe("AzureAuth after a restart — the export", () => {
  it("drops the block's export when its sign-in ended", async () => {
    renderBlock()

    await waitFor(() =>
      expect(testApi.callsTo("session:clear-env-export")).toEqual([{ componentId: "azure" }]),
    )
  })

  it("keeps the export when the saved sign-in still works", async () => {
    testApi.handle("azure:validate-session", () => ({ valid: true }))
    renderBlock()

    await waitFor(() => expect(testApi.callsTo("azure:validate-session")).toHaveLength(1))
    await act(async () => {})
    expect(testApi.callsTo("session:clear-env-export")).toEqual([])
  })
})

describe("AzureAuth after a restart — a detected sign-in", () => {
  it("signs in again without asking when the same sign-in is still there", async () => {
    testApi.handle("azure:detect", () => FOUND_CLI)
    testApi.handle("azure:confirm-detected", () => AUTHENTICATED)
    renderBlock({ requiredRoles: [{ role: "Contributor" }] })

    await waitFor(() => expect(outputs().AZURE_CONFIG_DIR).toBe("/tmp/runbooks-azure-new"))
    expect(screen.getByText("✓ Signed in to Azure")).toBeInTheDocument()
    expect(screen.queryByText("Existing Azure sign-in found")).not.toBeInTheDocument()
    expect(screen.queryByText(/Authentication failed/)).not.toBeInTheDocument()
    expect(screen.queryByText(RESTARTED)).not.toBeInTheDocument()
    expect(outputs().__AUTHENTICATED).toBe("true")

    // The saved principal, tenant and subscription, not the detected default
    // subscription; and the required roles are checked again.
    expect(testApi.callsTo("azure:confirm-detected")).toEqual([
      {
        blockId: "azure",
        source: "cli",
        tenantId: TENANT,
        subscriptionId: "sub-2",
        requiredRoles: [{ role: "Contributor" }],
        principalObjectId: "alice-oid",
      },
    ])
    await waitFor(() => expect(recorded()).toHaveLength(2))
    expect(recorded()[0]).toEqual({ status: "signed-out" })
    expect(recorded()[1]).toMatchObject({
      status: "signed-in",
      configDir: "/tmp/runbooks-azure-new",
      detected: { source: "cli" },
    })
  })

  it("asks again when the sign-in now belongs to someone else, without an error", async () => {
    testApi.handle("azure:detect", () => ({ ...FOUND_CLI, principalName: "bob@contoso.com" }))
    testApi.handle("azure:confirm-detected", () => ({
      status: "failed",
      error: "This sign-in is now bob@contoso.com, not the account the block used before",
    }))
    renderBlock()

    expect(await screen.findByText("Existing Azure sign-in found")).toBeInTheDocument()
    expect(screen.getByText("bob@contoso.com")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/Authentication failed/)).not.toBeInTheDocument()
    expect(outputs().__AUTHENTICATED).toBe("false")

    // Accepting it is an ordinary sign-in, with the block's own pins.
    testApi.handle("azure:confirm-detected", () => AUTHENTICATED)
    fireEvent.click(screen.getByRole("button", { name: "Use this sign-in" }))
    await screen.findByText("✓ Signed in to Azure")
    expect(testApi.callsTo("azure:confirm-detected")[1]).toEqual({
      blockId: "azure",
      source: "cli",
    })
  })

  it("asks when it finds a sign-in from another source, without trying it", async () => {
    testApi.handle("azure:detect", ({ sources }) =>
      sources[0] === "env"
        ? { found: true, source: "env", principalName: "app-id", tenantId: TENANT }
        : { found: false },
    )
    renderBlock({ detectCredentials: ["env", "cli"] })

    expect(await screen.findByText("Existing Azure sign-in found")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(testApi.callsTo("azure:confirm-detected")).toEqual([])
  })

  it("says Runbooks was restarted, as a notice, when nothing is detected", async () => {
    renderBlock()

    expect(await screen.findByText(RESTARTED)).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(RESTARTED)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/Authentication failed/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in with browser" })).toBeInTheDocument()
    expect(outputs().__AUTHENTICATED).toBe("false")
  })

  it("shows the missing roles when the same sign-in no longer has them", async () => {
    testApi.handle("azure:detect", () => FOUND_CLI)
    testApi.handle("azure:confirm-detected", () => ({
      status: "failed",
      error: "alice@contoso.com is missing the required role: Owner at /subscriptions/sub-2.",
      missingRoles: [{ role: "Owner", scope: "/subscriptions/sub-2" }],
    }))
    renderBlock({ requiredRoles: [{ role: "Owner" }] })

    expect(await screen.findByRole("alert")).toHaveTextContent("missing the required role: Owner")
    expect(screen.queryByText("Existing Azure sign-in found")).not.toBeInTheDocument()
    expect(outputs().__AUTHENTICATED).toBe("false")
  })
})

describe("AzureAuth after a restart — an interactive sign-in", () => {
  it("says Runbooks was restarted, as a notice, not an error", async () => {
    const { detected: _detected, ...interactive } = SAVED
    renderBlock({ detectCredentials: false }, interactive)

    expect(await screen.findByText(RESTARTED)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/Authentication failed/)).not.toBeInTheDocument()
    expect(outputs().__AUTHENTICATED).toBe("false")
    expect(testApi.callsTo("azure:detect")).toEqual([])
  })

  it("never signs in without asking, even when detection finds the same account", async () => {
    const { detected: _detected, ...interactive } = SAVED
    testApi.handle("azure:detect", () => FOUND_CLI)
    renderBlock({}, interactive)

    expect(await screen.findByText("Existing Azure sign-in found")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(testApi.callsTo("azure:confirm-detected")).toEqual([])
  })
})

describe("AzureAuth — a saved sign-in that is refused", () => {
  it("is still an error when its config dir is there", async () => {
    testApi.handle("azure:validate-session", () => ({
      valid: false,
      error: "AADSTS700082: The refresh token has expired",
    }))
    renderBlock()

    expect(await screen.findByRole("alert")).toHaveTextContent("The refresh token has expired")
    expect(screen.queryByText(RESTARTED)).not.toBeInTheDocument()
  })
})

describe("AzureAuth — what a sign-in saves", () => {
  it("saves where a sign-in accepted from detection came from", async () => {
    testApi.handle("azure:detect", () => FOUND_CLI)
    testApi.handle("azure:confirm-detected", () => AUTHENTICATED)
    renderBlock({}, null)

    fireEvent.click(await screen.findByRole("button", { name: "Use this sign-in" }))
    await screen.findByText("✓ Signed in to Azure")
    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toMatchObject({ status: "signed-in", detected: { source: "cli" } })
  })

  it("saves no detected source for a browser sign-in", async () => {
    testApi.handle("azure:login-start", () => ({ flowId: "f1" }))
    testApi.handle("azure:login-poll", () => AUTHENTICATED)
    renderBlock({ detectCredentials: false }, null)

    fireEvent.click(screen.getByRole("button", { name: "Sign in with browser" }))
    await screen.findByText("✓ Signed in to Azure", {}, { timeout: 4000 })
    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).not.toHaveProperty("detected")
  })
})
