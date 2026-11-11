import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { RunbookContextType } from "@/contexts/RunbookContext"
import type { TfModuleSpec } from "../../../../../../src/domain/tf-module/types"
import TerragruntApplyWithGitHubPullRequest from "../TerragruntApplyWithGitHubPullRequest"

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({ activeWorkTree: null, workTrees: [] }),
}))

const spec: TfModuleSpec = {
  title: "Google group",
  description: "",
  providers: [{ name: "google" }],
  outputs: [],
  googleApis: [],
  warnings: [],
  variables: [],
}
const useIpc = vi.fn((channel: string, _params: unknown) =>
  channel
    ? { data: spec, isLoading: false, error: null }
    : { data: null, isLoading: false, error: null },
)
vi.mock("@/hooks/useIpc", () => ({
  useIpc: (channel: string, params: unknown) => useIpc(channel, params),
}))

const TERRAGRUNT_CODE = {
  kind: "workspace",
  tool: "terragrunt",
  files: [{ path: "group/terragrunt.hcl", content: 'inputs = { id = "platform" }' }],
}
const TOFU_CODE = {
  kind: "workspace",
  tool: "tofu",
  files: [{ path: "group/main.tf", content: 'module "group" {}' }],
}
let rendered: unknown = TERRAGRUNT_CODE
const invoke = vi.fn((channel: string) =>
  channel === "tf-module:render"
    ? Promise.resolve(rendered)
    : Promise.reject(new Error(`unexpected channel ${channel}`)),
)
const api = { invoke, on: () => () => {} }
vi.mock("@/contexts/ApiContext", () => ({ useApi: () => api }))

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
      <TerragruntApplyWithGitHubPullRequest id="apply-group" tfModuleId="group" />
    </TestWrapper>,
  )
}

describe("TerragruntApplyWithGitHubPullRequest", () => {
  beforeEach(() => {
    ctx = undefined
    rendered = TERRAGRUNT_CODE
    invoke.mockClear()
    useIpc.mockClear()
  })

  it("waits for the <TfModule> block to generate its code", () => {
    renderBlock()
    expect(screen.getByText("Waiting for the code")).toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })

  it("shows Terragrunt's logo, whatever the module's provider", () => {
    renderBlock()
    expect(screen.getByRole("img", { name: "Terragrunt" })).toBeInTheDocument()
  })

  async function generate() {
    await waitFor(() => expect(ctx).toBeDefined())
    act(() => {
      ctx!.registerInputs("group", { id: "platform" }, { variables: [] } as never)
      ctx!.registerOutputs("group", {
        MODULE_SOURCE: "google-group",
        TEMPLATE: "templates/google-group-unit",
        CODE_PATH: "groups/platform",
      })
    })
  }

  it("shows the generated code, rendered with the module block's inputs", async () => {
    renderBlock()
    await generate()

    expect(await screen.findByRole("tab", { name: "Code" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(useIpc).toHaveBeenCalledWith("tf-module:read", { source: "google-group" })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("tf-module:render", {
        blockId: "group",
        source: "google-group",
        template: "templates/google-group-unit",
        values: { id: "platform" },
      }),
    )
    expect(screen.getByRole("tab", { name: "PR" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Apply" })).toBeInTheDocument()
  })

  it("refuses code that isn't a Terragrunt unit", async () => {
    rendered = TOFU_CODE
    renderBlock()
    await generate()

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This block applies Terragrunt units only",
    )
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })
})
