import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { CodeTab } from "../components/CodeTab"
import type { TfModuleCode } from "../../../../../../electron/shared/channels"

const repoCode = (over: Partial<Extract<TfModuleCode, { kind: "repo" }>> = {}): TfModuleCode => ({
  kind: "repo",
  tool: "terragrunt",
  folder: "google-groups/eng",
  files: [
    { path: "root.hcl", content: "remote_state {}\n", status: "context" },
    {
      path: "google-groups/eng/terragrunt.hcl",
      content: 'display_name = "Engineering"\n',
      status: "modified",
      before: 'display_name = "Platform"\n',
    },
    { path: "google-groups/eng/extra.hcl", content: "x = 1\n", status: "added" },
  ],
  rootHcl: true,
  source: "git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0",
  ...over,
})

const renderTab = (code: TfModuleCode, selected?: string) =>
  render(
    <CodeTab
      code={code}
      moduleFolder="google-group"
      error={null}
      repository={{ name: "acme/infrastructure-live", baseBranch: "main" }}
      errorCount={0}
      selected={selected}
      onSelect={vi.fn()}
    />,
  )

describe("CodeTab in a repository", () => {
  it("lists the repository, the branch, and the module, linked to GitHub", () => {
    renderTab(repoCode())
    expect(screen.getByText("acme/infrastructure-live")).toBeInTheDocument()
    expect(screen.getByText("main")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /group/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/catalog/tree/v1.0.0/modules/group",
    )
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
  })

  it("shows the unit in its folder, marked against the base branch, beside the files above it", () => {
    renderTab(repoCode())
    expect(screen.getByRole("treeitem", { name: /terragrunt\.hcl/ })).toHaveAccessibleDescription(
      "Changes the file on main",
    )
    expect(screen.getByRole("treeitem", { name: /extra\.hcl/ })).toHaveAccessibleDescription(
      "New: not on main",
    )
    expect(screen.getByRole("treeitem", { name: /root\.hcl/ })).not.toHaveAccessibleDescription()
  })

  it("shows a changed file as its changes, or as a whole", () => {
    renderTab(repoCode())
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText('display_name = "Platform"')).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Whole file" }))
    expect(screen.queryByText('display_name = "Platform"')).not.toBeInTheDocument()
  })

  it("says a context file stays as it is", () => {
    renderTab(repoCode(), "root.hcl")
    expect(screen.getByText(/Already on main, shown for context/)).toBeInTheDocument()
  })

  it("warns when the module has no pinned source, and when the repository has no root.hcl", () => {
    renderTab(repoCode({ source: undefined, rootHcl: false }))
    expect(screen.getByText("google-group")).toBeInTheDocument()
    expect(screen.getByLabelText(/Add a pinned source to runbook_block\.yml/)).toBeInTheDocument()
    expect(screen.getByLabelText(/has no root\.hcl above this folder/)).toBeInTheDocument()
  })
})
