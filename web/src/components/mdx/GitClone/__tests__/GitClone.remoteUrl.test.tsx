import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import GitClone from ".."

// Only the IPC boundary is mocked: the real block parses the remote and
// registers the worktree that <GitPullRequest> later reads owner/repo from.
const invoke = vi.fn()

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => ({ invoke, on: vi.fn(() => () => {}) }) }
})

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

function mockIpc(replies: Record<string, unknown>) {
  invoke.mockImplementation(async (channel: string) => {
    if (channel in replies) return replies[channel]
    if (channel === "session:get") return { workingDir: "/work" }
    if (channel === "github:orgs") return []
    return {}
  })
}

function renderGitClone(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitClone id="test-clone" {...props} />
    </TestWrapper>,
  )
}

// The clone path calls window.api directly, while the local path goes through
// useApi() — point both at the same spy so one mockImplementation covers both.
const originalApi = window.api

beforeEach(() => {
  invoke.mockReset()
  registerWorkTree.mockReset()
  window.api = {
    invoke,
    on: vi.fn(() => () => {}),
    once: vi.fn(),
  } as unknown as typeof window.api
})

afterEach(() => {
  window.api = originalApi
})

describe("GitClone — SSH remotes with a custom user", () => {
  it("registers owner and repo for a cloned remote", async () => {
    mockIpc({
      "git:clone": {
        status: "success",
        absolutePath: "/work/live",
        relativePath: "live",
        fileCount: 3,
        ref: "main",
        hasCommits: true,
        outputs: { clone_path: "/work/live", repo_owner: "platform/infra", repo_name: "live" },
      },
    })
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
    mockIpc({
      "git:local-repo": {
        status: "success",
        absolutePath: "/home/me/live",
        relativePath: "/home/me/live",
        fileCount: 3,
        remoteUrl: CUSTOM_USER_REMOTE,
        ref: "main",
        refType: "branch",
        hasCommits: true,
        outputs: { clone_path: "/home/me/live", repo_owner: "platform/infra", repo_name: "live" },
      },
    })
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
