import { describe, it, expect, vi } from "vitest"
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi } from "@/test/test-api"
import { PR_PROVIDERS } from "../providers"

/**
 * Two PR/MR blocks on one page share the git:* event channels. Each event
 * carries the requestId of the operation that sent it, and each block takes
 * only its own operation's events. Only the IPC surface behind useApi() is
 * faked; it sends the events main sends before resolving the invoke.
 */

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    activeWorkTree: {
      id: "wt",
      localPath: "/work/infra",
      gitInfo: {
        repoUrl: "https://example.com/acme/infra.git",
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

const URL_A = "https://example.com/acme/infra/pull/1"

describe.each([PR_PROVIDERS.github, PR_PROVIDERS.gitlab])(
  "two $label blocks on one page",
  (cfg) => {
    it("each show only their own operation's events", async () => {
      const testApi = makeTestApi({
        "github:labels": () => ({ labels: [] }),
        "gitlab:labels": () => ({ labels: [] }),
        "git:commits-ahead": () => ({ count: 0 }),
      })
      const creates = testApi.hold(cfg.channels.create)
      render(
        <TestWrapper>
          <ApiProvider api={testApi.api}>
            <GitPullRequest id="pr-a" provider={cfg.id} prefilledBranchName="runbook/a" />
            <GitPullRequest id="pr-b" provider={cfg.id} prefilledBranchName="runbook/b" />
          </ApiProvider>
        </TestWrapper>,
      )
      const blockA = await screen.findByTestId("pr-a")
      const blockB = screen.getByTestId("pr-b")

      fireEvent.click(within(blockA).getByRole("button", { name: "Submit" }))
      fireEvent.click(within(blockB).getByRole("button", { name: "Submit" }))
      await waitFor(() => expect(creates).toHaveLength(2))
      const [a, b] = creates
      const requestA = { requestId: a!.params.requestId }
      const requestB = { requestId: b!.params.requestId }

      // Both blocks are listening while both operations run.
      act(() => {
        testApi.emit("git:log", {
          line: "A: pushed",
          timestamp: "2026-01-01T00:00:00Z",
          ...requestA,
        })
        testApi.emit("git:log", {
          line: "B: rejected",
          timestamp: "2026-01-01T00:00:00Z",
          ...requestB,
        })
      })
      expect(blockA.textContent).toContain("A: pushed")
      expect(blockA.textContent).not.toContain("B: ")
      expect(blockB.textContent).toContain("B: rejected")
      expect(blockB.textContent).not.toContain("A: ")

      // A opens its PR/MR; B fails.
      await act(async () => {
        testApi.emit("git:pr-result", {
          prUrl: URL_A,
          prNumber: 1,
          branchName: "runbook/a",
          ...requestA,
        })
        testApi.emit("git:outputs", { outputs: { PR_URL: URL_A }, ...requestA })
        testApi.emit("git:status", { status: "success", exitCode: 0, ...requestA })
        testApi.emit("git:error", { message: "B: refused by the remote", ...requestB })
        testApi.emit("git:status", { status: "fail", exitCode: 1, ...requestB })
        a!.resolve({ url: URL_A, number: 1 })
        b!.resolve({ error: "B: refused by the remote" })
      })

      expect(await within(blockA).findByText(`Opened ${URL_A}`)).toBeInTheDocument()
      expect(blockA.textContent).not.toContain("B: ")
      expect(within(blockB).getByText("B: refused by the remote")).toBeInTheDocument()
      expect(blockB.textContent).not.toContain(URL_A)
      // A's outputs, registered under A only
      expect(blockB.textContent).not.toContain("View Outputs")
    })
  },
)
