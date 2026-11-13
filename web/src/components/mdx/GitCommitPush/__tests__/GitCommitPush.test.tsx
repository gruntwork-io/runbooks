import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { TestWrapper } from "@/test/test-utils"
import {
  useComponentIdRegistry,
  type BlockComponentType,
  type PullRequestPlace,
} from "@/contexts/ComponentIdRegistry"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { WorkspaceFileChange } from "@/contexts/WorkspaceGitDataContext.types"
import type { MergeState } from "../../../../../../src/domain/git/merge"
import GitCommitPush from "../GitCommitPush"

// The real block, file list and Merge button. The mock boundaries are the
// clones, their changes, and the preload API that pushes and asks GitHub.

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
const invalidateGitFileTree = vi.fn()
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({ activeWorkTree: workTrees[0], workTrees, invalidateGitFileTree }),
}))

const change = (path: string, changeType: WorkspaceFileChange["changeType"]) =>
  ({
    path,
    changeType,
    additions: 1,
    deletions: 0,
    language: "hcl",
    newContent: "x\n",
  }) satisfies WorkspaceFileChange

let changes: WorkspaceFileChange[] = []
const changesFor = vi.fn((_path: string | undefined) => ({
  changes,
  totalChanges: changes.length,
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

let mergeStates: MergeState[] = []
let pushResult: unknown = {
  ok: true,
  branch: "runbook/1",
  commitSha: "abc1234def",
  committed: true,
}
const invoke = vi.fn((channel: string, _params?: unknown): Promise<unknown> => {
  switch (channel) {
    case "git:push":
      return Promise.resolve(pushResult)
    case "git:pr-merge-state":
      return Promise.resolve(mergeStates.shift() ?? { state: "closed" })
    default:
      return Promise.resolve(undefined)
  }
})
// One object, as the app's API is, so effects that depend on it don't run again each render.
const api = { invoke, on: () => () => {} }
vi.mock("@/contexts/ApiContext", () => ({ useApi: () => api }))

/** Stands in for another block, registered under its kind. */
function Fake({
  id,
  kind,
  place,
  outputs,
}: {
  id: string
  kind: BlockComponentType
  place?: PullRequestPlace
  outputs?: Record<string, string>
}) {
  const ref = useRef<HTMLDivElement>(null)
  useComponentIdRegistry(id, kind, ref, undefined, place)
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    if (outputs) registerOutputs(id, outputs)
  }, [id, outputs, registerOutputs])
  return <div ref={ref} />
}

const PR_OUTPUTS = {
  PR_ID: "42",
  PR_URL: "https://github.com/acme/infra-live/pull/42",
  BRANCH: "runbook/1",
}
// A pull request block, with the outputs it has once its pull request is open, or null before.
const prBlock = (outputs: Record<string, string> | null = PR_OUTPUTS, provider = "github") => ({
  id: "pr",
  kind: "GitHubPullRequest" as const,
  place: { cloneId: "live", provider: provider as "github" | "gitlab" },
  ...(outputs ? { outputs } : {}),
})

function renderBlock(
  props: Partial<React.ComponentProps<typeof GitCommitPush>> = {},
  blocks: Array<React.ComponentProps<typeof Fake>> = [
    { id: "modules", kind: "GitClone" },
    { id: "live", kind: "GitClone" },
    prBlock(),
  ],
) {
  return render(
    <TestWrapper>
      {blocks.map((block) => (
        <Fake key={block.id} {...block} />
      ))}
      <GitCommitPush id="commit" changedFilesExpanded {...props} />
    </TestWrapper>,
  )
}

const pushCalls = () => invoke.mock.calls.filter(([name]) => name === "git:push")

describe("GitCommitPush", () => {
  beforeEach(() => {
    changes = [change("live/acme/terragrunt.hcl", "added"), change("README.md", "modified")]
    mergeStates = []
    pushResult = { ok: true, branch: "runbook/1", commitSha: "abc1234def", committed: true }
    invoke.mockClear()
    changesFor.mockClear()
    invalidateGitFileTree.mockClear()
  })

  it("waits for the pull request until its block has opened it", async () => {
    renderBlock({ pullRequestId: "pr" }, [{ id: "live", kind: "GitClone" }, prBlock(null)])
    expect(await screen.findByText("Waiting for the pull request")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /push/i })).not.toBeInTheDocument()
  })

  it("commits the chosen files on the pull request's branch, in its clone", async () => {
    renderBlock({ pullRequestId: "pr" })

    expect(await screen.findByText("Pull request #42")).toBeInTheDocument()
    expect(screen.getByText("2 of 2 changed files chosen")).toBeInTheDocument()
    expect(changesFor).toHaveBeenCalledWith("/clones/infra-live")
    fireEvent.click(screen.getByRole("button", { name: "Commit and push 2 files" }))

    const result = await screen.findByTestId("commit-push-result")
    expect(result).toHaveTextContent("Committed and pushed to runbook/1")
    expect(within(result).getByText("abc1234")).toBeInTheDocument()
    expect(pushCalls()).toEqual([
      [
        "git:push",
        {
          worktreePath: "/clones/infra-live",
          branchName: "runbook/1",
          commitMessage: "Update 2 files",
          paths: ["live/acme/terragrunt.hcl", "README.md"],
          provider: "github",
        },
      ],
    ])
    expect(invalidateGitFileTree).toHaveBeenCalled()
  })

  it("starts with only the selectedPaths chosen, and suggests a message for them", async () => {
    renderBlock({ pullRequestId: "pr", selectedPaths: ["live/acme"] })

    expect(await screen.findByText("1 of 2 changed files chosen")).toBeInTheDocument()
    expect(screen.getByLabelText("Choose live/acme/terragrunt.hcl")).toBeChecked()
    expect(screen.getByLabelText("Choose README.md")).not.toBeChecked()
    expect(screen.getByRole("textbox")).toHaveValue("Add live/acme/terragrunt.hcl")
  })

  it("follows the files the user chooses until the user edits the message", async () => {
    renderBlock({ pullRequestId: "pr" })
    await screen.findByText("2 of 2 changed files chosen")

    fireEvent.click(screen.getByLabelText("Choose README.md"))
    expect(screen.getByRole("textbox")).toHaveValue("Add live/acme/terragrunt.hcl")
    expect(screen.getByRole("button", { name: "Commit and push 1 file" })).toBeEnabled()

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Add the acme unit" } })
    fireEvent.click(screen.getByLabelText("Choose README.md"))
    expect(screen.getByRole("textbox")).toHaveValue("Add the acme unit")
  })

  it("chooses or drops a folder's files with its checkbox", async () => {
    renderBlock({ pullRequestId: "pr" })
    await screen.findByText("2 of 2 changed files chosen")

    fireEvent.click(screen.getByLabelText("Choose every file in live"))
    expect(screen.getByText("1 of 2 changed files chosen")).toBeInTheDocument()
    expect(screen.getByLabelText("Choose live/acme/terragrunt.hcl")).not.toBeChecked()
  })

  it("with no files chosen, pushes only the commits already made", async () => {
    pushResult = { ok: true, branch: "runbook/1", committed: false }
    renderBlock({ pullRequestId: "pr", selectedPaths: [] })

    fireEvent.click(await screen.findByRole("button", { name: "Push" }))

    expect(await screen.findByTestId("commit-push-result")).toHaveTextContent("Pushed to runbook/1")
    expect(pushCalls()[0]?.[1]).toMatchObject({ paths: [] })
  })

  it("with gitCloneId, pushes the branch that clone is on", async () => {
    pushResult = { ok: true, branch: "main", commitSha: "fedcba9", committed: true }
    renderBlock({ gitCloneId: "modules", commitMessage: "Bump modules" })

    fireEvent.click(await screen.findByRole("button", { name: "Commit and push 2 files" }))

    await screen.findByTestId("commit-push-result")
    expect(pushCalls()[0]?.[1]).toEqual({
      worktreePath: "/clones/infra-modules",
      commitMessage: "Bump modules",
      paths: ["live/acme/terragrunt.hcl", "README.md"],
      provider: "github",
    })
    expect(screen.queryByTestId("commit-push-pr")).not.toBeInTheDocument()
  })

  it("shows why a push failed", async () => {
    pushResult = { error: "The clone is on main, not runbook/1" }
    renderBlock({ pullRequestId: "pr" })

    fireEvent.click(await screen.findByRole("button", { name: "Commit and push 2 files" }))

    expect(await screen.findByText("Push failed")).toBeInTheDocument()
    expect(screen.getByText("The clone is on main, not runbook/1")).toBeInTheDocument()
  })

  it.each([
    [{ pullRequestId: "pr", gitCloneId: "live" }, /takes pullRequestId or gitCloneId, not both/],
    [{ pullRequestId: "live" }, /pullRequestId names "live", which isn't a pull request block/],
    [{ allowPullRequestMerge: true }, /allowPullRequestMerge needs pullRequestId/],
    [
      { pullRequestId: "pr", allowPullRequestMergeConditions: ["no-uncommitted-changes"] },
      /allowPullRequestMergeConditions needs allowPullRequestMerge/,
    ],
  ])("refuses %o", async (props, message) => {
    renderBlock(props)
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it("refuses allowPullRequestMerge for a GitLab merge request", async () => {
    renderBlock({ pullRequestId: "pr", allowPullRequestMerge: true }, [
      { id: "live", kind: "GitClone" },
      prBlock(PR_OUTPUTS, "gitlab"),
    ])
    expect(
      await screen.findByText(/allowPullRequestMerge works with GitHub only/),
    ).toBeInTheDocument()
  })

  it("keeps Merge disabled while files aren't committed, under no-uncommitted-changes", async () => {
    mergeStates = [{ state: "open", mergeability: "ready", headSha: "head1", method: "squash" }]
    renderBlock({
      pullRequestId: "pr",
      allowPullRequestMerge: true,
      allowPullRequestMergeConditions: ["no-uncommitted-changes"],
    })

    const pr = await screen.findByTestId("commit-push-pr")
    await waitFor(() =>
      expect(within(pr).getByRole("button", { name: /Squash and merge/ })).toBeDisabled(),
    )
    expect(within(pr).getByText(/2 files aren't committed yet/)).toBeInTheDocument()
  })

  it("takes no more pushes once the pull request is merged", async () => {
    mergeStates = [{ state: "merged", sha: "0123456789" }]
    renderBlock({ pullRequestId: "pr", allowPullRequestMerge: true })

    expect(
      await screen.findByText("The pull request is merged, so its branch takes no more pushes."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Commit and push 2 files" })).toBeDisabled()
  })
})
