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

type FakeBlock = { id: string; kind: BlockComponentType }

function renderBlock(
  props: Partial<React.ComponentProps<typeof GitPullRequest>> = {},
  blocks: FakeBlock[] = [{ id: "live", kind: "GitClone" }],
  below: FakeBlock[] = [],
) {
  return render(
    <TestWrapper>
      {blocks.map((block) => (
        <Fake key={block.id} {...block} />
      ))}
      <GitPullRequest id="pr" provider="github" {...props} />
      {below.map((block) => (
        <Fake key={block.id} {...block} />
      ))}
    </TestWrapper>,
  )
}

const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel)

describe("GitPullRequest clone and merge", () => {
  beforeEach(() => {
    prResult = null
    mergeStates = []
    invoke.mockClear()
    changesFor.mockReset()
  })

  it("works in the active repository when the runbook has no GitClone block", async () => {
    renderBlock({}, [])
    await waitFor(() => expect(changesFor).toHaveBeenCalledWith("/clones/infra-modules"))
    expect(screen.queryByText(/needs a <GitClone> block/)).not.toBeInTheDocument()
  })

  it("works in the nearest clone above it when there are several", async () => {
    renderBlock({}, [
      { id: "modules", kind: "GitClone" },
      { id: "live", kind: "GitClone" },
    ])
    await waitFor(() => expect(changesFor).toHaveBeenCalledWith("/clones/infra-live"))
    expect(screen.queryByText(/needs a gitCloneId/)).not.toBeInTheDocument()
  })

  it("needs a gitCloneId when none of several clones is above it", async () => {
    renderBlock(
      {},
      [],
      [
        { id: "modules", kind: "GitClone" },
        { id: "live", kind: "GitClone" },
      ],
    )
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

  it("refuses allowPullRequestMerge on GitLab", async () => {
    renderBlock({ provider: "gitlab", allowPullRequestMerge: true })
    expect(
      await screen.findByText(/allowPullRequestMerge works with GitHub only/),
    ).toBeInTheDocument()
  })

  it("shows no Merge button without allowPullRequestMerge", async () => {
    prResult = { prUrl: "https://github.com/acme/infra-live/pull/7", prNumber: 7, branchName: "b" }
    renderBlock()
    expect(await screen.findByText(/opened successfully/)).toBeInTheDocument()
    expect(screen.queryByTestId("pr-merge")).not.toBeInTheDocument()
    expect(calls("git:pr-merge-state")).toHaveLength(0)
  })

  it("keeps Merge disabled with GitHub's reason while branch protection blocks it", async () => {
    prResult = { prUrl: "https://github.com/acme/infra-live/pull/7", prNumber: 7, branchName: "b" }
    mergeStates = [
      {
        state: "open",
        mergeability: "blocked",
        headSha: "head1",
        method: "squash",
        reason: "Needs a review.",
      },
    ]
    renderBlock({ allowPullRequestMerge: true })
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
    mergeStates = [
      {
        state: "open",
        mergeability: "ready",
        headSha: "head1",
        method: "merge",
        warning: "Some checks aren't done.",
      },
    ]
    renderBlock({ allowPullRequestMerge: true })
    const button = await screen.findByRole("button", { name: /^Merge$/ })
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByText("Some checks aren't done.")).toBeInTheDocument()
    fireEvent.click(button)
    expect(await screen.findByText("0123456")).toBeInTheDocument()
    expect(screen.queryByText("Some checks aren't done.")).not.toBeInTheDocument()
    expect(calls("git:pr-merge")).toEqual([
      [
        "git:pr-merge",
        {
          worktreePath: "/clones/infra-live",
          owner: "acme",
          repo: "infra-live",
          number: 7,
          headSha: "head1",
        },
      ],
    ])
    expect(screen.getByRole("button", { name: "Git Push" })).toBeDisabled()
  })

  it("refuses a merge condition it doesn't know", async () => {
    renderBlock({
      allowPullRequestMerge: true,
      allowPullRequestMergeConditions: ["checks-green"],
    })
    expect(
      await screen.findByText(/names "checks-green", which isn't a condition it knows/),
    ).toBeInTheDocument()
    expect(screen.getByText(/The conditions are: no-uncommitted-changes/)).toBeInTheDocument()
  })

  it("refuses merge conditions without allowPullRequestMerge", async () => {
    renderBlock({ allowPullRequestMergeConditions: ["no-uncommitted-changes"] })
    expect(
      await screen.findByText(/allowPullRequestMergeConditions needs allowPullRequestMerge/),
    ).toBeInTheDocument()
  })

  it("keeps Merge disabled while no-uncommitted-changes doesn't hold, though GitHub says it can merge", async () => {
    prResult = { prUrl: "https://github.com/acme/infra-live/pull/7", prNumber: 7, branchName: "b" }
    mergeStates = [{ state: "open", mergeability: "ready", headSha: "head1", method: "merge" }]
    changesFor.mockReturnValue({ ...changesFor(undefined), totalChanges: 2 })
    renderBlock({
      allowPullRequestMerge: true,
      allowPullRequestMergeConditions: ["no-uncommitted-changes"],
    })
    expect(
      await screen.findByText(
        "2 files aren't committed yet. Push them to the pull request before merging.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Merge$/ })).toBeDisabled()
  })

  it("enables Merge once no-uncommitted-changes holds", async () => {
    prResult = { prUrl: "https://github.com/acme/infra-live/pull/7", prNumber: 7, branchName: "b" }
    mergeStates = [{ state: "open", mergeability: "ready", headSha: "head1", method: "merge" }]
    renderBlock({
      allowPullRequestMerge: true,
      allowPullRequestMergeConditions: ["no-uncommitted-changes"],
    })
    const button = await screen.findByRole("button", { name: /^Merge$/ })
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.queryByText(/committed yet/)).not.toBeInTheDocument()
  })

  it("starts the changed files closed, or open with changedFilesExpanded", () => {
    changesFor.mockReturnValue({
      ...changesFor(undefined),
      totalChanges: 1,
      changes: [{ path: "a.tf", changeType: "added", additions: 1, deletions: 0 }] as never[],
    })
    const { unmount } = renderBlock()
    expect(screen.queryByTestId("pr-changed-files")).not.toBeInTheDocument()
    unmount()
    renderBlock({ changedFilesExpanded: true })
    expect(screen.getByTestId("pr-changed-files")).toBeInTheDocument()
  })
})
