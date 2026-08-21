import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import GitClone from ".."

// The IPC boundary is the only thing mocked — the real useGitClone drives the
// block, so these tests cover the hook's preview/select logic too.
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

const REPO = {
  status: "success" as const,
  absolutePath: "/home/me/infra",
  relativePath: "/home/me/infra",
  fileCount: 42,
  remoteUrl: "https://github.com/acme/infra.git",
  ref: "main",
  refType: "branch" as const,
  commitSha: "abc123",
  outputs: { clone_path: "/home/me/infra", repo_owner: "acme", repo_name: "infra" },
}

/** Answer every channel the block calls on mount, plus git:local-repo. */
function mockIpc(localRepo: unknown = REPO) {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === "git:local-repo") return localRepo
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

// Matched by placeholder: the field's <label> also wraps an info-tooltip
// button, so a label-text query resolves to more than one element.
const repoDirInput = () => screen.getByPlaceholderText("/path/to/your/repo")

beforeEach(() => {
  invoke.mockReset()
  registerWorkTree.mockReset()
  mockIpc()
})

describe("GitClone — repository source picker", () => {
  it("offers both sources and starts on clone", () => {
    renderGitClone()
    expect(screen.getByRole("tab", { name: /Clone from remote/i })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /Use local checkout/i })).toHaveAttribute("aria-selected", "false")
    expect(screen.getByPlaceholderText("https://github.com/org/repo.git")).toBeInTheDocument()
  })

  it("switching to the local source swaps the clone form for a directory picker", async () => {
    const user = userEvent.setup()
    renderGitClone()

    await user.click(screen.getByRole("tab", { name: /Use local checkout/i }))

    expect(repoDirInput()).toBeInTheDocument()
    expect(screen.queryByPlaceholderText("https://github.com/org/repo.git")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Use This Repo/i })).toBeInTheDocument()
  })

  it("starts on the local source when a checkout directory is prefilled", () => {
    renderGitClone({ prefilledRepoDir: "/home/me/infra" })
    expect(screen.getByRole("tab", { name: /Use local checkout/i })).toHaveAttribute("aria-selected", "true")
    expect(repoDirInput()).toHaveValue("/home/me/infra")
  })

  it("hides the picker when the author locks the source", () => {
    renderGitClone({ source: "local", hideSourceSelect: true })
    expect(screen.queryByRole("tab", { name: /Use local checkout/i })).not.toBeInTheDocument()
    expect(repoDirInput()).toBeInTheDocument()
  })

  it("keeps the directory form usable while a linked auth block is pending", () => {
    renderGitClone({ source: "local", gitAuthId: "git-auth" })
    // Browsing and checking a directory needs no credentials...
    expect(repoDirInput()).not.toBeDisabled()
    expect(screen.getByRole("button", { name: /Browse/i })).not.toBeDisabled()
  })

  it("waits for a linked auth block before a checkout can be confirmed", async () => {
    renderGitClone({ source: "local", gitAuthId: "git-auth", prefilledRepoDir: "/home/me/infra" })

    // ...but confirming does wait, because the GitHub org/repo ids are resolved
    // from the session token at confirm time and can't be filled in later.
    expect(screen.getByText(/Waiting for git authentication/i)).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByText(/Git repository/i)).toBeInTheDocument(),
      { timeout: 2000 },
    )
    expect(screen.getByRole("button", { name: /Use This Repo/i })).toBeDisabled()
  })
})

describe("GitClone — local checkout", () => {
  it("previews the directory without registering it", async () => {
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })

    await waitFor(
      () => expect(screen.getByText(/Git repository/i)).toBeInTheDocument(),
      { timeout: 2000 },
    )

    expect(invoke).toHaveBeenCalledWith("git:local-repo", { path: "/home/me/infra" })
    expect(screen.getByText(/https:\/\/github.com\/acme\/infra.git/)).toBeInTheDocument()
    expect(screen.getByText(/42 tracked files/)).toBeInTheDocument()
  })

  it("keeps the confirm button disabled until the directory checks out", async () => {
    const user = userEvent.setup()
    renderGitClone({ source: "local" })

    const confirm = screen.getByRole("button", { name: /Use This Repo/i })
    expect(confirm).toBeDisabled()

    await user.type(repoDirInput(), "/home/me/infra")
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })
  })

  it("fills the path from the native folder picker", async () => {
    const user = userEvent.setup()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "native:show-open-dialog") return { filePaths: ["/home/me/infra"] }
      if (channel === "git:local-repo") return REPO
      return {}
    })
    renderGitClone({ source: "local" })

    await user.click(screen.getByRole("button", { name: /Browse/i }))

    await waitFor(() => expect(repoDirInput()).toHaveValue("/home/me/infra"))
    expect(invoke).toHaveBeenCalledWith("native:show-open-dialog", {
      properties: ["openDirectory"],
    })
  })

  it("leaves the path alone when the picker is dismissed", async () => {
    const user = userEvent.setup()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "native:show-open-dialog") return { filePaths: [] }
      if (channel === "git:local-repo") return REPO
      return {}
    })
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })

    await user.click(screen.getByRole("button", { name: /Browse/i }))

    expect(repoDirInput()).toHaveValue("/home/me/infra")
  })

  it("registers the checkout as a worktree and reports success", async () => {
    const user = userEvent.setup()
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })

    const confirm = screen.getByRole("button", { name: /Use This Repo/i })
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })
    await user.click(confirm)

    await waitFor(() => expect(screen.getByText(/Using local checkout/i)).toBeInTheDocument())

    expect(invoke).toHaveBeenCalledWith("git:local-repo", {
      path: "/home/me/infra",
      register: true,
    })
    expect(registerWorkTree).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-clone",
        localPath: "/home/me/infra",
        repoUrl: "https://github.com/acme/infra.git",
        gitInfo: expect.objectContaining({
          repoOwner: "acme",
          repoName: "infra",
          ref: "main",
          refType: "branch",
        }),
      }),
    )
    expect(screen.getByText(/42 tracked files/)).toBeInTheDocument()
  })

  it("explains why a directory can't be used and blocks the confirm", async () => {
    mockIpc({ status: "fail", error: "Not a git repository: /home/me/notes" })
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/notes" })

    await waitFor(
      () => expect(screen.getByText(/Can't use this directory/i)).toBeInTheDocument(),
      { timeout: 2000 },
    )
    expect(screen.getByText("Not a git repository: /home/me/notes")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Use This Repo/i })).toBeDisabled()
    expect(registerWorkTree).not.toHaveBeenCalled()
  })

  it("warns when the checkout has no remote to open pull requests against", async () => {
    mockIpc({ ...REPO, remoteUrl: undefined, outputs: { clone_path: "/home/me/infra" } })
    renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })

    await waitFor(
      () =>
        expect(
          screen.getByText(/remote — blocks that open a pull request need one/i),
        ).toBeInTheDocument(),
      { timeout: 2000 },
    )
  })
})
