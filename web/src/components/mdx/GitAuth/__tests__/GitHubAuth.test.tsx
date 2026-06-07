import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

// The legacy <GitHubAuth> wrapper renders the generic <GitAuth>, which drives
// the shared useGitAuth hook. Mock the hook to a stable, authenticated-pending
// shape so this test focuses on the wrapper's backward-compatible rendering.
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

// Mock sub-components to avoid deep dependency chains in jsdom
vi.mock("../components/AuthTabs", () => ({
  AuthTabs: ({ activeTab }: { activeTab: string }) => <div data-testid="auth-tabs">Tabs: {activeTab}</div>,
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
vi.mock("../components/CustomOAuthWarning", () => ({
  CustomOAuthWarning: () => <div>Custom OAuth Warning</div>,
}))
vi.mock("../components/GitHubLogo", () => ({
  GitHubLogo: () => <div>GitHub Logo</div>,
}))

import { GitHubAuth } from "../../GitHubAuth"

function renderGitHubAuth(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitHubAuth id="test-gh" {...props} />
    </TestWrapper>,
  )
}

describe("GitHubAuth (backward-compat alias)", () => {
  it("renders with the legacy default title", () => {
    renderGitHubAuth()
    expect(screen.getByTestId("test-gh")).toBeInTheDocument()
    expect(screen.getByText("GitHub Authentication")).toBeInTheDocument()
  })

  it("renders custom title", () => {
    renderGitHubAuth({ title: "Connect to GitHub" })
    expect(screen.getByText("Connect to GitHub")).toBeInTheDocument()
  })

  it("renders description", () => {
    renderGitHubAuth({ description: "Sign in with GitHub" })
    expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument()
  })

  it("is GitHub-locked: never shows the provider picker", () => {
    renderGitHubAuth()
    // hideProviderSelect is forced, so the GitHub/GitLab picker is absent.
    expect(screen.queryByRole("tablist", { name: "Git provider" })).toBeNull()
    expect(screen.queryByText("GitLab")).toBeNull()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <GitHubAuth id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("has no error banners with valid props", () => {
    renderGitHubAuth()
    const block = screen.getByTestId("test-gh")
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
  })
})
