import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"
import { GitClone } from ".."

// A GitClone that sets both gitAuthId and githubAuthId takes its sign-in from
// the gitAuthId block, as the pull request blocks do.
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
  }),
}))

function Seed({ id, values }: { id: string; values: Record<string, string> }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs(id, values)
  }, [id, values, registerOutputs])
  return null
}

function renderWithBoth(signedIn: { id: string; values: Record<string, string> }) {
  return render(
    <ApiProvider api={testApi.api}>
      <TestWrapper>
        <Seed id={signedIn.id} values={signedIn.values} />
        <GitClone id="clone-repo" gitAuthId="git-auth" githubAuthId="gh-auth" />
      </TestWrapper>
    </ApiProvider>,
  )
}

beforeEach(() => {
  testApi = makeTestApi({
    "session:get": () => SESSION,
    "github:orgs": () => [],
    "native:set-theme": () => ({ ok: true }),
  })
})

describe("GitClone with both gitAuthId and githubAuthId", () => {
  it("waits for the gitAuthId block, not the githubAuthId one", async () => {
    renderWithBoth({
      id: "gh-auth",
      values: { __AUTHENTICATED: "true", GIT_PROVIDER: "github" },
    })

    expect(await screen.findByText("Waiting for git authentication")).toBeInTheDocument()
    expect(screen.getByTestId("clone-repo").textContent).toContain(
      "Complete the git-auth authentication block above",
    )
  })

  it("clones with the gitAuthId block's sign-in when the githubAuthId block has none", async () => {
    renderWithBoth({
      id: "git-auth",
      values: {
        __AUTHENTICATED: "true",
        GIT_PROVIDER: "gitlab",
        GITLAB_HOST: "gitlab.example.com",
      },
    })

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("https://gitlab.example.com/group/project.git"),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText("Waiting for git authentication")).toBeNull()
  })
})
