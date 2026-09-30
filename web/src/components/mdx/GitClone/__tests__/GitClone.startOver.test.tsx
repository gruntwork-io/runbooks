import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"
import GitClone from ".."

// Only the IPC boundary and the worktree context are mocked, so the real
// useGitClone drives the block: these tests cover what starting over withdraws
// as well as where the action is shown.
const invoke = vi.fn()

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => ({ invoke, on: vi.fn(() => () => {}) }) }
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

const REPO = {
  status: "success" as const,
  absolutePath: "/home/me/infra",
  relativePath: "/home/me/infra",
  fileCount: 42,
  remoteUrl: "https://github.com/acme/infra.git",
  ref: "main",
  refType: "branch" as const,
  commitSha: "abc123",
  hasCommits: true,
  outputs: { clone_path: "/home/me/infra", repo_owner: "acme", repo_name: "infra" },
}

/** Reads the outputs the block published, so withdrawing them can be asserted directly. */
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

/** Answer every channel the block calls, for both sources. */
function mockIpc() {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === "git:local-repo") return REPO
    if (channel === "git:clone") {
      return { ...REPO, absolutePath: "/work/infra", relativePath: "infra", fileCount: 12 }
    }
    if (channel === "session:get") return { workingDir: "/work" }
    if (channel === "github:orgs") return []
    return {}
  })
}

// Matched by placeholder: the field's <label> also wraps an info-tooltip
// button, so a label-text query resolves to more than one element.
const repoDirInput = () => screen.getByPlaceholderText("/path/to/your/repo")

/** The result panel's header row: the heading and the actions beside it. */
const headerRowOf = (heading: string) => screen.getByText(heading).parentElement!

async function startUsingLocalCheckout() {
  const user = userEvent.setup()
  renderGitClone({ source: "local", prefilledRepoDir: "/home/me/infra" })
  const confirm = screen.getByRole("button", { name: /Use This Repo/i })
  await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })
  await user.click(confirm)
  await screen.findByText("Using local checkout")
  return user
}

beforeEach(() => {
  invoke.mockReset()
  registerWorkTree.mockReset()
  unregisterWorkTree.mockReset()
  mockIpc()
})

describe("GitClone — stopping use of a local checkout", () => {
  it("offers Stop using this repo in the result panel once a checkout is in use", async () => {
    await startUsingLocalCheckout()

    // The action sits on the status line the user reads, not in a separate
    // control below the panel, and says what it does: undo the choice.
    expect(
      within(headerRowOf("Using local checkout")).getByRole("button", { name: /Stop using this repo/i }),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Choose a different repo/i })).not.toBeInTheDocument()
  })

  it("withdraws the checkout and returns to the directory form", async () => {
    const user = await startUsingLocalCheckout()
    await waitFor(() => expect(registerWorkTree).toHaveBeenCalledTimes(1))
    expect(publishedOutputs()).toEqual(REPO.outputs)

    await user.click(screen.getByRole("button", { name: /Stop using this repo/i }))

    // Nothing of the checkout stays live for later blocks...
    expect(publishedOutputs()).toEqual({})
    expect(unregisterWorkTree).toHaveBeenCalledWith("test-clone")
    expect(screen.queryByText("Using local checkout")).not.toBeInTheDocument()

    // ...and the block is back on its form, with the same directory ready to
    // be used again or changed.
    expect(repoDirInput()).toHaveValue("/home/me/infra")
    await waitFor(() => expect(screen.getByText(/Not in use yet/i)).toBeInTheDocument(), {
      timeout: 2000,
    })
    const confirm = screen.getByRole("button", { name: /Use This Repo/i })
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 })

    // Using it again is a fresh confirmation: the worktree and outputs return.
    await user.click(confirm)
    await screen.findByText("Using local checkout")
    await waitFor(() => expect(registerWorkTree).toHaveBeenCalledTimes(2))
    expect(publishedOutputs()).toEqual(REPO.outputs)
  })
})

describe("GitClone — starting over after a clone", () => {
  it("shows Clone again beside Clone complete without changing the heading text", async () => {
    const user = userEvent.setup()
    renderGitClone({ prefilledUrl: "https://github.com/acme/infra.git" })
    const clone = screen.getByRole("button", { name: /^Clone$/i })
    await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })
    await user.click(clone)

    const heading = await screen.findByText("Clone complete")
    expect(
      within(headerRowOf("Clone complete")).getByRole("button", { name: /Clone again/i }),
    ).toBeInTheDocument()
    // The e2e specs wait on getByText("Clone complete", { exact: true }), which
    // compares an element's whole text: the button must not sit inside it.
    expect(heading).toHaveTextContent(/^Clone complete$/)
  })
})
