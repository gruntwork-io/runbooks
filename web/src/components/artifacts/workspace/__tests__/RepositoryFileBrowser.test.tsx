import type { ReactElement } from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiProvider } from "@/contexts/ApiContext"
import type { WorkspaceFileChange } from "@/hooks/useGitFileChanges"
import type { WorkspaceTreeNode } from "@/hooks/useGitFileTree"
import { RepositoryFileBrowser } from "../RepositoryFileBrowser"

// The change poller is driven by hand: each test sets `poll.changes` and
// re-renders, as a poll that returned a different response would. The real
// useFileContent runs against a fake disk behind the workspace:file IPC.
const poll = vi.hoisted(() => ({ changes: [] as WorkspaceFileChange[] }))

vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({
    changes: poll.changes,
    totalChanges: poll.changes.length,
    tooManyChanges: false,
    isLoading: false,
    fetchFileDiff: vi.fn(),
  }),
}))

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    activeWorkTree: { id: "clone", repoUrl: "", localPath: "/repo", gitInfo: {} },
    treeVersion: 0,
  }),
}))

const TREE: WorkspaceTreeNode[] = [
  { id: "main.tf", name: "main.tf", type: "file", language: "text" },
  { id: "other.tf", name: "other.tf", type: "file", language: "text" },
  // Tree ids come from Node's path.join, so they use '\' on Windows.
  {
    id: "modules",
    name: "modules",
    type: "folder",
    children: [{ id: "modules\\vpc.tf", name: "vpc.tf", type: "file", language: "text" }],
  },
]

let disk: Record<string, string>
const invoke = vi.fn(async (channel: string, args: { filePath: string }) => {
  if (channel !== "workspace:file") throw new Error(`unexpected channel ${channel}`)
  const content = disk[args.filePath]
  return { path: args.filePath, content, language: "text", size: content.length }
})
const api = { invoke, on: vi.fn(() => () => {}), once: vi.fn() } as unknown as typeof window.api

const originalApi = window.api
beforeEach(() => {
  invoke.mockClear()
  poll.changes = []
  disk = { "/repo/main.tf": "v0", "/repo/other.tf": "o0", "/repo/modules\\vpc.tf": "cidr" }
  window.api = api
})
afterEach(() => {
  window.api = originalApi
})

const modified = (path: string, newContent: string): WorkspaceFileChange => ({
  path,
  changeType: "modified",
  additions: 1,
  deletions: 1,
  newContent,
  language: "text",
})

const ui = () => (
  <ApiProvider api={api}>
    <RepositoryFileBrowser tree={TREE} isLoading={false} error={null} onRetry={() => {}} />
  </ApiProvider>
)

/** Writes `files` to the fake disk and delivers a poll whose response differs. */
function editOnDisk(rerender: (ui: ReactElement) => void, files: Record<string, string>, changes: WorkspaceFileChange[]) {
  Object.assign(disk, files)
  poll.changes = changes
  act(() => rerender(ui()))
}

const fileFetches = (path: string) =>
  invoke.mock.calls.filter(([channel, args]) => channel === "workspace:file" && args.filePath === path).length

async function select(name: string) {
  await userEvent.click(screen.getByRole("treeitem", { name }))
}

const viewer = (name: string) => screen.getByTestId(`code-file-${name}`)

describe("RepositoryFileBrowser: keeping All files fresh", () => {
  it("shows a second edit to a file that is already changed", async () => {
    const { rerender } = render(ui())
    await select("main.tf")
    await waitFor(() => expect(viewer("main.tf")).toHaveTextContent("v0"))

    editOnDisk(rerender, { "/repo/main.tf": "v1" }, [modified("main.tf", "v1")])
    await waitFor(() => expect(viewer("main.tf")).toHaveTextContent("v1"))

    // Same path set as before; only the file's content moved on.
    editOnDisk(rerender, { "/repo/main.tf": "v2" }, [modified("main.tf", "v2")])
    await waitFor(() => expect(viewer("main.tf")).toHaveTextContent("v2"))
  })

  it("refetches the selected file when a revert drops it from the change list", async () => {
    disk["/repo/main.tf"] = "v1"
    poll.changes = [modified("main.tf", "v1")]
    const { rerender } = render(ui())
    await select("main.tf")
    await waitFor(() => expect(viewer("main.tf")).toHaveTextContent("v1"))

    editOnDisk(rerender, { "/repo/main.tf": "v0" }, [])
    await waitFor(() => expect(viewer("main.tf")).toHaveTextContent("v0"))
  })

  it("does not serve another changed file from the cache after it changes again", async () => {
    disk["/repo/other.tf"] = "o1"
    poll.changes = [modified("main.tf", "v0"), modified("other.tf", "o1")]
    const { rerender } = render(ui())
    await select("other.tf")
    await waitFor(() => expect(viewer("other.tf")).toHaveTextContent("o1"))
    await select("main.tf")
    await waitFor(() => expect(viewer("main.tf")).toHaveTextContent("v0"))

    editOnDisk(rerender, { "/repo/other.tf": "o2" }, [modified("main.tf", "v0"), modified("other.tf", "o2")])
    await select("other.tf")
    await waitFor(() => expect(viewer("other.tf")).toHaveTextContent("o2"))
  })

  it("fetches a clicked file once, and leaves an unchanged selection alone on a poll", async () => {
    poll.changes = [modified("main.tf", "v0")]
    const { rerender } = render(ui())
    await select("main.tf")
    await waitFor(() => expect(viewer("main.tf")).toHaveTextContent("v0"))
    expect(fileFetches("/repo/main.tf")).toBe(1)

    await select("other.tf")
    await waitFor(() => expect(viewer("other.tf")).toHaveTextContent("o0"))
    // A poll that only touches main.tf has no reason to re-read other.tf.
    editOnDisk(rerender, { "/repo/main.tf": "v1" }, [modified("main.tf", "v1")])
    await act(async () => {})
    expect(fileFetches("/repo/other.tf")).toBe(1)
  })
})

describe("RepositoryFileBrowser: file header", () => {
  it("names a nested file by its basename when the path uses Windows separators", async () => {
    render(ui())
    await select("modules")
    await select("vpc.tf")
    await waitFor(() => expect(viewer("modules\\vpc.tf")).toHaveTextContent("cidr"))
    expect(within(viewer("modules\\vpc.tf")).getByText("vpc.tf")).toBeInTheDocument()
  })
})
