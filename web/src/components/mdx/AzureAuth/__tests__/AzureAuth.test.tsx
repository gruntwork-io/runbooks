import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { useAllOutputs } from "@/contexts/useRunbook"
import { isSensitiveOutput, revealOutput } from "@/lib/outputValues"

vi.mock("@/contexts/useSession", () => ({
  useSession: () => ({ isReady: true }),
}))

import AzureAuth from "../AzureAuth"

type Api = Parameters<typeof ApiProvider>[0]["api"]
type InvokeImpl = (channel: string, params?: Record<string, unknown>) => unknown

let currentApi: Api
let invoke: ReturnType<typeof vi.fn>

function installApi(impl: InvokeImpl) {
  invoke = vi.fn(async (channel: string, params?: Record<string, unknown>) => impl(channel, params))
  currentApi = { invoke, on: () => () => {} } as unknown as Api
}

function OutputsProbe({ id }: { id: string }) {
  const outputs = useAllOutputs()[id]?.values ?? {}
  const shown = Object.fromEntries(
    Object.entries(outputs).map(([k, v]) => [
      k,
      isSensitiveOutput(v) ? `sensitive:${revealOutput(v)}` : v,
    ]),
  )
  return <pre data-testid={`outputs-${id}`}>{JSON.stringify(shown)}</pre>
}

function renderBlock(children: ReactNode, id = "azure") {
  return render(
    <TestWrapper>
      <ApiProvider api={currentApi}>
        {children}
        <OutputsProbe id={id} />
      </ApiProvider>
    </TestWrapper>,
  )
}

const outputsOf = (id = "azure") =>
  JSON.parse(screen.getByTestId(`outputs-${id}`).textContent || "{}") as Record<string, string>

const GUEST = {
  name: "engineering@awsdevgruntwork.onmicrosoft.com",
  objectId: "guest-oid",
  type: "guest",
  tenantId: "05547fca-944c-4be0-9f4a-fac8b78fb1ab",
  homeTenantId: "141052b1-f3e4-49c2-91a3-dc349beb66f1",
}

const AUTHENTICATED = {
  status: "authenticated",
  authType: "cli",
  principal: GUEST,
  tenantId: GUEST.tenantId,
  tenantName: "LZ Testing",
  subscriptionId: "sub-1",
  subscriptionName: "LZ Sub",
  configDir: "/tmp/runbooks-azure-1",
  env: {
    AZURE_CONFIG_DIR: "/tmp/runbooks-azure-1",
    ARM_TENANT_ID: GUEST.tenantId,
    ARM_SUBSCRIPTION_ID: "sub-1",
    ARM_USE_CLI: "true",
    AZURE_PRINCIPAL_TYPE: "guest",
  },
}

beforeEach(() => {
  installApi(() => {
    throw new Error("no IPC expected")
  })
})

