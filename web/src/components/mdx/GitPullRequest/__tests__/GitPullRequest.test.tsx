import { describe, it, expect, vi } from "vitest"
import { useEffect } from "react"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { useRunbookContext } from "@/contexts/useRunbook"

vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    activeWorkTree: null,
    workTrees: [],
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
  }),
}))

vi.mock("@/hooks/useGitFileChanges", () => ({
  useGitFileChanges: () => ({ changes: [], isLoading: false, error: null, refetch: vi.fn() }),
}))

// Keep the heavy form/result out of these structural tests.
vi.mock("../components/PRForm", () => ({
  PRForm: () => <div data-testid="pr-form">form</div>,
}))
vi.mock("../components/PRResult", () => ({
  PRResultDisplay: () => <div>result</div>,
}))

import GitPullRequest from "../GitPullRequest"

function Seed({ id, values }: { id: string; values: Record<string, string> }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs(id, values)
  }, [id, values, registerOutputs])
  return null
}

describe("GitPullRequest (generic block)", () => {
  it("interpolates __registryType into the missing-id validation message", () => {
    render(
      <TestWrapper>
        <GitPullRequest id="" __registryType="GitLabMergeRequest" />
      </TestWrapper>,
    )
    expect(screen.getByText(/The <GitLabMergeRequest> component requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("derives the GitLab provider from a linked auth block's GIT_PROVIDER output (unlocked block)", async () => {
    render(
      <TestWrapper>
        <Seed id="auth" values={{ GIT_PROVIDER: "gitlab", GITLAB_TOKEN: "tok" }} />
        <GitPullRequest id="pr" gitAuthId="auth" />
      </TestWrapper>,
    )
    // Provider swapped to GitLab -> Merge Request terminology, no wrong-provider.
    expect(await screen.findByText(/Create Merge Request/)).toBeInTheDocument()
    expect(screen.queryByText("Wrong authentication provider")).toBeNull()
  })

  it("flags a github-locked block linked to a GitLab auth block (inverse direction)", async () => {
    render(
      <TestWrapper>
        <Seed id="auth" values={{ GIT_PROVIDER: "gitlab", GITLAB_TOKEN: "tok" }} />
        <GitPullRequest id="pr" provider="github" gitAuthId="auth" />
      </TestWrapper>,
    )
    expect(await screen.findByText("Wrong authentication provider")).toBeInTheDocument()
    const block = screen.getByTestId("pr")
    expect(block.textContent).toContain("linked to a GitLab authentication block")
    expect(block.textContent).toContain("can only be used with a GitHub auth block")
  })

  it("does not flag wrong-provider when no auth block is linked", () => {
    render(
      <TestWrapper>
        <GitPullRequest id="pr" provider="gitlab" />
      </TestWrapper>,
    )
    expect(screen.queryByText("Wrong authentication provider")).toBeNull()
  })

  it("does not flag wrong-provider for an __AUTHENTICATED-only auth block (provider not derivable)", async () => {
    render(
      <TestWrapper>
        <Seed id="auth" values={{ __AUTHENTICATED: "true" }} />
        <GitPullRequest id="pr" provider="gitlab" gitAuthId="auth" />
      </TestWrapper>,
    )
    // Let the seeded outputs flush, then confirm no false positive.
    expect(await screen.findByTestId("pr")).toBeInTheDocument()
    expect(screen.queryByText("Wrong authentication provider")).toBeNull()
  })
})
