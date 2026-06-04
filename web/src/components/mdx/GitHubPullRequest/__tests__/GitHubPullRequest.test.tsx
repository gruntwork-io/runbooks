import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

vi.mock("../hooks/useGitHubPullRequest", () => ({
  useGitHubPullRequest: () => ({
    status: "pending",
    prResult: null,
    error: null,
    logs: [],
    handleCreatePR: vi.fn(),
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
vi.mock("../components/PRForm", () => ({
  PRForm: () => <div data-testid="pr-form">PR Form</div>,
}))
vi.mock("../components/PRResult", () => ({
  PRResultDisplay: () => <div>PR Result</div>,
}))
vi.mock("../components/CollapsibleToggle", () => ({
  CollapsibleToggle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

describe("GitHubPullRequest", () => {
  it("renders with default title", () => {
    renderPR()
    expect(screen.getByTestId("test-pr")).toBeInTheDocument()
    expect(screen.getByText("Create Pull Request")).toBeInTheDocument()
  })

  it("renders custom title and description", () => {
    renderPR({ title: "Submit Changes", description: "Create a PR for review" })
    expect(screen.getByText("Submit Changes")).toBeInTheDocument()
    expect(screen.getByText("Create a PR for review")).toBeInTheDocument()
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
