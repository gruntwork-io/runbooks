import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useRef } from "react"
import { TestWrapper } from "@/test/test-utils"
import { useComponentIdRegistry, type BlockComponentType } from "@/contexts/ComponentIdRegistry"
import type { MergeState } from "../../../../../../src/domain/git/merge"
import GitPullRequest from "../GitPullRequest"

// The real block with the real clone rules and Merge button. The mock
// boundaries are the clones, their changes, the create flow, and the preload
// API the Merge button asks.

const clone = (id: string, repoName: string) => ({
  id,
  localPath: `/clones/${repoName}`,
  gitInfo: {
    repoUrl: `https://github.com/acme/${repoName}.git`,
    repoOwner: "acme",
    repoName,
    ref: "main",
  },
})
const workTrees = [clone("modules", "infra-modules"), clone("live", "infra-live")]
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({ activeWorkTree: workTrees[0], workTrees }),
}))

const changesFor = vi.fn((_path: string | undefined) => ({
  changes: [],
  totalChanges: 0,
  tooManyChanges: false,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  fetchFileDiff: vi.fn(),
}))
vi.mock("@/hooks/useGitFileChanges", () => ({
  useCloneChanges: (path: string | undefined) => changesFor(path),
  useGitFileChanges: () => changesFor(undefined),
}))

let prResult: { prUrl: string; prNumber: number; branchName: string } | null = null
vi.mock("../hooks/useGitPullRequest", () => ({
  useGitPullRequest: () => ({
    status: prResult ? "success" : "pending",
    logs: [],
    prResult,
    prOutputs: null,
    errorMessage: null,
    errorCode: null,
    conflictBranchName: null,
    pushError: null,
    labels: [],
    labelsLoading: false,
    authMet: true,
    wrongProvider: false,
    createPullRequest: vi.fn(),
    pushChanges: vi.fn(),
    deleteBranch: vi.fn(),
    fetchLabels: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock("../components/ChangedFiles", () => ({
  ChangedFiles: () => <div data-testid="pr-changed-files" />,
}))

let mergeStates: MergeState[] = []
const invoke = vi.fn((channel: string, _params?: unknown): Promise<unknown> => {
  switch (channel) {
    case "git:pr-merge-state":
      return Promise.resolve(mergeStates.shift() ?? { state: "closed" })
    case "git:pr-merge":
      return Promise.resolve({ sha: "0123456789abcdef" })
    default:
      return Promise.resolve(undefined)
  }
})
vi.mock("@/contexts/ApiContext", () => ({ useApi: () => ({ invoke, on: () => () => {} }) }))

/** Stands in for another block, registered under its kind. */
function Fake({ id, kind }: { id: string; kind: BlockComponentType }) {
  const ref = useRef<HTMLDivElement>(null)
  useComponentIdRegistry(id, kind, ref)
  return <div ref={ref} />
}

function renderBlock(
  props: Partial<React.ComponentProps<typeof GitPullRequest>> = {},
  blocks: { id: string; kind: BlockComponentType }[] = [{ id: "live", kind: "GitClone" }],
) {
  return render(
    <TestWrapper>
      {blocks.map((block) => (
        <Fake key={block.id} {...block} />
      ))}
      <GitPullRequest id="pr" provider="github" {...props} />
    </TestWrapper>,
  )
}

const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel)

describe("GitPullRequest clone and merge", () => {
  beforeEach(() => {
    prResult = null
    mergeStates = []
    invoke.mockClear()
    changesFor.mockClear()
  })

  it("needs a GitClone block, and a gitCloneId when there are several", async () => {
    const { unmount } = renderBlock({}, [])
    expect(await screen.findByText(/needs a <GitClone> block/)).toBeInTheDocument()
    unmount()
    renderBlock({}, [
      { id: "modules", kind: "GitClone" },
      { id: "live", kind: "GitClone" },
    ])
    expect(await screen.findByText(/needs a gitCloneId/)).toBeInTheDocument()
  })

  it("refuses a gitCloneId that names a block that isn't a GitClone", async () => {
    renderBlock({ gitCloneId: "auth" }, [
      { id: "live", kind: "GitClone" },
      { id: "auth", kind: "GitHubAuth" },
    ])
    expect(await screen.findByText(/"auth", which isn't a <GitClone> block/)).toBeInTheDocument()
  })

  it("works in the clone gitCloneId names, not the active one", async () => {
    renderBlock({ gitCloneId: "live" }, [
      { id: "modules", kind: "GitClone" },
      { id: "live", kind: "GitClone" },
    ])
    await waitFor(() => expect(changesFor).toHaveBeenCalledWith("/clones/infra-live"))
    expect(changesFor).not.toHaveBeenCalledWith("/clones/infra-modules")
  })

  it("refuses allowMerge on GitLab", async () => {
    renderBlock({ provider: "gitlab", allowMerge: true })
    expect(await screen.findByText(/allowMerge works with GitHub only/)).toBeInTheDocument()
  })

  it("shows no Merge button without allowMerge", async () => {
    prResult = { prUrl: "https://github.com/acme/infra-live/pull/7", prNumber: 7, branchName: "b" }
    renderBlock()
    expect(await screen.findByText(/opened successfully/)).toBeInTheDocument()
    expect(screen.queryByTestId("pr-merge")).not.toBeInTheDocument()
    expect(calls("git:pr-merge-state")).toHaveLength(0)
  })

  it("keeps Merge disabled with GitHub's reason while branch protection blocks it", async () => {
    prResult = { prUrl: "https://github.com/acme/infra-live/pull/7", prNumber: 7, branchName: "b" }
    mergeStates = [
      { state: "open", mergeability: "blocked", method: "squash", reason: "Needs a review." },
    ]
    renderBlock({ allowMerge: true })
    expect(await screen.findByText("Needs a review.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Squash and merge/ })).toBeDisabled()
    expect(calls("git:pr-merge-state")[0]![1]).toEqual({
      worktreePath: "/clones/infra-live",
      owner: "acme",
      repo: "infra-live",
      number: 7,
    })
  })

  it("merges once GitHub says it can, and stops offering a push", async () => {
    prResult = { prUrl: "https://github.com/acme/infra-live/pull/7", prNumber: 7, branchName: "b" }
    mergeStates = [{ state: "open", mergeability: "ready", method: "merge" }]
    renderBlock({ allowMerge: true })
    const button = await screen.findByRole("button", { name: /^Merge$/ })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByText("0123456")).toBeInTheDocument()
    expect(calls("git:pr-merge")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Git Push" })).toBeDisabled()
  })
})
