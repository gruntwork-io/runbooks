import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import GitClone from ".."

// Only the IPC boundary is mocked, so the real useGitClone drives the block and
// these tests cover its gating of outputs as well as the rendered warning.
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

const OUTPUTS = { clone_path: "/home/me/infra", repo_owner: "acme", repo_name: "infra" }

/** A checkout of a repo that was created but never pushed to. */
const EMPTY_REPO = {
  status: "success" as const,
  absolutePath: "/home/me/infra",
  relativePath: "/home/me/infra",
  fileCount: 0,
  remoteUrl: "https://github.com/acme/infra.git",
  // An unborn HEAD names no ref, which is exactly why the base branch can't be
  // inferred from it.
  ref: "",
  refType: "branch" as const,
  hasCommits: false,
  outputs: OUTPUTS,
}

/** Reads the outputs the block published, so the gate can be asserted directly. */
function OutputsProbe() {
  const { blockOutputs } = useRunbookContext()
  return (
    <div data-testid="published-outputs">
      {JSON.stringify(blockOutputs["test_clone"]?.values ?? {})}
    </div>
  )
}

const publishedOutputs = () =>
  JSON.parse(screen.getByTestId("published-outputs").textContent || "{}")

function renderGitClone(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitClone id="test-clone" {...props} />
      <OutputsProbe />
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

describe("GitClone — a repository with no commits", () => {
  /** Answer every channel the block calls, with a configurable local-repo reply. */
  function mockIpc(localRepo: unknown = EMPTY_REPO) {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "git:local-repo") return localRepo
      if (channel === "session:get") return { workingDir: "/work" }
      if (channel === "github:orgs") return []
      if (channel === "git:init-default-branch") return { branch: "main" }
      return {}
    })
  }

  async function confirmLocalCheckout() {
    const user = userEvent.setup()
    const confirm = screen.getByRole("button", { name: /Use This Repo/i })
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })
    await user.click(confirm)
    return user
  }

  it("says the repo has no commits instead of reporting a clean success", async () => {
    mockIpc()
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })
    await confirmLocalCheckout()

    await waitFor(() =>
      expect(screen.getByText(/This repository has no commits yet/i)).toBeInTheDocument(),
    )
    expect(
      screen.getByRole("button", { name: /Create default branch/i }),
    ).toBeInTheDocument()
  })

  it("withholds its outputs and worktree so downstream blocks can't start", async () => {
    mockIpc()
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })
    await confirmLocalCheckout()

    await waitFor(() =>
      expect(screen.getByText(/This repository has no commits yet/i)).toBeInTheDocument(),
    )
    // Both gates downstream blocks depend on stay shut: clone_path drives
    // template references and DirPicker, the worktree drives <GitPullRequest>.
    expect(publishedOutputs()).toEqual({})
    expect(registerWorkTree).not.toHaveBeenCalled()
  })

  it("seeds the default branch, then releases the outputs and the worktree", async () => {
    mockIpc()
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })
    const user = await confirmLocalCheckout()

    const seed = await screen.findByRole("button", { name: /Create default branch/i })
    await user.click(seed)

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("git:init-default-branch", {
        worktreePath: "/home/me/infra",
        branch: "main",
      }),
    )

    // The seeded branch is the repo's only ref, so it becomes the PR base.
    await waitFor(() =>
      expect(registerWorkTree).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test-clone",
          localPath: "/home/me/infra",
          gitInfo: expect.objectContaining({ ref: "main", repoOwner: "acme" }),
        }),
      ),
    )
    expect(publishedOutputs()).toEqual(OUTPUTS)
    expect(screen.queryByText(/This repository has no commits yet/i)).not.toBeInTheDocument()
  })

  it("keeps the warning up and reports why when seeding fails", async () => {
    mockIpc()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "git:local-repo") return EMPTY_REPO
      if (channel === "session:get") return { workingDir: "/work" }
      if (channel === "github:orgs") return []
      if (channel === "git:init-default-branch") return { error: "Permission denied" }
      return {}
    })
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })
    const user = await confirmLocalCheckout()

    const seed = await screen.findByRole("button", { name: /Create default branch/i })
    await user.click(seed)

    await waitFor(() => expect(screen.getByText("Permission denied")).toBeInTheDocument())
    expect(screen.getByText(/This repository has no commits yet/i)).toBeInTheDocument()
    expect(publishedOutputs()).toEqual({})
    expect(registerWorkTree).not.toHaveBeenCalled()
  })

  it("seeds the branch the remote advertises rather than assuming main", async () => {
    mockIpc({ ...EMPTY_REPO, ref: "master" })
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })
    const user = await confirmLocalCheckout()

    const seed = await screen.findByRole("button", { name: /Create default branch/i })
    // The name is pre-filled from the repo's own default, and stays editable.
    expect(screen.getByDisplayValue("master")).toBeInTheDocument()
    await user.click(seed)

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "git:init-default-branch",
        expect.objectContaining({ branch: "master" }),
      ),
    )
  })

  it("leaves a repo that has commits completely alone", async () => {
    mockIpc({
      ...EMPTY_REPO,
      fileCount: 42,
      ref: "main",
      commitSha: "abc123",
      hasCommits: true,
    })
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })
    await confirmLocalCheckout()

    await waitFor(() => expect(registerWorkTree).toHaveBeenCalled())
    expect(publishedOutputs()).toEqual(OUTPUTS)
    expect(screen.queryByText(/This repository has no commits yet/i)).not.toBeInTheDocument()
  })
})

describe("GitClone — the base branch a clone records", () => {
  function mockCloneIpc(clone: unknown) {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "git:clone") return clone
      if (channel === "session:get") return { workingDir: "/work" }
      if (channel === "github:orgs") return []
      return {}
    })
  }

  async function runClone() {
    const user = userEvent.setup()
    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })
    await user.click(clone)
    return user
  }

  it("records the ref the clone actually landed on, not a guessed 'main'", async () => {
    // No ref was requested, so the clone followed the remote's default branch —
    // which is 'master' here. Assuming 'main' is what made pull requests against
    // such a repo fail with an invalid base branch.
    mockCloneIpc({
      status: "success",
      absolutePath: "/work/infra",
      relativePath: "infra",
      fileCount: 12,
      ref: "master",
      hasCommits: true,
      outputs: OUTPUTS,
    })
    renderGitClone({ prefilledUrl: "https://github.com/acme/infra.git" })
    await runClone()

    await waitFor(() =>
      expect(registerWorkTree).toHaveBeenCalledWith(
        expect.objectContaining({
          gitInfo: expect.objectContaining({ ref: "master" }),
        }),
      ),
    )
  })

  it("warns and holds downstream work when the cloned repo is empty", async () => {
    mockCloneIpc({
      status: "success",
      absolutePath: "/work/infra",
      relativePath: "infra",
      fileCount: 0,
      ref: "main",
      hasCommits: false,
      outputs: OUTPUTS,
    })
    renderGitClone({ prefilledUrl: "https://github.com/acme/infra.git" })
    await runClone()

    await waitFor(() =>
      expect(screen.getByText(/This repository has no commits yet/i)).toBeInTheDocument(),
    )
    expect(publishedOutputs()).toEqual({})
    expect(registerWorkTree).not.toHaveBeenCalled()
  })
})
