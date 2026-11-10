import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext, flattenInputs } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import type { TofuModuleSpec } from "../../../../../../src/domain/tofu-module/types"
import TofuModule from "../TofuModule"

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({ activeWorkTree: null, workTrees: [] }),
}))

const spec: TofuModuleSpec = {
  title: "Google group",
  description: "A Google Workspace group.",
  providers: [{ name: "google" }],
  outputs: [{ name: "group_email", label: "Group email", description: "", sensitive: false }],
  warnings: [],
  variables: [
    {
      name: "domain",
      label: "Domain",
      description: "",
      tfType: "string",
      kind: "string",
      hasDefault: false,
      sensitive: false,
      primary: true,
      lookup: {
        from: "google.domains",
        label: "{{ .domainName }}{{ if .isPrimary }} (primary){{ end }}",
        value: "domainName",
        sets: { display_name: "Team at {{ .domainName }}" },
      },
    },
    {
      name: "group_name",
      label: "Group name",
      description: "The group's local part.",
      tfType: "string",
      kind: "string",
      hasDefault: false,
      sensitive: false,
      primary: true,
      suffix: "@{{ .domain }}",
      checks: [
        { kind: "regex", pattern: "^[a-z0-9-]+@[a-z.]+$", message: "Use lowercase letters." },
      ],
    },
    {
      name: "display_name",
      label: "Display name",
      description: "",
      tfType: "string",
      kind: "string",
      hasDefault: true,
      default: "",
      sensitive: false,
      primary: true,
    },
    {
      name: "allow_external",
      label: "Allow external members",
      description: "Let people outside the domain join.",
      tfType: "bool",
      kind: "bool",
      hasDefault: true,
      default: false,
      sensitive: false,
      primary: false,
    },
  ],
}

const invoke = vi.fn((channel: string) => {
  if (channel === "tofu-module:lookup") {
    return Promise.resolve({
      rows: [
        { domainName: "example.com", isPrimary: true },
        { domainName: "example.org", isPrimary: false },
      ],
    })
  }
  return Promise.reject(new Error(`unexpected channel ${channel}`))
})

vi.mock("@/hooks/useIpc", () => ({ useIpc: () => ({ data: spec, isLoading: false, error: null }) }))

vi.mock("@/contexts/ApiContext", () => ({ useApi: () => ({ invoke }) }))

vi.mock("@/contexts/useLogs", () => ({ useLogs: () => ({ registerLogs: vi.fn() }) }))

let ctx: RunbookContextType | undefined
function Capture() {
  const runbook = useRunbookContext()
  useEffect(() => {
    ctx = runbook
  }, [runbook])
  return null
}

function renderBlock() {
  return render(
    <TestWrapper>
      <Capture />
      <TofuModule id="group" source="google-group" />
    </TestWrapper>,
  )
}

const input = (name: string) => document.getElementById(`group-${name}`) as HTMLInputElement

describe("TofuModule", () => {
  beforeEach(() => {
    ctx = undefined
    invoke.mockClear()
  })

  it("shows the primary inputs and keeps the rest under Advanced options", () => {
    renderBlock()
    expect(screen.getByText("Google group", { selector: "div" })).toBeInTheDocument()
    const ui = within(screen.getByRole("tabpanel"))
    expect(ui.getByLabelText(/Group name/)).toBeInTheDocument()
    expect(ui.queryByText("Allow external members")).not.toBeInTheDocument()

    fireEvent.click(ui.getByRole("button", { name: /Advanced options/ }))
    expect(ui.getByText("Allow external members")).toBeInTheDocument()
  })

  it("flags required inputs and failed checks on Next, and doesn't submit", () => {
    renderBlock()
    fireEvent.change(input("group_name"), { target: { value: "Not Valid" } })
    fireEvent.click(screen.getByRole("button", { name: "Next" }))

    expect(screen.getByText("Choose Domain first.")).toBeInTheDocument()
    expect(screen.getByText("Required.")).toBeInTheDocument()
    expect(screen.getByText("2 inputs above need a fix.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument()
  })

  it("fills other inputs from a lookup pick, and registers the values", async () => {
    renderBlock()
    fireEvent.change(input("group_name"), { target: { value: "platform" } })

    const domain = input("domain")
    fireEvent.change(domain, { target: { value: "example" } })
    const option = await screen.findByRole("option", { name: /example\.com \(primary\)/ })
    fireEvent.mouseDown(option)

    expect(domain).toHaveValue("example.com")
    expect(input("display_name")).toHaveValue("Team at example.com")
    expect(invoke).toHaveBeenCalledWith("tofu-module:lookup", {
      from: "google.domains",
      query: "example",
    })

    expect(screen.getByTestId("group-group_name-suffix")).toHaveTextContent("@example.com")

    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    await waitFor(() =>
      expect(flattenInputs(ctx!.getInputs("group"))).toEqual({
        group_name: "platform@example.com",
        domain: "example.com",
        display_name: "Team at example.com",
        allow_external: false,
      }),
    )
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true")
  })

  it("shows the email's domain once an organization is chosen, and asks for one first", () => {
    renderBlock()
    expect(screen.getByTestId("group-group_name-suffix")).toHaveTextContent("@‹Domain›")
    fireEvent.change(input("group_name"), { target: { value: "platform" } })
    fireEvent.blur(input("group_name"))
    expect(screen.getByText("Choose Domain first.")).toBeInTheDocument()
  })

  it("opens suggestions on typing or Enter, not on focus", async () => {
    renderBlock()
    const domain = input("domain")
    fireEvent.focus(domain)
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith("tofu-module:lookup", expect.anything())

    fireEvent.keyDown(domain, { key: "Enter" })
    expect(await screen.findByRole("option", { name: /example\.org/ })).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith("tofu-module:lookup", { from: "google.domains", query: "" })
  })
})
