import { beforeEach, describe, expect, it, vi } from "vitest"
import { useEffect } from "react"
import { act, render, screen } from "@testing-library/react"
import { Workspace } from "../Workspace"
import { WorkspaceRevealProvider, useWorkspaceReveal } from "@/contexts/WorkspaceRevealContext"
import type { GitWorkTree } from "@/contexts/gitWorkTreeTypes"

const tree = (id: string, localPath: string): GitWorkTree => ({
  id,
  repoUrl: `https://github.com/acme/${id}.git`,
  localPath,
  gitInfo: { repoUrl: "", repoName: id, repoOwner: "acme", ref: "main" },
})
const LIVE = tree("live", "/clones/infra-live")
const CATALOG = tree("catalog", "/clones/infra-catalog")

let active: GitWorkTree = LIVE
const setActiveWorkTree = vi.fn((id: string) => {
  active = id === LIVE.id ? LIVE : CATALOG
})
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    workTrees: [LIVE, CATALOG],
    activeWorkTree: active,
    activeWorkTreeId: active.id,
    setActiveWorkTree,
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
vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({
    changes: [],
    totalChanges: 0,
    tooManyChanges: false,
    isLoading: false,
    fetchFileDiff: vi.fn(),
  }),
}))

let revealFiles: ReturnType<typeof useWorkspaceReveal>["revealFiles"] = () => {}
function Capture() {
  const reveal = useWorkspaceReveal().revealFiles
  useEffect(() => {
    revealFiles = reveal
  }, [reveal])
  return null
}

function renderWorkspace() {
  return render(
    <WorkspaceRevealProvider>
      <Capture />
      <Workspace generatedFiles={[]} />
    </WorkspaceRevealProvider>,
  )
}

describe("Workspace reveal", () => {
  beforeEach(() => {
    active = LIVE
    setActiveWorkTree.mockClear()
  })

  it("switches to the changed files of the clone a block wrote to", () => {
    renderWorkspace()
    expect(screen.getByTestId("filetree-all")).toBeInTheDocument()

    act(() => revealFiles(CATALOG.localPath, ["modules/s3-bucket/main.tf"]))

    expect(screen.getByTestId("filetree-changed")).toBeInTheDocument()
    expect(setActiveWorkTree).toHaveBeenCalledWith("catalog")
  })

  it("stays where it is for a clone it doesn't know", () => {
    renderWorkspace()

    act(() => revealFiles("/clones/elsewhere", ["main.tf"]))

    expect(screen.getByTestId("filetree-all")).toBeInTheDocument()
    expect(setActiveWorkTree).not.toHaveBeenCalled()
  })
})
