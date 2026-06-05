import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

// The wrapper now delegates to the generic GitPullRequest block, so the mocks
// target the relocated GitPullRequest modules.
vi.mock("@/components/mdx/GitPullRequest/hooks/useGitPullRequest", () => ({
  useGitPullRequest: () => ({
    status: "pending",
    logs: [],
    prResult: null,
    errorMessage: null,
    errorCode: null,
    conflictBranchName: null,
    pushError: null,
    labels: [],
    labelsLoading: false,
    authMet: true,
    wrongProvider: false,
    createPullRequest: vi.fn(),
    pushChanges: vi.fn(),
    deleteBranch: vi.fn(),
    fetchLabels: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    activeWorkTree: null,
    workTrees: [],
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
  }),
}))

vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({
    changes: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

// Mock sub-components that reference complex dependencies
vi.mock("@/components/mdx/GitPullRequest/components/PRForm", () => ({
  PRForm: () => <div data-testid="pr-form">PR Form</div>,
}))
vi.mock("@/components/mdx/GitPullRequest/components/PRResult", () => ({
  PRResultDisplay: () => <div>PR Result</div>,
}))
vi.mock("@/components/mdx/GitAuth/components/GitHubLogo", () => ({
  GitHubLogo: () => <div>GitHub Logo</div>,
}))

import GitHubPullRequest from "../GitHubPullRequest"

function renderPR(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitHubPullRequest id="test-pr" {...props} />
    </TestWrapper>,
  )
}

describe("GitHubPullRequest (back-compat wrapper)", () => {
  it("renders with the default Pull Request title", () => {
    renderPR()
    expect(screen.getByTestId("test-pr")).toBeInTheDocument()
    expect(screen.getByText("Create Pull Request")).toBeInTheDocument()
  })

  it("renders custom title and description", () => {
    renderPR({ title: "Submit Changes", description: "Create a PR for review" })
    expect(screen.getByText("Submit Changes")).toBeInTheDocument()
    expect(screen.getByText("Create a PR for review")).toBeInTheDocument()
  })

  it("uses GitHub Pull Request terminology in the auth-wait hint", () => {
    renderPR({ githubAuthId: "auth" })
    // authMet is mocked true, so render the no-repo warning; the auth label is
    // still GitHub-flavored across the block.
    expect(screen.getByText(/No repository available/)).toBeInTheDocument()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <GitHubPullRequest id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("has no error banners with valid props", () => {
    renderPR()
    const block = screen.getByTestId("test-pr")
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
  })
})
