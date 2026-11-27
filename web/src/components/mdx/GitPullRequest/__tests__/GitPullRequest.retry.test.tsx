import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type Handlers, type TestApi } from "@/test/test-api"

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

const PR_URL = "https://github.com/acme/infra/pull/42"
const LOCAL_CONFLICT = "fatal: a branch named 'runbook/1' already exists"

let testApi: TestApi

function renderBlock(handlers: Handlers) {
  testApi = makeTestApi({
    "github:labels": () => ({ labels: [] }),
    "git:commits-ahead": () => ({ count: 0 }),
    ...handlers,
  })

  return render(
    <TestWrapper>
      <ApiProvider api={testApi.api}>
        <GitPullRequest id="pr" provider="github" prefilledBranchName="runbook/1" />
      </ApiProvider>
    </TestWrapper>,
  )
}

/** The create/delete invokes in order, ignoring the form's read-only queries. */
function actionCalls(): string[] {
  return testApi.calls
    .map((call) => call.channel)
    .filter((channel) => channel !== "github:labels" && channel !== "git:commits-ahead")
}

/** Main's answer to a create whose request has `requestId`: a failure. */
function fail(requestId: string, message: string, code?: string) {
  testApi.emit("git:error", {
    message,
    ...(code ? { code, branchName: "runbook/1" } : {}),
    requestId,
  })
  testApi.emit("git:status", { status: "fail", exitCode: 1, requestId })
  return { error: message }
}

/** Main's answer to a create whose request has `requestId`: the PR it opened. */
function succeed(requestId: string) {
  testApi.emit("git:pr-result", { prUrl: PR_URL, prNumber: 42, branchName: "runbook/1", requestId })
  testApi.emit("git:outputs", { outputs: { PR_ID: "42", PR_URL }, requestId })
  testApi.emit("git:status", { status: "success", exitCode: 0, requestId })
  return { url: PR_URL, number: 42 }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GitPullRequest failure recovery", () => {
  it("'Delete branch and retry' deletes the conflicting branch, then creates again", async () => {
    let attempts = 0
    renderBlock({
      "git:pull-request": ({ requestId }) =>
        ++attempts === 1 ? fail(requestId, LOCAL_CONFLICT, "branch_exists") : succeed(requestId),
      "git:delete-branch": () => ({ ok: true }),
    })

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }))
    fireEvent.click(
      await screen.findByRole("button", { name: 'Delete branch "runbook/1" and retry' }),
    )

    expect(await screen.findByText(`Opened ${PR_URL}`)).toBeInTheDocument()
    expect(actionCalls()).toEqual(["git:pull-request", "git:delete-branch", "git:pull-request"])
    expect(testApi.invoke).toHaveBeenCalledWith("git:delete-branch", {
      worktreePath: "/work/infra",
      branch: "runbook/1",
    })
  })

  it("does not retry when the delete is refused", async () => {
    renderBlock({
      "git:pull-request": ({ requestId }) => fail(requestId, LOCAL_CONFLICT, "branch_exists"),
      "git:delete-branch": () => {
        throw new Error("error: the branch 'runbook/1' is not fully merged")
      },
    })

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }))
    fireEvent.click(
      await screen.findByRole("button", { name: 'Delete branch "runbook/1" and retry' }),
    )

    expect(await screen.findByText(/not fully merged/)).toBeInTheDocument()
    expect(actionCalls()).toEqual(["git:pull-request", "git:delete-branch"])
  })

  it("does not offer a local branch delete for a remote 'pull request already exists' conflict", async () => {
    const remoteConflict =
      'Validation Failed: {"message":"A pull request already exists for acme:runbook/1."}'
    // Resolve without a git:error event, so only the invoke's return value can
    // classify the failure.
    renderBlock({ "git:pull-request": () => ({ error: remoteConflict }) })

    fireEvent.click(await screen.findByRole("button", { name: "Submit" }))

    expect(await screen.findByText(remoteConflict)).toBeInTheDocument()
    await waitFor(() => expect(actionCalls()).toEqual(["git:pull-request"]))
    expect(screen.queryByRole("button", { name: /Delete branch/ })).toBeNull()
  })
})
