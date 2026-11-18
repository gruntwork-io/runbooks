import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"
import type { PathRoots } from "@/lib/displayPath"
import { ShortenedPaths } from "@/test/ShortenedPaths"
import { GitClone } from ".."

// Only the IPC boundary is faked (makeTestApi, through the real ApiProvider):
// the real block and useGitClone build the destination preview from the
// session's working directory.
let testApi: TestApi

const SESSION: Result<"session:get"> = {
  workingDir: "/work",
  executionCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivity: "2024-01-01T00:00:00Z",
}

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
    activeWorkTree: null,
    workTrees: [],
    setActiveWorkTree: vi.fn(),
    resetWorkTrees: vi.fn(),
    invalidateGitFileTree: vi.fn(),
    treeVersion: 0,
    activeWorkTreeId: null,
  }),
}))

const REPO_URL = "https://github.com/acme/infra.git"

/** Answer every channel the block calls; tests override one with testApi.handle. */
function mockIpc() {
  testApi = makeTestApi({
    "session:get": () => SESSION,
    "github:orgs": () => [],
    "native:set-theme": () => ({ ok: true }),
  })
}

/** The session's directory is where its scripts start, so it is the working directory here. */
const ROOTS: PathRoots = { sessionDir: "/work", homeDir: "/home/me" }

function renderGitClone(props: Record<string, unknown> = {}, roots: PathRoots = ROOTS) {
  return render(
    <ApiProvider api={testApi.api}>
      <TestWrapper>
        <ShortenedPaths roots={roots}>
          <GitClone id="test-clone" {...props} />
        </ShortenedPaths>
      </TestWrapper>
    </ApiProvider>,
  )
}

async function clickClone(user: ReturnType<typeof userEvent.setup>) {
  const clone = screen.getByRole("button", { name: /^Clone$/i })
  await waitFor(() => expect(clone).toBeEnabled(), { timeout: 2000 })
  await user.click(clone)
}

beforeEach(() => {
  mockIpc()
})

describe("GitClone — Local Path preview", () => {
  it("shows the destination shortened and copies it in full", async () => {
    const user = userEvent.setup()
    // A prefilled local path opens Additional Settings.
    renderGitClone({ prefilledUrl: REPO_URL, prefilledLocalPath: "infra-live" })

    const preview = await screen.findByText("session/infra-live")
    expect(preview).toHaveAttribute("title", "/work/infra-live")
    expect(screen.queryByText("/work/infra-live")).not.toBeInTheDocument()
    expect(screen.queryByText(/Relative:|Absolute:/)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Copy full path/i }))

    expect(await navigator.clipboard.readText()).toBe("/work/infra-live")
  })

  it("shortens an absolute Local Path in the session's directory", async () => {
    const user = userEvent.setup()
    renderGitClone({ prefilledUrl: REPO_URL, prefilledLocalPath: "/work/nested/infra" })

    expect(await screen.findByText("session/nested/infra")).toHaveAttribute(
      "title",
      "/work/nested/infra",
    )
    expect(screen.queryByText("/work/nested/infra")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Copy full path/i }))

    expect(await navigator.clipboard.readText()).toBe("/work/nested/infra")
  })

  it("does not treat a sibling that shares the working directory's prefix as inside it", async () => {
    renderGitClone({ prefilledUrl: REPO_URL, prefilledLocalPath: "/workshop/infra" })

    expect(await screen.findByText("/workshop/infra")).toHaveAttribute("title", "/workshop/infra")
  })

  it("shortens a Local Path elsewhere in the home directory to ~", async () => {
    renderGitClone({ prefilledUrl: REPO_URL, prefilledLocalPath: "/home/me/dev/infra" })

    expect(await screen.findByText("~/dev/infra")).toHaveAttribute("title", "/home/me/dev/infra")
  })

  it("recognises a Windows absolute Local Path", async () => {
    testApi.handle("session:get", () => ({ ...SESSION, workingDir: "C:\\work" }))
    const user = userEvent.setup()
    renderGitClone(
      { prefilledUrl: REPO_URL, prefilledLocalPath: "C:\\work\\infra" },
      { sessionDir: "C:\\work" },
    )

    expect(await screen.findByText("session\\infra")).toHaveAttribute("title", "C:\\work\\infra")

    await user.click(screen.getByRole("button", { name: /Copy full path/i }))

    expect(await navigator.clipboard.readText()).toBe("C:\\work\\infra")
  })
})

describe("GitClone — completed clone", () => {
  it("shows the path shortened and copies it in full", async () => {
    testApi.handle("git:clone", () => ({
      status: "success",
      relativePath: "live",
      absolutePath: "/work/live",
      fileCount: 3,
      ref: "main",
      hasCommits: true,
      outputs: { clone_path: "/work/live" },
    }))
    const user = userEvent.setup()
    renderGitClone({ prefilledUrl: REPO_URL })

    await clickClone(user)
    await screen.findByText("Clone complete")

    expect(screen.getByText("session/live")).toHaveAttribute("title", "/work/live")
    expect(screen.queryByText("/work/live")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Copy full path/i }))

    expect(await navigator.clipboard.readText()).toBe("/work/live")
  })
})

describe("GitClone — overwrite confirmation", () => {
  it("carries the full path on the shortened one, not in a pointer to Additional Settings", async () => {
    // What main's git:clone handler returns for an existing destination.
    testApi.handle("git:clone", () => ({ error: "directory_exists" }))
    const user = userEvent.setup()
    renderGitClone({ prefilledUrl: REPO_URL, prefilledLocalPath: "infra-live" })

    await clickClone(user)

    const heading = await screen.findByText("Local path already exists")
    const warning = heading.parentElement as HTMLElement
    expect(within(warning).getByText("session/infra-live")).toHaveAttribute(
      "title",
      "/work/infra-live",
    )
    expect(warning).not.toHaveTextContent(/Additional Settings/i)
  })
})
