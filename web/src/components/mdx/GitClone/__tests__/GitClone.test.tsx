import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import GitClone from ".."
import { useGitClone } from "../hooks/useGitClone"

// Mock useGitClone hook. A vi.fn lets us assert which auth id the component
// forwards to the hook.
vi.mock("../hooks/useGitClone", () => ({
  useGitClone: vi.fn(() => ({
    status: "idle",
    progress: null,
    cloneResult: null,
    error: null,
    logs: [],
    handleClone: vi.fn(),
    handleCancel: vi.fn(),
  })),
}))

// Mock useGitWorkTree context
vi.mock("@/contexts/useGitWorkTree", () => ({
  useGitWorkTree: () => ({
    registerWorkTree: vi.fn(),
    unregisterWorkTree: vi.fn(),
    activeWorkTree: null,
    workTrees: [],
  }),
}))

function renderGitClone(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitClone id="test-clone" {...props} />
    </TestWrapper>,
  )
}

describe("GitClone", () => {
  beforeEach(() => {
    vi.mocked(useGitClone).mockClear()
  })

  it("renders with default title", () => {
    renderGitClone()
    expect(screen.getByTestId("test-clone")).toBeInTheDocument()
    expect(screen.getByText("Clone Repository")).toBeInTheDocument()
  })

  it("renders custom title", () => {
    renderGitClone({ title: "Clone My Repo" })
    expect(screen.getByText("Clone My Repo")).toBeInTheDocument()
  })

  it("renders description", () => {
    renderGitClone({ description: "Clone the infrastructure repo" })
    expect(screen.getByText("Clone the infrastructure repo")).toBeInTheDocument()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <GitClone id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("has no error banners with valid props", () => {
    renderGitClone()
    const block = screen.getByTestId("test-clone")
    expect(block.querySelector(".bg-destructive-muted")).toBeNull()
  })

  it("forwards githubAuthId to the hook", () => {
    renderGitClone({ githubAuthId: "gh-auth" })
    expect(useGitClone).toHaveBeenCalledWith({ id: "test-clone", githubAuthId: "gh-auth" })
  })
})
