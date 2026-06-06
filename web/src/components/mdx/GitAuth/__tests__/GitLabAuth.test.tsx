import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

// The <GitLabAuth> wrapper renders the generic <GitAuth> locked to GitLab.
// Mock the shared hook to a stable shape so this test focuses on the wrapper's
// GitLab-locked rendering.
vi.mock("../hooks/useGitAuth", () => ({
  useGitAuth: () => ({
    authStatus: "pending",
    authMethod: "pat",
    setAuthMethod: vi.fn(),
    detectionStatus: "done",
    userInfo: null,
    errorMessage: null,
    patToken: "",
    setPatToken: vi.fn(),
    showPatToken: false,
    setShowPatToken: vi.fn(),
    handlePatSubmit: vi.fn(),
    startOAuth: vi.fn(),
    cancelOAuth: vi.fn(),
    resetAuth: vi.fn(),
    resetDetectionState: vi.fn(),
    clearRegisteredOutputs: vi.fn(),
    effectiveClientId: "client-id",
    isCustomClientId: false,
  }),
}))

vi.mock("../components/AuthTabs", () => ({
  AuthTabs: () => null,
}))
vi.mock("../components/AuthSuccess", () => ({
  AuthSuccess: () => <div>Auth Success</div>,
}))
vi.mock("../components/PatForm", () => ({
  PatForm: () => <div>PAT Form</div>,
}))
vi.mock("../components/OAuthFlow", () => ({
  OAuthFlow: () => <div>OAuth Flow</div>,
}))
vi.mock("../components/GitLabLogo", () => ({
  GitLabLogo: () => <div>GitLab Logo</div>,
}))

import { GitLabAuth } from "../../GitLabAuth"

function renderGitLabAuth(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitLabAuth id="test-gl" {...props} />
    </TestWrapper>,
  )
}

describe("GitLabAuth (GitLab-locked alias)", () => {
  it("renders with the GitLab default title", () => {
    renderGitLabAuth()
    expect(screen.getByTestId("test-gl")).toBeInTheDocument()
    expect(screen.getByText("GitLab Authentication")).toBeInTheDocument()
  })

  it("renders custom title", () => {
    renderGitLabAuth({ title: "Connect to GitLab" })
    expect(screen.getByText("Connect to GitLab")).toBeInTheDocument()
  })

  it("renders description", () => {
    renderGitLabAuth({ description: "Sign in to GitLab" })
    expect(screen.getByText("Sign in to GitLab")).toBeInTheDocument()
  })

  it("is GitLab-locked: no provider picker and no GitHub branding", () => {
    renderGitLabAuth()
    expect(screen.queryByRole("tablist", { name: "Git provider" })).toBeNull()
    expect(screen.queryByText("GitHub")).toBeNull()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <GitLabAuth id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("has no error banners with valid props", () => {
    renderGitLabAuth()
    const block = screen.getByTestId("test-gl")
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
  })
})
