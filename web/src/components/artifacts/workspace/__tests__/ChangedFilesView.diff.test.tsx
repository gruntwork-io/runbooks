import { describe, it, expect } from "vitest"
import { render, screen, within } from "@testing-library/react"
import type { WorkspaceFileChange } from "@/hooks/useGitFileChanges"
import { ChangedFilesView } from "../ChangedFilesView"

const change = (overrides: Partial<WorkspaceFileChange>): WorkspaceFileChange => ({
  path: "terraform.tfvars",
  changeType: "modified",
  additions: 0,
  deletions: 0,
  language: "hcl",
  ...overrides,
})

/** Each diff row as it reads on screen: the +/-/space prefix and the line. */
const diffRows = (path: string) =>
  within(screen.getByTestId(`diff-file-${path}`))
    .queryAllByRole("row")
    .map(row => {
      const cells = within(row).getAllByRole("cell")
      return cells.length === 4 ? `${cells[2].textContent}${cells[3].textContent}` : row.textContent
    })

describe("ChangedFilesView diff body", () => {
  it("shows every line as added for a modified file that was empty in HEAD", () => {
    render(
      <ChangedFilesView
        changes={[change({ additions: 2, originalContent: "", newContent: 'region = "us-east-1"\nname = "app"\n' })]}
      />,
    )

    expect(diffRows("terraform.tfvars")).toEqual(['+region = "us-east-1"', '+name = "app"'])
  })

  it("shows every line as deleted for a modified file truncated to empty", () => {
    render(<ChangedFilesView changes={[change({ deletions: 2, originalContent: "a\nb", newContent: "" })]} />)

    expect(diffRows("terraform.tfvars")).toEqual(["-a", "-b"])
  })

  it("says the diff is unavailable when git could not provide the HEAD version", () => {
    render(<ChangedFilesView changes={[change({ additions: 2, newContent: "a\nb\n" })]} />)

    const file = screen.getByTestId("diff-file-terraform.tfvars")
    expect(within(file).getByText("Diff unavailable for this file")).toBeInTheDocument()
    expect(within(file).queryAllByRole("row")).toHaveLength(0)
  })

  it("says an added file is empty instead of rendering an empty table", () => {
    render(<ChangedFilesView changes={[change({ path: ".keep", changeType: "added", newContent: "" })]} />)

    expect(within(screen.getByTestId("diff-file-.keep")).getByText("Empty file")).toBeInTheDocument()
  })

  it("does not add a blank line for the final newline read from disk", () => {
    render(<ChangedFilesView changes={[change({ originalContent: "a\nb", newContent: "a\nb\n" })]} />)

    // No changed lines: the whole file sits behind one expand bar.
    expect(diffRows("terraform.tfvars")).toEqual(["Expand 2 hidden lines"])
  })
})
