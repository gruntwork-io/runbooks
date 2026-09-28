import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"

/**
 * The failure-recovery path of the real block + real useGitPullRequest hook.
 * Only the IPC surface behind useApi() is faked; the fake emits the same
 * git:* events MAIN sends before resolving the invoke.
 */

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    activeWorkTree: {
      id: "wt",
      localPath: "/work/infra",
      gitInfo: {
        repoUrl: "https://github.com/acme/infra.git",
        repoOwner: "acme",
        repoName: "infra",
        ref: "main",
      },
    },
    workTrees: [],
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
  }),
}))

vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({ changes: [], isLoading: false, error: null, refetch: vi.fn() }),
}))

// The form and result panels are not under test; keep just their actions.
vi.mock("../components/PRForm", () => ({
  PRForm: ({ onSubmit, disabled }: { onSubmit: () => void; disabled: boolean }) => (
    <button type="button" onClick={onSubmit} disabled={disabled}>
      Submit
    </button>
  ),
}))
vi.mock("../components/PRResult", () => ({
  PRResultDisplay: ({ result }: { result: { prUrl: string } }) => <div>Opened {result.prUrl}</div>,
}))

import GitPullRequest from "../GitPullRequest"

type Api = Parameters<typeof ApiProvider>[0]["api"]
type Handler = (args: Record<string, unknown>) => unknown

const PR_URL = "https://github.com/acme/infra/pull/42"
const LOCAL_CONFLICT = "fatal: a branch named 'runbook/1' already exists"

let listeners: Map<string, Set<(data: unknown) => void>>
let invoke: ReturnType<typeof vi.fn>

function emit(channel: string, data: unknown) {
  for (const cb of listeners.get(channel) ?? []) cb(data)
}

function renderBlock(handlers: Record<string, Handler>) {
  listeners = new Map()
  invoke = vi.fn(async (channel: string, args: Record<string, unknown>) =>
    channel in handlers ? handlers[channel](args) : { labels: [] },
  )
  const api = {
    invoke,
    on: (channel: string, cb: (data: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(cb)
      return () => listeners.get(channel)?.delete(cb)
    },
    once: () => {},
  } as unknown as Api

  return render(
    <TestWrapper>
      <ApiProvider api={api}>
        <GitPullRequest id="pr" provider="github" prefilledBranchName="runbook/1" />
      </ApiProvider>
    </TestWrapper>,
  )
}

/** The create/delete invokes in order, ignoring the label fetch. */
function actionCalls(): string[] {
  return invoke.mock.calls
    .map((call) => call[0] as string)
    .filter((channel) => channel !== "github:labels")
}

function fail(message: string, code?: string) {
  emit("git:error", { message, ...(code ? { code, branchName: "runbook/1" } : {}) })
  emit("git:status", { status: "fail", exitCode: 1 })
  return { error: message }
}

function succeed() {
  emit("git:pr-result", { prUrl: PR_URL, prNumber: 42, branchName: "runbook/1" })
  emit("git:outputs", { outputs: { PR_ID: "42", PR_URL } })
  emit("git:status", { status: "success", exitCode: 0 })
  return { url: PR_URL, number: 42 }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GitPullRequest failure recovery", () => {
  it("'Delete branch and retry' deletes the conflicting branch, then creates again", async () => {
    let attempts = 0
    renderBlock({
      "git:pull-request": () => (++attempts === 1 ? fail(LOCAL_CONFLICT, "branch_exists") : succeed()),
      "git:delete-branch": () => ({ ok: true }),
    })

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }))
    fireEvent.click(await screen.findByRole("button", { name: 'Delete branch "runbook/1" and retry' }))

    expect(await screen.findByText(`Opened ${PR_URL}`)).toBeInTheDocument()
    expect(actionCalls()).toEqual(["git:pull-request", "git:delete-branch", "git:pull-request"])
    expect(invoke).toHaveBeenCalledWith("git:delete-branch", { worktreePath: "/work/infra", branch: "runbook/1" })
  })

  it("does not retry when the delete is refused", async () => {
    renderBlock({
      "git:pull-request": () => fail(LOCAL_CONFLICT, "branch_exists"),
      "git:delete-branch": () => {
        throw new Error("error: the branch 'runbook/1' is not fully merged")
      },
    })

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }))
    fireEvent.click(await screen.findByRole("button", { name: 'Delete branch "runbook/1" and retry' }))

    expect(await screen.findByText(/not fully merged/)).toBeInTheDocument()
    expect(actionCalls()).toEqual(["git:pull-request", "git:delete-branch"])
  })

  it("does not offer a local branch delete for a remote 'pull request already exists' conflict", async () => {
    const remoteConflict = 'Validation Failed: {"message":"A pull request already exists for acme:runbook/1."}'
    // Resolve without a git:error event, so only the invoke's return value can
    // classify the failure.
    renderBlock({ "git:pull-request": () => ({ error: remoteConflict }) })

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }))

    expect(await screen.findByText(remoteConflict)).toBeInTheDocument()
    await waitFor(() => expect(actionCalls()).toEqual(["git:pull-request"]))
    expect(screen.queryByRole("button", { name: /Delete branch/ })).toBeNull()
  })
})
