import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { CodeTab } from "../components/CodeTab"
import type { TofuModuleCode } from "../../../../../../electron/shared/channels"

const repoCode = (
  over: Partial<Extract<TofuModuleCode, { kind: "repo" }>> = {},
): TofuModuleCode => ({
  kind: "repo",
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
  pinned: true,
  ...over,
})

const renderTab = (code: TofuModuleCode, selected?: string) =>
  render(
    <CodeTab
      code={code}
      error={null}
      repository={{ name: "acme/infrastructure-live", baseBranch: "main" }}
      errorCount={0}
      selected={selected}
      onSelect={vi.fn()}
    />,
  )

describe("CodeTab in a repository", () => {
  it("shows the unit in its folder, marked against the base branch, beside the files above it", () => {
    renderTab(repoCode())
    expect(screen.getByText("google-groups/eng")).toBeInTheDocument()
    expect(screen.getByText("acme/infrastructure-live")).toBeInTheDocument()
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
    renderTab(repoCode({ pinned: false, rootHcl: false }))
    expect(screen.getByText(/gives no/)).toBeInTheDocument()
    expect(screen.getByText(/has no root\.hcl above/)).toBeInTheDocument()
  })
})
