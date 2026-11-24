/** GitPullRequest's agent adapter: fill in the form and create, through the block's own handler. */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"

const createPullRequest = vi.fn()
let hookState: Record<string, unknown> = {}
let workTree: unknown = null

vi.mock("../hooks/useGitPullRequest", () => ({
  useGitPullRequest: () => ({
    status: "ready",
    logs: [],
    prResult: null,
    prOutputs: null,
    errorMessage: null,
    errorCode: null,
    conflictBranchName: null,
    pushError: null,
    labels: [],
    labelsLoading: false,
    authMet: true,
    wrongProvider: false,
    createPullRequest,
    pushChanges: vi.fn(),
    deleteBranch: vi.fn(),
    fetchLabels: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    ...hookState,
  }),
}))
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    activeWorkTree: workTree,
    workTrees: [],
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
  }),
}))
vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({ changes: [], isLoading: false, error: null, refetch: vi.fn() }),
}))
vi.mock("../components/PRForm", () => ({ PRForm: () => <div>form</div> }))
vi.mock("../components/PRResult", () => ({ PRResultDisplay: () => <div>result</div> }))

import GitPullRequest from "../GitPullRequest"

const WORK_TREE = {
  id: "repo",
  repoUrl: "https://github.com/acme/live.git",
  localPath: "/work/live",
  gitInfo: {
    repoUrl: "https://github.com/acme/live.git",
    repoName: "live",
    repoOwner: "acme",
    ref: "main",
  },
}

beforeEach(() => {
  hookState = {}
  workTree = WORK_TREE
  createPullRequest.mockClear()
})

describe("GitPullRequest agent adapter", () => {
  it("creates the pull request with the fields it is given", async () => {
    const api = renderWithAgent(<GitPullRequest id="pr" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "pr" })
    expect(availableActions(detail)).toEqual(expect.arrayContaining(["set_fields", "create"]))
    expect(
      await askAgent(api, {
        op: "act_on_block",
        blockId: "pr",
        action: "create",
        params: {
          title: "Upgrade the landing zone",
          description: "Body",
          branch: "runbook/upgrade",
          commit_message: "Upgrade",
        },
      }),
    ).toMatchObject({ ok: true })
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "live",
        baseBranch: "main",
        headBranch: "runbook/upgrade",
        title: "Upgrade the landing zone",
        body: "Body",
        commitMessage: "Upgrade",
        worktreePath: "/work/live",
      }),
    )
  })

  it("can't create before a repository is cloned, and says so", async () => {
    workTree = null
    const api = renderWithAgent(<GitPullRequest id="pr" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "pr" })
    expect(detail.blockedBy.join()).toContain("No repository yet")
    expect(availableActions(detail)).not.toContain("create")
  })

  it("returns the pull request's URL once created", async () => {
    hookState = {
      status: "success",
      prResult: {
        prUrl: "https://github.com/acme/live/pull/7",
        prNumber: 7,
        branchName: "runbook/upgrade",
      },
    }
    const api = renderWithAgent(<GitPullRequest id="pr" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "pr" })
    expect(detail).toMatchObject({
      status: "success",
      state: { url: "https://github.com/acme/live/pull/7", number: 7 },
    })
    expect(availableActions(detail)).toEqual(expect.arrayContaining(["push", "create_another"]))
  })
})
