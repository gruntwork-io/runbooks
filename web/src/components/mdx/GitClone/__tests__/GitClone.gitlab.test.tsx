import { describe, it, expect, vi, beforeEach } from "vitest"
import { useEffect } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { ApiProvider } from "@/contexts/ApiContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { makeTestApi, type Result, type TestApi } from "@/test/test-api"
import { GitClone } from ".."

// The session holds a GitHub token from another block, so github:orgs answers;
// what the block offers depends on the provider of the block it links to.
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

function renderLinkedTo(values: Record<string, string>) {
  return render(
    <ApiProvider api={testApi.api}>
      <TestWrapper>
        <Seed id="git-auth" values={values} />
        <GitClone id="clone-repo" gitAuthId="git-auth" />
      </TestWrapper>
    </ApiProvider>,
  )
}

beforeEach(() => {
  testApi = makeTestApi({
    "session:get": () => SESSION,
    "github:orgs": () => [{ id: 1, login: "octocat" }],
    "native:set-theme": () => ({ ok: true }),
  })
})

describe("GitClone — linked to a GitLab sign-in", () => {
  it("shows a GitLab URL example for the linked instance and no GitHub browser", async () => {
    renderLinkedTo({
      __AUTHENTICATED: "true",
      GIT_PROVIDER: "gitlab",
      GITLAB_HOST: "gitlab.example.com",
    })

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("https://gitlab.example.com/group/project.git"),
      ).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(testApi.invoke).toHaveBeenCalledWith("github:orgs", expect.anything()),
    )
    expect(screen.queryByText("Browse GitHub repositories")).toBeNull()
  })

  it("keeps the GitHub browser and example when linked to a GitHub sign-in", async () => {
    renderLinkedTo({ __AUTHENTICATED: "true", GIT_PROVIDER: "github" })

    expect(await screen.findByText("Browse GitHub repositories")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("https://github.com/org/repo.git")).toBeInTheDocument()
  })
})
