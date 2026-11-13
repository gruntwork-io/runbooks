import { beforeEach, describe, expect, it, vi } from "vitest"
import { useEffect } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { Workspace } from "../Workspace"
import { WorkspaceRevealProvider, useWorkspaceReveal } from "@/contexts/WorkspaceRevealContext"
import { BlockWritesProvider, useBlockWrites } from "@/contexts/BlockWritesContext"
import type { WorkspaceFileChange } from "@/hooks/useGitFileChanges"

const LIVE = {
  id: "live",
  repoUrl: "https://github.com/acme/infra-live.git",
  localPath: "/clones/infra-live",
  gitInfo: { repoUrl: "", repoName: "infra-live", repoOwner: "acme", ref: "main" },
}
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    workTrees: [LIVE],
    activeWorkTree: LIVE,
    activeWorkTreeId: LIVE.id,
    setActiveWorkTree: vi.fn(),
  }),
}))
vi.mock("@/hooks/useGitFileTree", () => ({
  useGitFileTree: () => ({
    tree: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    fetchSubtree: vi.fn(),
  }),
}))

const change = (path: string): WorkspaceFileChange => ({
  path,
  changeType: "added",
  additions: 1,
  deletions: 0,
  language: "hcl",
  originalContent: "",
  newContent: "x\n",
})
const README = change("README.md")
const LOGS = change("buckets/logs/terragrunt.hcl")
const DATA = change("buckets/data/terragrunt.hcl")
let changes = [README, LOGS, DATA]
vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({
    changes,
    totalChanges: changes.length,
    tooManyChanges: false,
    isLoading: false,
    fetchFileDiff: vi.fn(),
  }),
}))

let api: ReturnType<typeof useWorkspaceReveal> & ReturnType<typeof useBlockWrites>
function Capture() {
  const reveal = useWorkspaceReveal()
  const writes = useBlockWrites()
  useEffect(() => {
    api = { ...reveal, ...writes }
  }, [reveal, writes])
  return null
}

function renderWorkspace() {
  return render(
    <WorkspaceRevealProvider>
      <BlockWritesProvider>
        <Capture />
        <Workspace generatedFiles={[]} />
      </BlockWritesProvider>
    </WorkspaceRevealProvider>,
  )
}

const writtenBy = () => screen.queryByRole("combobox", { name: "Written by" })
const shownFiles = () =>
  screen
    .queryAllByTestId(/^diff-file-/)
    .map((el) => el.dataset.testid!.replace("diff-file-", ""))
    .sort()

/** Two TfModule blocks wrote a unit each, and a Command block changed the README. */
function recordUnits() {
  act(() => {
    api.recordWrite({
      blockId: "logs",
      label: "Logs bucket",
      worktreePath: LIVE.localPath,
      paths: [LOGS.path],
    })
    api.recordWrite({
      blockId: "data",
      label: "Data bucket",
      worktreePath: LIVE.localPath,
      paths: [DATA.path],
    })
  })
  act(() => api.revealFiles(LIVE.localPath, [DATA.path], "data"))
}

describe("Workspace Written by", () => {
  beforeEach(() => {
    changes = [README, LOGS, DATA]
  })

  it("lists the blocks that wrote changed files, and shows only the chosen block's", () => {
    renderWorkspace()
    expect(writtenBy()).toBeNull()

    recordUnits()
    const select = writtenBy()!
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Any block",
      "Logs bucket",
      "Data bucket",
    ])
    expect(shownFiles()).toEqual([DATA.path, LOGS.path, README.path].sort())

    fireEvent.change(select, { target: { value: "logs" } })
    expect(shownFiles()).toEqual([LOGS.path])
    expect(screen.getByText(/changed file$/)).toHaveTextContent("1 changed file")

    fireEvent.change(select, { target: { value: "" } })
    expect(shownFiles()).toHaveLength(3)
  })

  it("leaves out a block whose files no longer differ, and then shows every file", () => {
    const { rerender } = renderWorkspace()
    recordUnits()
    fireEvent.change(writtenBy()!, { target: { value: "logs" } })

    // The logs unit was committed, so it's no longer a change.
    changes = [README, DATA]
    rerender(
      <WorkspaceRevealProvider>
        <BlockWritesProvider>
          <Capture />
          <Workspace generatedFiles={[]} />
        </BlockWritesProvider>
      </WorkspaceRevealProvider>,
    )
    // The same providers render again, so the writes are kept.
    expect([...writtenBy()!.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Any block",
      "Data bucket",
    ])
    expect(shownFiles()).toEqual([DATA.path, README.path].sort())
  })

  it("tells blocks with the same label apart by their ids", () => {
    renderWorkspace()
    act(() => {
      for (const [blockId, path] of [
        ["logs", LOGS.path],
        ["data", DATA.path],
      ] as const) {
        api.recordWrite({
          blockId,
          label: "Describe the bucket",
          worktreePath: LIVE.localPath,
          paths: [path],
        })
      }
    })

    expect([...writtenBy()!.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Any block",
      "Describe the bucket (logs)",
      "Describe the bucket (data)",
    ])
  })

  it("shows every block's files when another block shows its own", () => {
    renderWorkspace()
    recordUnits()
    fireEvent.change(writtenBy()!, { target: { value: "logs" } })

    act(() => api.revealFiles(LIVE.localPath, [LOGS.path], "logs"))
    expect(writtenBy()).toHaveValue("logs")

    act(() => api.revealFiles(LIVE.localPath, [DATA.path], "data"))
    expect(writtenBy()).toHaveValue("")
    expect(shownFiles()).toHaveLength(3)
  })
})
