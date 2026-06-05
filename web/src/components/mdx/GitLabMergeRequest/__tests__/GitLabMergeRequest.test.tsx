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

import GitLabMergeRequest from "../GitLabMergeRequest"

/** Registers block outputs so the block can derive a linked auth provider. */
function Seed({ id, values }: { id: string; values: Record<string, string> }) {
  const { registerOutputs } = useRunbookContext()
  useEffect(() => {
    registerOutputs(id, values)
  }, [id, values, registerOutputs])
  return null
}

describe("GitLabMergeRequest (gitlab-locked wrapper)", () => {
  it("renders with Merge Request terminology and the default title", () => {
    render(
      <TestWrapper>
        <GitLabMergeRequest id="mr" />
      </TestWrapper>,
    )
    expect(screen.getByTestId("mr")).toBeInTheDocument()
    // Title heading + form button both read "Create Merge Request".
    expect(screen.getAllByText(/Create Merge Request/).length).toBeGreaterThanOrEqual(1)
  })

  it("shows a blocking wrong-provider error when linked to a GitHub auth block", async () => {
    render(
      <TestWrapper>
        <Seed id="auth" values={{ GIT_PROVIDER: "github", GITHUB_TOKEN: "tok" }} />
        <GitLabMergeRequest id="mr" gitAuthId="auth" />
      </TestWrapper>,
    )
    expect(await screen.findByText("Wrong authentication provider")).toBeInTheDocument()
    // The message text is fragmented across interpolations/elements, so assert
    // on the block's concatenated textContent.
    const block = screen.getByTestId("mr")
    expect(block.textContent).toContain("linked to a GitHub authentication block")
    expect(block.textContent).toContain("can only be used with a GitLab auth block")
  })
})
