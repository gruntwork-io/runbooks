import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"
import { GitClone } from ".."

// A GitClone block under the real session history provider. The mock
// boundary is the preload API (git:*, and session:record-event, where an
// event leaves the renderer) and the worktree context.
// One API object for every render, as ApiProvider gives: the restore check
// runs in an effect that depends on it.
const api = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }))
const invoke = api.invoke

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => api }
})

const registerWorkTree = vi.fn()
const unregisterWorkTree = vi.fn()
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree,
    unregisterWorkTree,
    activeWorkTree: null,
    workTrees: [],
    setActiveWorkTree: vi.fn(),
    resetWorkTrees: vi.fn(),
    invalidateGitFileTree: vi.fn(),
    treeVersion: 0,
    activeWorkTreeId: null,
  }),
}))

const URL = "https://github.com/acme/infra.git"
const OUTPUTS = { clone_path: "/work/infra", repo_owner: "acme", repo_name: "infra" }

/** What git:clone answers for URL. */
const CLONED = {
  status: "success" as const,
  absolutePath: "/work/infra",
  relativePath: "infra",
  fileCount: 12,
  ref: "main",
  hasCommits: true,
  outputs: OUTPUTS,
}

/** What git:local-repo answers for a checkout the user already has. */
const CHECKOUT = {
  status: "success" as const,
  absolutePath: "/home/me/infra",
  relativePath: "/home/me/infra",
  fileCount: 42,
  remoteUrl: URL,
  ref: "main",
  refType: "branch" as const,
  commitSha: "abc123",
  hasCommits: true,
  outputs: { clone_path: "/home/me/infra", repo_owner: "acme", repo_name: "infra" },
}

/** A `clone` event for a repository cloned from URL. */
const SAVED_CLONE = {
  status: "ready",
  source: "clone",
  form: { gitUrl: URL, ref: "", repoPath: "", localPath: "", repoDir: "" },
  result: {
    fileCount: 12,
    absolutePath: "/work/infra",
    relativePath: "infra",
    ref: "main",
    hasCommits: true,
  },
  localInfo: null,
  outputs: OUTPUTS,
}

/** Answer every channel the block calls; `localRepo` is git:local-repo's answer. */
function mockIpc(localRepo: () => Promise<unknown> = async () => CHECKOUT) {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === "git:local-repo") return localRepo()
    if (channel === "git:clone") return CLONED
    if (channel === "session:get") return { workingDir: "/work" }
    if (channel === "github:orgs") return []
    return { ok: true }
  })
}

/** The payload of each `clone` event sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .map((call) => call as unknown as [string, { blockId: string; kind: string; payload: unknown }])
    .filter(([channel, event]) => channel === "session:record-event" && event.kind === "clone")
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "test-clone" })
      return event.payload
    })

/** The git:local-repo calls, by their parameters. */
const localRepoCalls = () =>
  invoke.mock.calls.filter(([channel]) => channel === "git:local-repo").map(([, params]) => params)

/** Reads the outputs the block published. */
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

/** A session whose history says the GitClone block was left as `saved`. */
function Session({ saved, children }: { saved?: unknown; children: ReactNode }) {
  const blockStates: SavedBlockState[] =
    saved === undefined ? [] : [{ blockId: "test-clone", kind: "clone", payload: saved }]
  return (
    <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
      <TestWrapper>
        {children}
        <OutputsProbe />
      </TestWrapper>
    </IpcSessionHistoryProvider>
  )
}

function renderGitClone(saved?: unknown, props: Record<string, unknown> = {}) {
  return render(
    <Session saved={saved}>
      <GitClone id="test-clone" {...props} />
    </Session>,
  )
}

/** Let the restore check's git:local-repo call settle. */
const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      }),
  )

beforeEach(() => {
  invoke.mockReset()
  registerWorkTree.mockReset()
  unregisterWorkTree.mockReset()
  mockIpc()
})

