/** GitClone's agent adapter: clone and local checkout through the block's own handlers. */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderWithAgent, askAgent, availableActions } from "@/test/agent-harness"

const clone = vi.fn(async () => "success" as const)
const selectLocalRepo = vi.fn(async (dir: string) => ({
  absolutePath: dir,
  remoteUrl: null,
  ref: "main",
}))
let hookState: Record<string, unknown> = {}

vi.mock("../hooks/useGitClone", () => ({
  useGitClone: () => ({
    cloneStatus: "ready",
    cancelling: false,
    logs: [],
    cloneResult: null,
    errorMessage: null,
    restoreError: null,
    refMismatch: false,
    hasGitHubToken: false,
    tokenChecked: true,
    gitHubAuthMet: true,
    githubHost: "github.com",
    workingDir: "/work",
    localPreview: null,
    localPreviewStatus: "idle",
    localPreviewError: null,
    seedStatus: "idle",
    seedError: null,
    clone,
    initDefaultBranch: vi.fn(),
    browseForRepoDir: vi.fn(),
    previewLocalRepo: vi.fn(),
    selectLocalRepo,
    resetLocalPreview: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    checkGitHubToken: vi.fn(),
    fetchOrgs: vi.fn(),
    fetchRepos: vi.fn(),
    fetchRefs: vi.fn(),
    ...hookState,
  }),
}))

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
    activeWorkTree: null,
    workTrees: [],
  }),
}))

import { GitClone } from ".."

beforeEach(() => {
  hookState = {}
  clone.mockClear()
  selectLocalRepo.mockClear()
})

describe("GitClone agent adapter", () => {
  it("clones the URL and ref it is given, through the block's clone", async () => {
    const api = renderWithAgent(<GitClone id="repo" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "repo" })
    expect(availableActions(detail)).toEqual(
      expect.arrayContaining(["clone", "use_local_checkout"]),
    )
    expect(
      await askAgent(api, {
        op: "act_on_block",
        blockId: "repo",
        action: "clone",
        params: { url: "https://github.com/acme/live.git", ref: "main" },
      }),
    ).toMatchObject({ ok: true })
    expect(clone).toHaveBeenCalledWith("https://github.com/acme/live.git", "main", "", "", false)
  })

  it("uses a local checkout instead of cloning", async () => {
    const api = renderWithAgent(<GitClone id="repo" />)
    expect(
      await askAgent(api, {
        op: "act_on_block",
        blockId: "repo",
        action: "use_local_checkout",
        params: { path: "/src/live" },
      }),
    ).toMatchObject({ ok: true })
    expect(selectLocalRepo).toHaveBeenCalledWith("/src/live")
  })

  it("says why it can't clone while its auth block hasn't signed in", async () => {
    hookState = { gitHubAuthMet: false }
    const api = renderWithAgent(<GitClone id="repo" gitAuthId="git" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "repo" })
    expect(detail.blockedBy.join()).toContain('Auth block "git"')
    const refused = await askAgent(api, {
      op: "act_on_block",
      blockId: "repo",
      action: "clone",
      params: { url: "https://github.com/acme/live.git" },
    })
    expect(refused).toMatchObject({ ok: false })
    expect(clone).not.toHaveBeenCalled()
  })

  it("reports the cloned path", async () => {
    hookState = {
      cloneStatus: "success",
      cloneResult: { absolutePath: "/work/live", relativePath: "live", fileCount: 3, ref: "main" },
    }
    const api = renderWithAgent(<GitClone id="repo" />)
    const detail = await askAgent(api, { op: "get_block", blockId: "repo" })
    expect(detail).toMatchObject({
      status: "success",
      state: { path: "/work/live", checkedOutRef: "main" },
    })
    expect(availableActions(detail)).toContain("start_over")
  })
})
