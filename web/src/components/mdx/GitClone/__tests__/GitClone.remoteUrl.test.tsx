import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"
import { GitClone } from ".."

// Only the IPC boundary is faked (makeTestApi, through the real ApiProvider):
// the real block parses the remote and registers the worktree that
// <GitPullRequest> later reads owner/repo from.
let testApi: TestApi

const SESSION: Result<"session:get"> = {
  workingDir: "/work",
  executionCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivity: "2024-01-01T00:00:00Z",
}

const registerWorkTree = vi.fn()
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree,
    activeWorkTree: null,
    workTrees: [],
    setActiveWorkTree: vi.fn(),
    resetWorkTrees: vi.fn(),
    invalidateGitFileTree: vi.fn(),
    treeVersion: 0,
    activeWorkTreeId: null,
  }),
}))

/** A self-managed GitLab whose SSH server runs as `gitlab`, not `git`. */
const CUSTOM_USER_REMOTE = "gitlab@gitlab.corp.net:platform/infra/live.git"

function renderGitClone(props: Record<string, unknown> = {}) {
  return render(
    <ApiProvider api={testApi.api}>
      <TestWrapper>
        <GitClone id="test-clone" {...props} />
      </TestWrapper>
    </ApiProvider>,
  )
}

beforeEach(() => {
  registerWorkTree.mockReset()
  testApi = makeTestApi({
    "session:get": () => SESSION,
    "github:orgs": () => [],
    "native:set-theme": () => ({ ok: true }),
  })
})

describe("GitClone — SSH remotes with a custom user", () => {
  it("registers owner and repo for a cloned remote", async () => {
    testApi.handle("git:clone", () => ({
      status: "success",
      absolutePath: "/work/live",
      relativePath: "live",
      fileCount: 3,
      ref: "main",
      hasCommits: true,
      outputs: { clone_path: "/work/live", repo_owner: "platform/infra", repo_name: "live" },
    }))
    renderGitClone({ prefilledUrl: CUSTOM_USER_REMOTE })

    const user = userEvent.setup()
    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })
    await user.click(clone)

    await waitFor(() =>
      expect(registerWorkTree).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: CUSTOM_USER_REMOTE,
          gitInfo: expect.objectContaining({ repoOwner: "platform/infra", repoName: "live" }),
        }),
      ),
    )
  })

  it("registers owner and repo for a local checkout's remote", async () => {
    testApi.handle("git:local-repo", () => ({
      status: "success",
      absolutePath: "/home/me/live",
      relativePath: "/home/me/live",
      fileCount: 3,
      remoteUrl: CUSTOM_USER_REMOTE,
      ref: "main",
      refType: "branch",
      hasCommits: true,
      outputs: { clone_path: "/home/me/live", repo_owner: "platform/infra", repo_name: "live" },
    }))
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/live" })

    const user = userEvent.setup()
    const confirm = screen.getByRole("button", { name: /Use This Repo/i })
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })
    await user.click(confirm)

    await waitFor(() =>
      expect(registerWorkTree).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: CUSTOM_USER_REMOTE,
          gitInfo: expect.objectContaining({ repoOwner: "platform/infra", repoName: "live" }),
        }),
      ),
    )
  })
})
