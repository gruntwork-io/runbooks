import { describe, it, expect, vi } from "vitest"
import { useEffect } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiProvider } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { TestWrapper } from "@/test/test-utils"
import { GoogleGroup } from "../GoogleGroup"
import type { GoogleGroupProps } from "../types"

const CREATED = {
  ok: true,
  group: { name: "groups/abc123", email: "ops@example.com", displayName: "Ops" },
  created: true,
  customerId: "C01",
  log: ["Created group ops@example.com", "Added josh@example.com as member"],
}

function makeApi(reply: unknown = CREATED) {
  const invoke = vi.fn(async (_channel: string, _params?: unknown) => reply)
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
    typeof ApiProvider
  >[0]["api"]
  return { api, invoke }
}

/** Publishes a GoogleAuth block's outputs, as one that signed in would. */
function SignedIn({ id }: { id: string }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => registerOutputs(id, { __AUTHENTICATED: "true" }), [id, registerOutputs])
  return null
}

function renderGroup(
  props: Partial<GoogleGroupProps> = {},
  options: { signedIn?: boolean; reply?: unknown } = {},
) {
  const { api, invoke } = makeApi(options.reply)
  render(
    <ApiProvider api={api}>
      <TestWrapper>
        {options.signedIn !== false && <SignedIn id="google-admin" />}
        <GoogleGroup
          id="create-group"
          googleAuthId="google-admin"
          email="ops@example.com"
          members={["josh@example.com"]}
          {...props}
        />
      </TestWrapper>
    </ApiProvider>,
  )
  return { invoke }
}

describe("GoogleGroup", () => {
  it("shows what it will create", () => {
    renderGroup({ displayName: "Ops", role: "OWNER" })
    expect(screen.getByText("Create a Google group")).toBeInTheDocument()
    expect(screen.getByText("ops@example.com")).toBeInTheDocument()
    expect(screen.getByText("Ops")).toBeInTheDocument()
    expect(screen.getByText("Owners")).toBeInTheDocument()
    expect(screen.getByText("josh@example.com")).toBeInTheDocument()
  })

  it("waits for its GoogleAuth block to sign in", () => {
    renderGroup({}, { signedIn: false })
    expect(screen.getByText(/Waiting for Google authentication/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create group" })).toBeDisabled()
  })

  it("creates the group, then shows what it did and publishes its outputs", async () => {
    const { invoke } = renderGroup({ allowExternalSenders: true })
    await userEvent.click(screen.getByRole("button", { name: "Create group" }))

    expect(invoke).toHaveBeenCalledWith("google:create-group", {
      googleAuthId: "google-admin",
      email: "ops@example.com",
      members: ["josh@example.com"],
      role: "MEMBER",
      allowExternalSenders: true,
    })
    expect(await screen.findByText("Created group ops@example.com")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Create group|Try again/ })).toBeNull()
    expect(screen.getByText("GROUP_EMAIL")).toBeInTheDocument()
  })

  it("shows a failure inline and offers to try again", async () => {
    renderGroup({}, { reply: { ok: false, error: "Cloud Identity API has not been used" } })
    await userEvent.click(screen.getByRole("button", { name: "Create group" }))
    expect(await screen.findByText("Cloud Identity API has not been used")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled())
  })

  it("won't send an address that isn't one", () => {
    renderGroup({ members: ["josh"] })
    expect(screen.getByText('Member "josh" is not an email address.')).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create group" })).toBeDisabled()
  })

  it("reports a missing email as a configuration error", () => {
    renderGroup({ email: "" })
    expect(screen.getByText(/requires an 'email' prop/)).toBeInTheDocument()
  })

  it("reports an unknown role as a configuration error", () => {
    renderGroup({ role: "ADMIN" as never })
    expect(screen.getByText(/Role "ADMIN" is not one of/)).toBeInTheDocument()
  })
})