describe("GitClone in a session", () => {
  it("starts from the repository it had, published and in the workspace, and records nothing", async () => {
    renderGitClone(SAVED_CLONE)

    expect(screen.getByText("Clone complete")).toBeInTheDocument()
    await waitFor(() => expect(publishedOutputs()).toEqual(OUTPUTS))
    await waitFor(() =>
      expect(registerWorkTree).toHaveBeenCalledWith(
        expect.objectContaining({ id: "test-clone", localPath: "/work/infra", repoUrl: URL }),
      ),
    )
    // The check only inspects the directory: it registers nothing.
    await waitFor(() => expect(localRepoCalls()).toEqual([{ path: "/work/infra" }]))
    await settle()

    expect(screen.getByText("Clone complete")).toBeInTheDocument()
    expect(recorded()).toEqual([])
  })

  it("starts over, and says why, when the repository is no longer on disk", async () => {
    mockIpc(async () => ({ status: "fail", error: "no such directory" }))

    renderGitClone(SAVED_CLONE)

    expect(await screen.findByText("This block's repository is gone")).toBeInTheDocument()
    expect(
      screen.getByText(/The repository at \/work\/infra is gone: no such directory/),
    ).toBeInTheDocument()
    expect(screen.queryByText("Clone complete")).not.toBeInTheDocument()
    expect(publishedOutputs()).toEqual({})
    expect(unregisterWorkTree).toHaveBeenCalledWith("test-clone")
    // The form comes back filled in as it was for that repository.
    expect(screen.getByPlaceholderText("https://github.com/org/repo.git")).toHaveValue(URL)
  })

  it("keeps the repository when the check itself fails", async () => {
    mockIpc(async () => {
      throw new Error("IPC channel closed")
    })

    renderGitClone(SAVED_CLONE)
    await waitFor(() => expect(localRepoCalls()).toHaveLength(1))
    await settle()

    expect(screen.getByText("Clone complete")).toBeInTheDocument()
    expect(publishedOutputs()).toEqual(OUTPUTS)
    expect(unregisterWorkTree).not.toHaveBeenCalled()
  })

  it("starts over when the history says the user gave the repository up", async () => {
    renderGitClone({ status: "none" }, { prefilledUrl: URL })
    await settle()

    expect(screen.queryByText("Clone complete")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Clone$/i })).toBeInTheDocument()
    expect(screen.queryByText("This block's repository is gone")).not.toBeInTheDocument()
    expect(localRepoCalls()).toEqual([])
    expect(publishedOutputs()).toEqual({})
  })

  it("says the repository is no longer a git repository when the check gives no reason", async () => {
    mockIpc(async () => ({ status: "fail" }))

    renderGitClone(SAVED_CLONE)

    expect(
      await screen.findByText(
        /The repository at \/work\/infra is gone: it is no longer a git repository/,
      ),
    ).toBeInTheDocument()
  })

  it("ignores a check that comes back after Clone again", async () => {
    const user = userEvent.setup()
    let answerCheck!: (answer: unknown) => void
    mockIpc(
      () =>
        new Promise((resolve) => {
          answerCheck = resolve
        }),
    )
    renderGitClone(SAVED_CLONE)
    await waitFor(() => expect(localRepoCalls()).toHaveLength(1))

    await user.click(screen.getByRole("button", { name: /Clone again/i }))
    await user.click(screen.getByRole("button", { name: /^Clone$/i }))
    await screen.findByText("Clone complete")
    await act(async () => answerCheck({ status: "fail", error: "no such directory" }))

    expect(screen.getByText("Clone complete")).toBeInTheDocument()
    expect(screen.queryByText("This block's repository is gone")).not.toBeInTheDocument()
    expect(publishedOutputs()).toEqual(OUTPUTS)
    expect(unregisterWorkTree).toHaveBeenCalledTimes(1)
  })

  it("records an empty repository only once it has a default branch, on that branch", async () => {
    const user = userEvent.setup()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "git:clone") return { ...CLONED, hasCommits: false, ref: undefined }
      if (channel === "git:init-default-branch") return { branch: "trunk" }
      if (channel === "session:get") return { workingDir: "/work" }
      if (channel === "github:orgs") return []
      return { ok: true }
    })
    renderGitClone(undefined, { prefilledUrl: URL })
    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })

    await user.click(clone)
    await screen.findByText("This repository has no commits yet")
    await settle()
    // Its outputs are held back, and so is its place in the history.
    expect(recorded()).toEqual([])

    await user.clear(screen.getByLabelText("Default branch name"))
    await user.type(screen.getByLabelText("Default branch name"), "trunk")
    await user.click(screen.getByRole("button", { name: "Create default branch" }))

    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toEqual({
      ...SAVED_CLONE,
      result: { ...SAVED_CLONE.result, ref: "trunk", hasCommits: true },
    })
  })

  it("records a clone made after a local checkout without the checkout's details", async () => {
    const user = userEvent.setup()
    renderGitClone(undefined, {
      source: "local",
      prefilledRepoDir: "/home/me/infra",
      prefilledUrl: URL,
    })
    const confirm = screen.getByRole("button", { name: /Use This Repo/i })
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })
    await user.click(confirm)
    await screen.findByText("Using local checkout")
    await user.click(screen.getByRole("button", { name: /Stop using this repo/i }))

    await user.click(screen.getByRole("tab", { name: "Clone from remote" }))
    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })
    await user.click(clone)
    await screen.findByText("Clone complete")

    await waitFor(() => expect(recorded()).toHaveLength(3))
    expect(recorded()[2]).toMatchObject({ status: "ready", source: "clone", localInfo: null })
  })

  it("records a clone with the form, the result and the outputs, and Clone again as none", async () => {
    const user = userEvent.setup()
    renderGitClone(undefined, { prefilledUrl: URL })
    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })

    await user.click(clone)
    await screen.findByText("Clone complete")

    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toEqual(SAVED_CLONE)

    await user.click(screen.getByRole("button", { name: /Clone again/i }))

    await waitFor(() => expect(recorded()).toHaveLength(2))
    expect(recorded()[1]).toEqual({ status: "none" })
  })

  it("records a local checkout with what git:local-repo reported, and Stop using this repo as none", async () => {
    const user = userEvent.setup()
    renderGitClone(undefined, { source: "local", prefilledRepoDir: "/home/me/infra" })
    const confirm = screen.getByRole("button", { name: /Use This Repo/i })
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })

    await user.click(confirm)
    await screen.findByText("Using local checkout")

    await waitFor(() => expect(recorded()).toHaveLength(1))
    expect(recorded()[0]).toEqual({
      status: "ready",
      source: "local",
      form: { gitUrl: "", ref: "", repoPath: "", localPath: "", repoDir: "/home/me/infra" },
      result: {
        fileCount: 42,
        absolutePath: "/home/me/infra",
        relativePath: "/home/me/infra",
        ref: "main",
        hasCommits: true,
      },
      // Only the fields the history keeps: not the status or the outputs again.
      localInfo: {
        absolutePath: "/home/me/infra",
        relativePath: "/home/me/infra",
        fileCount: 42,
        remoteUrl: URL,
        ref: "main",
        refType: "branch",
        commitSha: "abc123",
        hasCommits: true,
      },
      outputs: CHECKOUT.outputs,
    })

    await user.click(screen.getByRole("button", { name: /Stop using this repo/i }))

    await waitFor(() => expect(recorded()).toHaveLength(2))
    expect(recorded()[1]).toEqual({ status: "none" })
  })

  it("starts a restored local checkout on the local source, with its remote shown", async () => {
    renderGitClone({
      ...SAVED_CLONE,
      source: "local",
      form: { gitUrl: "", ref: "", repoPath: "", localPath: "", repoDir: "/home/me/infra" },
      result: { fileCount: 42, absolutePath: "/home/me/infra", relativePath: "/home/me/infra" },
      localInfo: {
        absolutePath: "/home/me/infra",
        relativePath: "/home/me/infra",
        fileCount: 42,
        remoteUrl: URL,
        ref: "main",
        refType: "branch",
        commitSha: "abc123",
        hasCommits: true,
      },
      outputs: CHECKOUT.outputs,
    })

    expect(screen.getByText("Using local checkout")).toBeInTheDocument()
    expect(screen.getByText(URL)).toBeInTheDocument()
    await waitFor(() =>
      expect(registerWorkTree).toHaveBeenCalledWith(
        expect.objectContaining({ id: "test-clone", localPath: "/home/me/infra" }),
      ),
    )
    await settle()
    expect(recorded()).toEqual([])
  })
})