describe("AzureAuth — rendering", () => {
  it("renders the title and the three sign-in tabs", () => {
    renderBlock(<AzureAuth id="azure" detectCredentials={false} />)
    expect(screen.getByText("Azure Authentication")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Azure CLI/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Device Code/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Service Principal/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in with browser" })).toBeInTheDocument()
  })

  it("opens on defaultTab and shows a pinned tenant without letting it change", () => {
    renderBlock(
      <AzureAuth
        id="azure"
        detectCredentials={false}
        defaultTab="service_principal"
        tenantId="t-pinned"
      />,
    )
    const tenant = screen.getByLabelText("Tenant ID") as HTMLInputElement
    expect(tenant.value).toBe("t-pinned")
    expect(tenant).toBeDisabled()
    expect(screen.getByLabelText("Client ID")).toBeInTheDocument()
  })
})

describe("AzureAuth — detection", () => {
  it("offers an existing az login, and publishes the block's sign-in when confirmed", async () => {
    installApi((channel, params) => {
      if (channel === "azure:detect") {
        return (params?.sources as string[] | undefined)?.[0] === "cli"
          ? { found: true, source: "cli", principalName: GUEST.name, tenantId: GUEST.tenantId }
          : { found: false }
      }
      if (channel === "azure:confirm-detected") return AUTHENTICATED
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(<AzureAuth id="azure" subscriptionId="sub-1" />)

    await screen.findByText("Existing Azure sign-in found")
    fireEvent.click(screen.getByRole("button", { name: "Use this sign-in" }))

    await screen.findByText("✓ Signed in to Azure")
    expect(screen.getByText("Guest user:")).toBeInTheDocument()
    expect(screen.getByText(/Guest from tenant/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(
      "azure:confirm-detected",
      expect.objectContaining({ blockId: "azure", source: "cli", subscriptionId: "sub-1" }),
    )
    const outputs = outputsOf()
    expect(outputs.ARM_USE_CLI).toBe("true")
    expect(outputs.AZURE_CONFIG_DIR).toBe("/tmp/runbooks-azure-1")
    expect(outputs.AZURE_SUBSCRIPTION_NAME).toBe("LZ Sub")
    expect(outputs.__AUTHENTICATED).toBe("true")
  })

  it("says to install the Azure CLI when it's missing", async () => {
    installApi((channel) => {
      if (channel === "azure:detect") return { found: false, cliMissing: true, error: "no az" }
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(<AzureAuth id="azure" detectCredentials={["cli"]} />)
    expect(await screen.findByRole("link", { name: "Install the Azure CLI" })).toBeInTheDocument()
  })
})

describe("AzureAuth — tenant and subscription picker", () => {
  it("lets the user pick, then sends the pick to main", async () => {
    installApi((channel) => {
      if (channel === "azure:service-principal") {
        return {
          status: "select_context",
          authType: "cli",
          principal: GUEST,
          tenants: [
            { tenantId: GUEST.tenantId, displayName: "LZ Testing" },
            { tenantId: "other", displayName: "Other" },
          ],
          subscriptions: [
            { id: "sub-1", name: "LZ Sub", tenantId: GUEST.tenantId, isDefault: true },
            { id: "sub-2", name: "Other Sub", tenantId: "other", isDefault: false },
          ],
        }
      }
      if (channel === "azure:select-context") return AUTHENTICATED
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(<AzureAuth id="azure" detectCredentials={false} defaultTab="service_principal" />)
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "app" } })
    fireEvent.change(screen.getByLabelText("Tenant ID"), { target: { value: "t" } })
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await screen.findByTestId("azure-context-picker")
    expect((screen.getByLabelText("Subscription") as HTMLSelectElement).value).toBe("sub-1")
    fireEvent.change(screen.getByLabelText("Tenant"), { target: { value: "other" } })
    expect((screen.getByLabelText("Subscription") as HTMLSelectElement).value).toBe("sub-2")
    fireEvent.change(screen.getByLabelText("Subscription"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await screen.findByText("✓ Signed in to Azure")
    expect(invoke).toHaveBeenCalledWith("azure:select-context", {
      blockId: "azure",
      tenantId: "other",
    })
  })
})

describe("AzureAuth — picker errors", () => {
  it("keeps the picker up and shows why a pick failed", async () => {
    installApi((channel) => {
      if (channel === "azure:confirm-detected") {
        return {
          status: "select_context",
          authType: "cli",
          principal: GUEST,
          tenants: [{ tenantId: GUEST.tenantId, displayName: "LZ Testing" }],
          subscriptions: [
            {
              id: "sub-1",
              name: "A",
              tenantId: GUEST.tenantId,
              isDefault: true,
              tenantLevel: false,
            },
            {
              id: "sub-2",
              name: "B",
              tenantId: GUEST.tenantId,
              isDefault: false,
              tenantLevel: false,
            },
          ],
        }
      }
      if (channel === "azure:detect") return { found: true, source: "cli", principalName: "me" }
      if (channel === "azure:select-context") {
        return {
          status: "failed",
          error: "me is missing the required role: Owner at /subscriptions/sub-1.",
        }
      }
      if (channel === "azure:cancel") return { ok: true }
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(
      <AzureAuth id="azure" detectCredentials={["cli"]} requiredRoles={[{ role: "Owner" }]} />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Use this sign-in" }))
    await screen.findByTestId("azure-context-picker")
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("missing the required role")
    expect(screen.getByTestId("azure-context-picker")).toBeInTheDocument()
  })
})

describe("AzureAuth — service principal", () => {
  it("publishes the client secret as a sensitive output", async () => {
    installApi((channel) => {
      if (channel === "azure:service-principal") {
        return {
          ...AUTHENTICATED,
          authType: "service_principal",
          principal: { name: "app", objectId: "sp", type: "servicePrincipal", tenantId: "t" },
          env: { AZURE_CONFIG_DIR: "/d", ARM_CLIENT_ID: "app", ARM_CLIENT_SECRET: "s3cret" },
        }
      }
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(<AzureAuth id="azure" detectCredentials={false} defaultTab="service_principal" />)
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "app" } })
    fireEvent.change(screen.getByLabelText("Tenant ID"), { target: { value: "t" } })
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s3cret" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await screen.findByText("✓ Signed in to Azure")
    expect(outputsOf().ARM_CLIENT_SECRET).toBe("sensitive:s3cret")
    expect(outputsOf().ARM_CLIENT_ID).toBe("app")
  })

  it("shows the missing roles as the error, and stays signed out", async () => {
    installApi((channel) => {
      if (channel === "azure:service-principal") {
        return {
          status: "failed",
          error: "app is missing the required role: Owner at /subscriptions/sub-1.",
          missingRoles: [{ role: "Owner", scope: "/subscriptions/sub-1" }],
        }
      }
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(
      <AzureAuth
        id="azure"
        detectCredentials={false}
        defaultTab="service_principal"
        requiredRoles={[{ role: "Owner" }]}
      />,
    )
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "app" } })
    fireEvent.change(screen.getByLabelText("Tenant ID"), { target: { value: "t" } })
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("missing the required role: Owner")
    expect(invoke).toHaveBeenCalledWith(
      "azure:service-principal",
      expect.objectContaining({ requiredRoles: [{ role: "Owner" }] }),
    )
    expect(outputsOf().__AUTHENTICATED).toBeUndefined()
  })
})

describe("AzureAuth — device code", () => {
  it("shows the code az printed, then signs in", async () => {
    let polls = 0
    installApi((channel) => {
      if (channel === "azure:login-start") return { flowId: "f1" }
      if (channel === "azure:login-poll") {
        polls++
        return polls < 2
          ? {
              status: "pending",
              verificationUri: "https://microsoft.com/devicelogin",
              userCode: "ABCD1234",
            }
          : { ...AUTHENTICATED, authType: "device_code" }
      }
      if (channel === "azure:cancel") return { ok: true }
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(
      <AzureAuth id="azure" detectCredentials={false} defaultTab="device_code" tenantId="t1" />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Get a device code" }))

    expect(await screen.findByText("ABCD1234", {}, { timeout: 4000 })).toBeInTheDocument()
    await screen.findByText("✓ Signed in to Azure", {}, { timeout: 5000 })
    expect(invoke).toHaveBeenCalledWith("azure:login-start", {
      blockId: "azure",
      deviceCode: true,
      tenantId: "t1",
    })
  }, 10000)
})

describe("AzureAuth — re-authenticate", () => {
  it("withdraws the outputs so azureAuthId steps wait again", async () => {
    installApi((channel) => {
      if (channel === "azure:detect") return { found: true, source: "cli", principalName: "me" }
      if (channel === "azure:confirm-detected") return AUTHENTICATED
      throw new Error(`unexpected ${channel}`)
    })
    renderBlock(<AzureAuth id="azure" detectCredentials={["cli"]} />)
    fireEvent.click(await screen.findByRole("button", { name: "Use this sign-in" }))
    await screen.findByText("✓ Signed in to Azure")
    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate" }))
    await waitFor(() => expect(outputsOf()).toEqual({ __AUTHENTICATED: "false" }))
  })
})
